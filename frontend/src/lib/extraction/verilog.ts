/**
 * Verilog code generation. `DieNetlist` (+ the per-cell `CellExtraction`s it
 * references) → a Verilog source string.
 *
 * We build a small AST first, transform it, then print — string surgery is
 * avoided so passes like simplification and inlining stay easy to reason about.
 *
 *   1. trivial cells (combinational, single output, no state) become an
 *      `assign` whose RHS is a `VExpr`;
 *   2. those expressions are simplified (drop double-negation, fold constants,
 *      collapse redundant terms);
 *   3. assignments are inlined into each other recursively, so a chain of
 *      trivial cells folds into one expression;
 *   4. `pruneUnusedWires` drops wires/assigns left dangling after inlining.
 *      Top-level ports (modelled from die I/O) are keep-alive, so their
 *      assigns are never removed;
 *   5. non-trivial cell types are emitted as their own modules; placeholder
 *      cells become black-box module stubs to fill in by hand.
 *
 * NOTE: the AST + transforms are complete and unit-testable. End-to-end
 * `generateVerilog` only produces meaningful output once `extractCell` and the
 * hitbox→net matching are implemented.
 */

import type { BoolExpr, CellExtraction } from "./cell";
import { isTrivialCell } from "./cell";
import type { DieNetlist, NetlistCellInstance, WireIoRole } from "./netlist";

// ── Expression AST ────────────────────────────────────────────────
//
// Mirrors `BoolExpr`, but leaves are identifier names (wires/ports) instead of
// cell-internal net ids. `lowerExpr` bridges the two.

export type VExpr =
  | { kind: "const"; value: 0 | 1 }
  | { kind: "ref"; name: string }
  | { kind: "not"; arg: VExpr }
  | { kind: "and"; args: VExpr[] }
  | { kind: "or"; args: VExpr[] };

const C0: VExpr = { kind: "const", value: 0 };
const C1: VExpr = { kind: "const", value: 1 };

/** Lower a cell-level `BoolExpr` (net-id leaves) to a `VExpr` (named leaves). */
export function lowerExpr(
  expr: BoolExpr,
  resolveNet: (netId: number) => VExpr,
): VExpr {
  switch (expr.kind) {
    case "const":
      return { kind: "const", value: expr.value };
    case "net":
      return resolveNet(expr.net);
    case "not":
      return { kind: "not", arg: lowerExpr(expr.arg, resolveNet) };
    case "and":
      return { kind: "and", args: expr.args.map((a) => lowerExpr(a, resolveNet)) };
    case "or":
      return { kind: "or", args: expr.args.map((a) => lowerExpr(a, resolveNet)) };
  }
}

// ── Canonical key (structural identity) ───────────────────────────

/** Order-independent structural key — equal keys ⇒ equivalent expressions. */
function exprKey(e: VExpr): string {
  switch (e.kind) {
    case "const":
      return `c${e.value}`;
    case "ref":
      return `r:${e.name}`;
    case "not":
      return `!(${exprKey(e.arg)})`;
    case "and":
      return `&(${e.args.map(exprKey).sort().join("|")})`;
    case "or":
      return `|(${e.args.map(exprKey).sort().join("|")})`;
  }
}

function negate(e: VExpr): VExpr {
  return e.kind === "not" ? e.arg : { kind: "not", arg: e };
}

// ── Simplification ────────────────────────────────────────────────

/**
 * Bottom-up Boolean simplification: constant folding, double-negation removal,
 * flattening of nested and/or, idempotence (`x & x → x`), and complementation
 * (`x & ~x → 0`, `x | ~x → 1`).
 */
export function simplifyExpr(e: VExpr): VExpr {
  switch (e.kind) {
    case "const":
    case "ref":
      return e;

    case "not": {
      const a = simplifyExpr(e.arg);
      if (a.kind === "not") return a.arg;
      if (a.kind === "const") return a.value ? C0 : C1;
      return { kind: "not", arg: a };
    }

    case "and":
    case "or": {
      const isAnd = e.kind === "and";
      const annihilator = isAnd ? 0 : 1; // 0 kills an AND, 1 kills an OR
      const identity = isAnd ? 1 : 0; // 1 drops out of AND, 0 out of OR

      // Simplify children and flatten same-kind nesting.
      let args: VExpr[] = [];
      for (const child of e.args) {
        const s = simplifyExpr(child);
        if (s.kind === e.kind) args.push(...s.args);
        else args.push(s);
      }

      if (args.some((a) => a.kind === "const" && a.value === annihilator)) {
        return annihilator ? C1 : C0;
      }
      args = args.filter(
        (a) => !(a.kind === "const" && a.value === identity),
      );

      // Idempotence: dedupe structurally-equal terms.
      const seen = new Set<string>();
      const unique: VExpr[] = [];
      for (const a of args) {
        const k = exprKey(a);
        if (seen.has(k)) continue;
        seen.add(k);
        unique.push(a);
      }

      // Complementation: a term and its negation collapse the whole node.
      for (const a of unique) {
        if (seen.has(exprKey(negate(a)))) return annihilator ? C1 : C0;
      }

      if (unique.length === 0) return identity ? C1 : C0;
      if (unique.length === 1) return unique[0];
      unique.sort((x, y) => exprKey(x).localeCompare(exprKey(y)));
      return { kind: e.kind, args: unique };
    }
  }
}

// ── Printing ──────────────────────────────────────────────────────

// Higher binds tighter. A child is parenthesised only when its precedence is
// lower than its parent's — that gives minimal bracketing.
const PREC = { atom: 4, not: 3, and: 2, or: 1 } as const;

function printExpr(e: VExpr, parentPrec: number): string {
  let prec: number;
  let text: string;
  switch (e.kind) {
    case "const":
      prec = PREC.atom;
      text = e.value ? "1'b1" : "1'b0";
      break;
    case "ref":
      prec = PREC.atom;
      text = e.name;
      break;
    case "not":
      prec = PREC.not;
      text = `~${printExpr(e.arg, PREC.not)}`;
      break;
    case "and":
      prec = PREC.and;
      text = e.args.map((a) => printExpr(a, PREC.and)).join(" & ");
      break;
    case "or":
      prec = PREC.or;
      text = e.args.map((a) => printExpr(a, PREC.or)).join(" | ");
      break;
  }
  return prec < parentPrec ? `(${text})` : text;
}

/** Render an expression AST as a Verilog expression string. */
export function formatExpr(e: VExpr): string {
  return printExpr(e, 0);
}

// ── Module AST ────────────────────────────────────────────────────

export interface VPort {
  name: string;
  direction: "input" | "output" | "inout";
}

export type VStatement =
  | { kind: "wire"; name: string }
  | { kind: "assign"; lhs: string; rhs: VExpr }
  | {
      kind: "instance";
      moduleName: string;
      instanceName: string;
      connections: { port: string; net: string }[];
    }
  | { kind: "comment"; text: string };

export interface VModule {
  name: string;
  ports: VPort[];
  statements: VStatement[];
}

export interface VerilogDesign {
  /** One module per non-trivial / placeholder cell type. */
  cellModules: VModule[];
  /** The chip top-level module. */
  topModule: VModule;
}

// ── Identifier hygiene ────────────────────────────────────────────

function sanitize(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(s) ? `_${s}` : s || "_";
}

// ── AST passes ────────────────────────────────────────────────────

/** Collect every wire name an expression references. */
function refsOf(e: VExpr, out: Set<string>): void {
  switch (e.kind) {
    case "ref":
      out.add(e.name);
      break;
    case "not":
      refsOf(e.arg, out);
      break;
    case "and":
    case "or":
      for (const a of e.args) refsOf(a, out);
      break;
    case "const":
      break;
  }
}

/** Substitute `ref(name)` → `repl` everywhere in an expression. */
function substitute(e: VExpr, name: string, repl: VExpr): VExpr {
  switch (e.kind) {
    case "const":
      return e;
    case "ref":
      return e.name === name ? repl : e;
    case "not":
      return { kind: "not", arg: substitute(e.arg, name, repl) };
    case "and":
      return { kind: "and", args: e.args.map((a) => substitute(a, name, repl)) };
    case "or":
      return { kind: "or", args: e.args.map((a) => substitute(a, name, repl)) };
  }
}

/**
 * Recursively inline `assign`-driven wires into other assignments. A chain of
 * trivial cells (each an `assign`) folds into a single expression. Cycle-safe;
 * each result is re-simplified. The `assign` statements themselves are kept —
 * `pruneUnusedWires` is what would later remove the now-dangling ones.
 */
export function inlineAssigns(module: VModule): VModule {
  const rhsByLhs = new Map<string, VExpr>();
  for (const s of module.statements) {
    if (s.kind === "assign") rhsByLhs.set(s.lhs, s.rhs);
  }

  const expand = (e: VExpr, visiting: Set<string>): VExpr => {
    const refs = new Set<string>();
    refsOf(e, refs);
    let result = e;
    for (const name of refs) {
      if (visiting.has(name)) continue; // cycle guard
      const driver = rhsByLhs.get(name);
      if (!driver) continue;
      const inlined = expand(driver, new Set(visiting).add(name));
      result = substitute(result, name, inlined);
    }
    return result;
  };

  return {
    ...module,
    statements: module.statements.map((s) =>
      s.kind === "assign"
        ? { ...s, rhs: simplifyExpr(expand(s.rhs, new Set([s.lhs]))) }
        : s,
    ),
  };
}

/**
 * Remove wire declarations and assignments whose target is never referenced.
 *
 * Module ports are always kept alive (an output port's assign must survive
 * even when nothing else reads it; an input port stays declared even when
 * unused). `keepAlive` is an extra escape hatch for names that must never be
 * pruned. Opt-in via `enabled` so callers that want the raw, un-pruned module
 * (e.g. for debugging) can still get it.
 */
export function pruneUnusedWires(
  module: VModule,
  options: { enabled: boolean; keepAlive?: Set<string> } = { enabled: false },
): VModule {
  if (!options.enabled) return module;

  const used = new Set<string>(options.keepAlive ?? []);
  for (const p of module.ports) used.add(p.name);
  for (const s of module.statements) {
    if (s.kind === "assign") refsOf(s.rhs, used);
    else if (s.kind === "instance") {
      for (const c of s.connections) used.add(c.net);
    }
  }
  return {
    ...module,
    statements: module.statements.filter((s) => {
      if (s.kind === "wire") return used.has(s.name);
      if (s.kind === "assign") return used.has(s.lhs);
      return true;
    }),
  };
}

// ── Netlist → AST ─────────────────────────────────────────────────

/** RHS expression for a trivial cell instance, in terms of die-wire names. */
function trivialCellExpr(
  extraction: Extract<CellExtraction, { kind: "inferred" }>,
  instance: NetlistCellInstance,
  wireName: (wireId: string) => string,
): VExpr {
  const portByNet = new Map<number, string>(); // netId → port name
  for (const p of extraction.ports) {
    if (p.netId != null) portByNet.set(p.netId, p.name);
  }
  const netRole = new Map(extraction.nets.map((n) => [n.id, n.role]));

  const resolve = (netId: number): VExpr => {
    const portName = portByNet.get(netId);
    if (portName != null) {
      const wireId = instance.portToWire.get(portName);
      return { kind: "ref", name: wireId ? wireName(wireId) : `unconn_${portName}` };
    }
    const role = netRole.get(netId);
    if (role === "vcc") return C1;
    if (role === "gnd") return C0;
    return { kind: "ref", name: `net${netId}` }; // unresolved internal net
  };

  return simplifyExpr(lowerExpr(extraction.logic!, resolve));
}

/** Map a die wire's inferred I/O role to a top-level port direction. */
function directionFromIoRole(role: WireIoRole): VPort["direction"] {
  switch (role) {
    case "io_input":
      return "input";
    case "io_output":
    case "io_control":
      return "output";
    case "io_bidir":
    case "io_unknown":
      return "inout";
  }
}

/** Port list of a cell type, for emitting/instantiating its module. */
function modulePorts(extraction: CellExtraction): VPort[] {
  return extraction.ports.map((p) => ({
    name: sanitize(p.name),
    direction: p.direction === "output" || p.direction === "inout"
      ? p.direction
      : "input", // "unknown" defaults to input
  }));
}

/** Build the Verilog AST for an entire die netlist. */
export function inferVerilogAST(netlist: DieNetlist): VerilogDesign {
  const wireNameById = new Map(
    netlist.wires.map((w) => [w.id, sanitize(w.name)]),
  );
  const wireName = (id: string) => wireNameById.get(id) ?? sanitize(id);

  // Top-level ports: every wire the netlister tagged with an I/O role. These
  // are declared in the module header, so they must NOT also be redeclared as
  // internal `wire`s below.
  const topPorts: VPort[] = [];
  const portNames = new Set<string>();
  for (const w of netlist.wires) {
    if (!w.ioRole) continue;
    const name = wireName(w.id);
    if (portNames.has(name)) continue; // a name can only be declared once
    portNames.add(name);
    topPorts.push({ name, direction: directionFromIoRole(w.ioRole) });
  }

  const statements: VStatement[] = [];
  for (const w of netlist.wires) {
    const name = wireName(w.id);
    if (portNames.has(name)) continue; // declared as a port already
    statements.push({ kind: "wire", name });
  }

  // Cell-type modules: emit one per non-trivial type that is actually used.
  // Each cell TYPE gets its own module, named after the type (uniquified so
  // two types that share a name — or sanitize to the same identifier — don't
  // collapse into one). Keyed by cellTypeId so dedup is by type, not by name.
  const cellModules: VModule[] = [];
  const emittedTypes = new Set<string>(); // cellTypeIds with a module emitted
  const moduleNameByType = new Map<string, string>(); // cellTypeId → module name
  const usedModuleNames = new Set<string>();
  const moduleNameFor = (extraction: CellExtraction): string => {
    const existing = moduleNameByType.get(extraction.cellTypeId);
    if (existing) return existing;
    const base =
      sanitize(
        extraction.kind === "placeholder"
          ? extraction.cellName
          : extraction.cellTypeName,
      ) || "cell";
    let name = base;
    for (let i = 2; usedModuleNames.has(name); i++) name = `${base}_${i}`;
    usedModuleNames.add(name);
    moduleNameByType.set(extraction.cellTypeId, name);
    return name;
  };

  // Per-type instance counters → readable, unique names (e.g. DFF_0, DFF_1).
  const instanceCounts = new Map<string, number>();
  for (const inst of netlist.cellInstances) {
    const extraction = netlist.extractions.get(inst.cellTypeId);
    if (!extraction) {
      statements.push({
        kind: "comment",
        text: `instance ${inst.id}: no extraction available`,
      });
      continue;
    }

    if (isTrivialCell(extraction)) {
      const outPort = extraction.ports.find((p) => p.direction === "output")!;
      const outWireId = inst.portToWire.get(outPort.name);
      if (!outWireId) {
        statements.push({
          kind: "comment",
          text: `instance ${inst.id}: output "${outPort.name}" not connected`,
        });
        continue;
      }
      statements.push({
        kind: "assign",
        lhs: wireName(outWireId),
        rhs: trivialCellExpr(extraction, inst, wireName),
      });
      continue;
    }

    // Non-trivial: instantiate a module (one definition per cell type).
    const modName = moduleNameFor(extraction);
    if (!emittedTypes.has(extraction.cellTypeId)) {
      emittedTypes.add(extraction.cellTypeId);
      cellModules.push({
        name: modName,
        ports: modulePorts(extraction),
        statements: [
          {
            kind: "comment",
            text:
              extraction.kind === "placeholder"
                ? "TODO: implement this cell by hand"
                : "TODO: structural body not yet generated",
          },
        ],
      });
    }
    const instIndex = instanceCounts.get(modName) ?? 0;
    instanceCounts.set(modName, instIndex + 1);
    statements.push({
      kind: "instance",
      moduleName: modName,
      instanceName: `${modName}_${instIndex}`,
      connections: extraction.ports.flatMap((p) => {
        const wireId = inst.portToWire.get(p.name);
        return wireId
          ? [{ port: sanitize(p.name), net: wireName(wireId) }]
          : [];
      }),
    });
  }

  return {
    cellModules,
    topModule: {
      name: sanitize(netlist.moduleName),
      ports: topPorts,
      statements,
    },
  };
}

// ── Printing the design ───────────────────────────────────────────

function emitModule(m: VModule): string {
  const lines: string[] = [];
  if (m.ports.length === 0) {
    lines.push(`module ${m.name} ();`);
  } else {
    lines.push(`module ${m.name} (`);
    m.ports.forEach((p, i) => {
      const sep = i < m.ports.length - 1 ? "," : "";
      lines.push(`  ${p.direction} ${p.name}${sep}`);
    });
    lines.push(`);`);
  }
  for (const s of m.statements) {
    switch (s.kind) {
      case "wire":
        lines.push(`  wire ${s.name};`);
        break;
      case "assign":
        lines.push(`  assign ${s.lhs} = ${formatExpr(s.rhs)};`);
        break;
      case "comment":
        lines.push(`  // ${s.text}`);
        break;
      case "instance": {
        lines.push(`  ${s.moduleName} ${s.instanceName} (`);
        s.connections.forEach((c, i) => {
          const sep = i < s.connections.length - 1 ? "," : "";
          lines.push(`    .${c.port}(${c.net})${sep}`);
        });
        lines.push(`  );`);
        break;
      }
    }
  }
  lines.push(`endmodule`);
  return lines.join("\n");
}

/** Generate the full Verilog source for a die netlist. */
export function generateVerilog(netlist: DieNetlist): string {
  const design = inferVerilogAST(netlist);
  // Fold trivial-cell expression chains together, then drop the wires/assigns
  // left dangling by that inlining. Pruning is safe now that top-level ports
  // are modelled (they're keep-alive inside `pruneUnusedWires`).
  const top = pruneUnusedWires(inlineAssigns(design.topModule), {
    enabled: true,
  });

  const parts: string[] = [];
  if (netlist.warnings.length > 0) {
    parts.push(
      netlist.warnings.map((w) => `// warning: ${w}`).join("\n"),
    );
  }
  for (const m of design.cellModules) parts.push(emitModule(m));
  parts.push(emitModule(top));
  return parts.join("\n\n") + "\n";
}
