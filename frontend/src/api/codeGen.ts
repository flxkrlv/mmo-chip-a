/**
 * Die → Verilog source generation, with line-index metadata for the Code page.
 *
 * The flow:
 *   1. `loadClipper()` (idempotent — extraction needs the WASM polygon engine).
 *   2. Per cell type, attempt `extractCell(layers)`. Successful results land in
 *      a `Map` consumed by `inferDieNetlist`. Failures become problems.
 *   3. `inferDieNetlist` builds the structural connectivity; `inferVerilogAST`
 *      turns it into a `VerilogDesign`; `inlineAssigns` folds chains.
 *   4. We re-print the design here (instead of calling `generateVerilog`) so
 *      we can record the file line each statement / module / problem lands on
 *      — the Code page's outline and Problems list need those for jump-to-line.
 */

import { useEffect, useMemo, useState } from "react";
import type { DieAnnotations } from "shared";
import {
  extractCell,
  formatExpr,
  inferDieNetlist,
  inferVerilogAST,
  inlineAssigns,
  loadClipper,
  pruneUnusedWires,
} from "../lib/extraction";
import type {
  CellExtraction,
  DieNetlist,
  ExtractionWarning,
  VModule,
  VStatement,
  VerilogDesign,
} from "../lib/extraction";

// ── Public shapes ─────────────────────────────────────────────────

export type ProblemSeverity = "err" | "warn";

export interface CodeProblem {
  id: string;
  severity: ProblemSeverity;
  /** Short tag rendered in the second column (e.g. "extract", "netlist"). */
  source: string;
  /** Target text in the third column ("cell.0.1", "net_a3", …). */
  target?: string;
  message: string;
  /** 1-based source line, when we can attribute the problem to one. */
  line?: number;
}

export type OutlineGroupKind = "cellTypes" | "assigns" | "instances";

export interface OutlineLeaf {
  id: string;
  label: string;
  meta?: string;
  line: number;
}

export interface OutlineGroup {
  kind: OutlineGroupKind;
  title: string;
  leaves: OutlineLeaf[];
}

export interface DieCode {
  source: string;
  moduleName: string;
  fileName: string;
  outline: OutlineGroup[];
  problems: CodeProblem[];
  /** Aggregate counts for the status / sub-bar. */
  counts: {
    wires: number;
    assigns: number;
    instances: number;
    cellTypes: number;
    problems: number;
  };
}

// ── Bookkeeping carried through the printer ───────────────────────

interface PrintAccum {
  lines: string[];
  cellModuleLines: Map<string, number>;
  /** Statement index in the top module → 1-based line. */
  topStmtLines: Map<number, number>;
  /** Pre-rendered problem comment index → 1-based line. */
  problemCommentLines: Map<number, number>;
}

function fileNameFor(moduleName: string): string {
  // Verilog conventional one-module-per-file naming.
  return `${moduleName || "die"}.v`;
}

// ── Extraction step (per cell type) ───────────────────────────────

interface ExtractionPass {
  extractions: Map<string, CellExtraction>;
  problems: CodeProblem[];
}

function runExtractions(annotations: DieAnnotations): ExtractionPass {
  const extractions = new Map<string, CellExtraction>();
  const problems: CodeProblem[] = [];

  for (const ct of annotations.cellTypes) {
    try {
      const ex = extractCell(ct);
      extractions.set(ct.id, ex);
      // Surface extractor-reported warnings (already typed).
      for (const w of ex.warnings) {
        problems.push(extractionWarningToProblem(ct.name, w));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      problems.push({
        id: `ext:${ct.id}`,
        severity: "err",
        source: "extract",
        target: ct.name,
        message: msg,
      });
    }
  }
  return { extractions, problems };
}

function extractionWarningToProblem(
  cellName: string,
  w: ExtractionWarning,
): CodeProblem {
  // `severity` is now part of the warning itself (the extractor decides
  // whether a code is an error or just informational). We only need to fold
  // the extractor's "info" tier into our two-bucket "err / warn" UI: keep
  // info as a low-key "warn" so it stays visible without screaming.
  const severity: CodeProblem["severity"] = w.severity === "error" ? "err" : "warn";
  return {
    id: `ext:${cellName}:${w.code}:${w.message.slice(0, 24)}`,
    severity,
    source: "extract",
    target: cellName,
    message: `${w.code}: ${w.message}`,
  };
}

// ── Custom printer (mirrors generateVerilog) ──────────────────────
//
// `generateVerilog` exists, but it returns a flat string. We need to know
// which file line each outline node / problem maps to, so the Code page can
// scroll to it. So we re-implement the print step here (the cellModules and
// the inlined top module are the same data — we just walk them ourselves).

function formatStatement(s: VStatement): string[] {
  switch (s.kind) {
    case "wire":
      return [`  wire ${s.name};`];
    case "assign":
      return [`  assign ${s.lhs} = ${formatExpr(s.rhs)};`];
    case "comment":
      return [`  // ${s.text}`];
    case "instance": {
      const lines = [`  ${s.moduleName} ${s.instanceName} (`];
      s.connections.forEach((c, i) => {
        const sep = i < s.connections.length - 1 ? "," : "";
        lines.push(`    .${c.port}(${c.net})${sep}`);
      });
      lines.push(`  );`);
      return lines;
    }
  }
}

function appendModule(
  acc: PrintAccum,
  m: VModule,
  opts: { topModule?: boolean } = {},
): void {
  if (m.ports.length === 0) {
    acc.lines.push(`module ${m.name} ();`);
  } else {
    acc.lines.push(`module ${m.name} (`);
    m.ports.forEach((p, i) => {
      const sep = i < m.ports.length - 1 ? "," : "";
      acc.lines.push(`  ${p.direction} ${p.name}${sep}`);
    });
    acc.lines.push(`);`);
  }
  m.statements.forEach((s, idx) => {
    const startLine = acc.lines.length + 1;
    for (const line of formatStatement(s)) acc.lines.push(line);
    if (opts.topModule) acc.topStmtLines.set(idx, startLine);
  });
  acc.lines.push(`endmodule`);
}

interface PrintResult {
  source: string;
  cellModuleLines: Map<string, number>;
  topStmtLines: Map<number, number>;
  problemCommentLines: Map<number, number>;
  topModule: VModule;
  design: VerilogDesign;
}

function printDesign(
  design: VerilogDesign,
  problems: CodeProblem[],
  netlistWarnings: string[],
): PrintResult {
  // Inline trivial-cell chains, then prune the wires/assigns left dangling.
  // Mirrors `generateVerilog`; safe now that top-level ports are keep-alive.
  const top = pruneUnusedWires(inlineAssigns(design.topModule), {
    enabled: true,
  });
  const acc: PrintAccum = {
    lines: [],
    cellModuleLines: new Map(),
    topStmtLines: new Map(),
    problemCommentLines: new Map(),
  };

  // 1. Header comment block: timestamp + summary. Mirrors the wireframe.
  acc.lines.push(`// Auto-generated from mmo-chip RE`);
  acc.lines.push(
    `// ${design.topModule.name} · ${design.cellModules.length} cell type${design.cellModules.length === 1 ? "" : "s"}`,
  );
  acc.lines.push(``);

  // 2. Netlist + extractor problems rendered as a leading comment block.
  //    We map problem index → file line so the bottom panel can jump.
  //    `netlistWarnings` come straight from `inferDieNetlist`; we wrap each
  //    one in a synthetic CodeProblem so the panel shows them uniformly.
  const netlistProblems: CodeProblem[] = netlistWarnings.map((w, i) => ({
    id: `nl:${i}`,
    severity: "warn",
    source: "netlist",
    message: w,
  }));
  const allProblems = [...problems, ...netlistProblems];

  if (allProblems.length > 0) {
    acc.lines.push(`// ─── problems (${allProblems.length}) ───`);
    allProblems.forEach((p, idx) => {
      const line = acc.lines.length + 1;
      acc.lines.push(
        `// ${p.severity}: ${p.target ? `${p.target} — ` : ""}${p.message}`,
      );
      acc.problemCommentLines.set(idx, line);
    });
    acc.lines.push(``);
  }

  // 3. Cell-type modules.
  for (const m of design.cellModules) {
    const start = acc.lines.length + 1;
    appendModule(acc, m);
    acc.cellModuleLines.set(m.name, start);
    acc.lines.push(``);
  }

  // 4. Top module — track per-statement lines for the outline.
  appendModule(acc, top, { topModule: true });

  return {
    source: acc.lines.join("\n") + "\n",
    cellModuleLines: acc.cellModuleLines,
    topStmtLines: acc.topStmtLines,
    problemCommentLines: acc.problemCommentLines,
    topModule: top,
    design,
  };
}

// ── Outline assembly ──────────────────────────────────────────────

function buildOutline(
  design: VerilogDesign,
  top: VModule,
  cellModuleLines: Map<string, number>,
  topStmtLines: Map<number, number>,
): OutlineGroup[] {
  const cellTypeGroup: OutlineGroup = {
    kind: "cellTypes",
    title: "cell type defs",
    leaves: design.cellModules.map((m) => ({
      id: `mod:${m.name}`,
      label: m.name,
      meta: `${m.ports.length} ports`,
      line: cellModuleLines.get(m.name) ?? 1,
    })),
  };

  const assignLeaves: OutlineLeaf[] = [];
  const instanceLeaves: OutlineLeaf[] = [];
  top.statements.forEach((s, idx) => {
    const line = topStmtLines.get(idx) ?? 1;
    if (s.kind === "assign") {
      assignLeaves.push({
        id: `asg:${idx}:${s.lhs}`,
        label: s.lhs,
        meta: "assign",
        line,
      });
    } else if (s.kind === "instance") {
      instanceLeaves.push({
        id: `inst:${idx}:${s.instanceName}`,
        label: s.instanceName,
        meta: s.moduleName,
        line,
      });
    }
  });

  return [
    cellTypeGroup,
    { kind: "assigns", title: "combinatorial assigns", leaves: assignLeaves },
    { kind: "instances", title: "cell instances", leaves: instanceLeaves },
  ];
}

// ── Synchronous build entrypoint ──────────────────────────────────

function buildDieCode(
  annotations: DieAnnotations,
  moduleName: string,
): DieCode {
  const { extractions, problems: extractionProblems } =
    runExtractions(annotations);
  const netlist: DieNetlist = inferDieNetlist(
    annotations,
    extractions,
    moduleName,
  );
  const design = inferVerilogAST(netlist);

  const printed = printDesign(design, extractionProblems, netlist.warnings);

  // Backfill the problems with the file lines they ended up on. Order in
  // `printDesign` is: extractionProblems first, then netlistWarnings.
  const netlistProblems: CodeProblem[] = netlist.warnings.map((w, i) => ({
    id: `nl:${i}`,
    severity: "warn",
    source: "netlist",
    message: w,
  }));
  const merged: CodeProblem[] = [...extractionProblems, ...netlistProblems].map(
    (p, i) => ({ ...p, line: printed.problemCommentLines.get(i) }),
  );

  const outline = buildOutline(
    design,
    printed.topModule,
    printed.cellModuleLines,
    printed.topStmtLines,
  );

  const wireCount = printed.topModule.statements.filter(
    (s) => s.kind === "wire",
  ).length;
  const assignCount = printed.topModule.statements.filter(
    (s) => s.kind === "assign",
  ).length;
  const instanceCount = printed.topModule.statements.filter(
    (s) => s.kind === "instance",
  ).length;

  return {
    source: printed.source,
    moduleName,
    fileName: fileNameFor(moduleName),
    outline,
    problems: merged,
    counts: {
      wires: wireCount,
      assigns: assignCount,
      instances: instanceCount,
      cellTypes: design.cellModules.length,
      problems: merged.length,
    },
  };
}

// ── React hook ────────────────────────────────────────────────────
//
// Generation is cheap relative to network — we run it synchronously in a
// `useMemo` keyed on the annotations object. Clipper has to be loaded first
// (it's WASM); until then we surface a `loading` state. We deliberately do
// NOT use React Query: there's no fetch to dedupe, and re-running on every
// annotation tick (cheap pure compute) keeps the page reactive to live edits.

interface UseDieCode {
  data: DieCode | null;
  loading: boolean;
  error: string | null;
}

export function useDieCode(
  annotations: DieAnnotations | undefined,
  moduleName: string,
): UseDieCode {
  const [clipperReady, setClipperReady] = useState<boolean>(false);
  const [clipperError, setClipperError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadClipper()
      .then(() => {
        if (!cancelled) setClipperReady(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setClipperError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const data = useMemo<DieCode | null>(() => {
    if (!annotations || !clipperReady) return null;
    try {
      return buildDieCode(annotations, moduleName);
    } catch (e) {
      // The pipeline itself should never throw given a valid annotations
      // object (extractCell is wrapped). If it does, surface a one-problem
      // skeleton so the page still renders the placeholder header.
      const msg = e instanceof Error ? e.message : String(e);
      return {
        source: `// generation failed: ${msg}\n`,
        moduleName,
        fileName: fileNameFor(moduleName),
        outline: [],
        problems: [
          {
            id: "fatal",
            severity: "err",
            source: "codegen",
            message: msg,
            line: 1,
          },
        ],
        counts: {
          wires: 0,
          assigns: 0,
          instances: 0,
          cellTypes: 0,
          problems: 1,
        },
      };
    }
  }, [annotations, clipperReady, moduleName]);

  return {
    data,
    loading: !clipperReady && !clipperError,
    error: clipperError,
  };
}
