import { promises as fsp } from "node:fs";
import { accessSync } from "node:fs";
import path from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";
import { Router } from "express";
import type { LvsCompareRequest, LvsRawResult, LvsEngine, LvsEngineResult, LvsCombinedResult, VygesEvent } from "shared";
import { normalizeForVyges } from "../lib/normalizeNetlist.js";
import { compareByName } from "../lib/compareByName.js";
import type { NameBasedResult } from "../lib/compareByName.js";

const ALWAYS_GLOBAL = new Set(["0"]);
const POWER_NET_NAMES = new Set(["GND", "VCC", "VDD", "VSS", "VEE", "VBB", "VSUB", "AVDD", "AVSS", "DVDD", "DVSS"]);

function extractGlobals(layout: string, schematic: string): string[] {
  const globals = new Set(ALWAYS_GLOBAL);
  for (const netlist of [layout, schematic]) {
    for (const line of netlist.split("\n")) {
      const trimmed = line.trim();
      if (/^\.?global\s+/i.test(trimmed)) {
        const nets = trimmed.replace(/^global\s+/i, "").trim().split(/\s+/);
        for (const n of nets.filter(Boolean)) globals.add(n);
      }
    }
  }
  const tokens = (layout + "\n" + schematic).split(/[\s(),]+/);
  const tokenSet = new Set(tokens);
  for (const name of POWER_NET_NAMES) {
    if (tokenSet.has(name)) globals.add(name);
  }
  return [...globals];
}

function parseVygesEvents(stderr: string): VygesEvent[] {
  const events: VygesEvent[] = [];
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.schema === "vyges-events/1.0") {
        events.push(parsed);
      }
    } catch { /* not a JSON line */ }
  }
  return events;
}

function resolveLvsCli(): string {
  if (process.env.LVS_CLI_PATH) return process.env.LVS_CLI_PATH;
  const home = homedir();
  const candidates = [
    path.join(home, ".cargo", "bin", "vyges-lvs.exe"),
    path.join(home, ".cargo", "bin", "vyges-lvs"),
    "vyges-lvs",
  ];
  for (const c of candidates) {
    try { accessSync(c); return c; } catch { /* not here */ }
  }
  return "vyges-lvs";
}

const LVS_CLI = resolveLvsCli();
if (process.env.NODE_ENV !== "test") {
  console.log(`[lvs] using CLI: ${LVS_CLI}`);
}
const LVS_TIMEOUT_MS = Number(process.env.LVS_TIMEOUT_MS) || 120_000;

class LvsTimeoutError extends Error {
  constructor() { super("LVS comparison timed out"); this.name = "LvsTimeoutError"; }
}

function runCli(cli: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cli, args, { timeout, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new LvsTimeoutError());
    }, timeout);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`vyges-lvs exited code ${code}: ${stderr.slice(0, 1000)}`));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Engine runners ───────────────────────────────────────────

export async function runVygesLvs(
  layoutNetlist: string,
  schematicNetlist: string,
  dialect?: string,
  moduleName?: string,
): Promise<LvsEngineResult> {
  const ext = dialect === "spectre" ? "scs" : "spice";
  const tmpDir = await fsp.mkdtemp(path.join(tmpdir(), "lvs-"));
  const layoutPath = path.join(tmpDir, `layout.${ext}`);
  const schematicPath = path.join(tmpDir, `schematic.${ext}`);
  const jobPath = path.join(tmpDir, "compare.lvs");

  try {
    const allGlobals = extractGlobals(layoutNetlist, schematicNetlist);
    const layoutNorm = normalizeForVyges(layoutNetlist, moduleName, allGlobals);
    const schematicNorm = normalizeForVyges(schematicNetlist, moduleName, allGlobals);

    // Debug: dump normalized netlists count
    const layoutDevCount = layoutNorm.split("\n").filter(l => /^[A-Za-z_]/.test(l.trim()) && !/^\.(SUBCKT|ENDS|GLOBAL)/i.test(l.trim())).length;
    const schematicDevCount = schematicNorm.split("\n").filter(l => /^[A-Za-z_]/.test(l.trim()) && !/^\.(SUBCKT|ENDS|GLOBAL)/i.test(l.trim())).length;
    if (process.env.NODE_ENV !== "test") {
      console.log(`[lvs] normalized device count: layout=${layoutDevCount} schematic=${schematicDevCount} globals=[${allGlobals.join(",")}]`);
    }

    await fsp.writeFile(layoutPath, layoutNorm, "utf-8");
    await fsp.writeFile(schematicPath, schematicNorm, "utf-8");

    let jobContent = `layout:    ${layoutPath}\nschematic: ${schematicPath}\n`;
    if (moduleName) jobContent += `top:       ${moduleName}\n`;
    await fsp.writeFile(jobPath, jobContent, "utf-8");

    const [jsonResult, textResult] = await Promise.all([
      runCli(LVS_CLI, ["run", jobPath, "--json", "-v"], LVS_TIMEOUT_MS),
      runCli(LVS_CLI, ["run", jobPath, "-v"], LVS_TIMEOUT_MS),
    ]);

    const json = JSON.parse(jsonResult.stdout) as LvsRawResult;
    const firstLine = textResult.stdout.split("\n")[0] ?? "";
    const matched = /\bMATCH\b/.test(firstLine) && !/\bMISMATCH\b/.test(firstLine);

    // Device count check: vyges-lvs collapses parallel/series resistors
    let note = "";
    if (json.a_devices !== layoutDevCount) {
      note = `vyges-lvs sees ${json.a_devices} devices (raw netlist has ${layoutDevCount}). Parallel/series resistors may be collapsed — connection mismatches may be hidden. Use name-based engine for verification.`;
    }

    // Parse vyges-events from stderr (structured JSON events)
    const events = parseVygesEvents(jsonResult.stderr);

    // Append remaining stderr (non-event lines) to note for diagnostics
    const nonEventStderr = jsonResult.stderr.split("\n").filter(l => {
      try { const p = JSON.parse(l.trim()); return p?.schema !== "vyges-events/1.0"; } catch { return true; }
    }).join("\n").trim();
    const textNonEvent = textResult.stderr.split("\n").filter(l => {
      try { const p = JSON.parse(l.trim()); return p?.schema !== "vyges-events/1.0"; } catch { return true; }
    }).join("\n").trim();
    const stderrCombined = [...new Set([nonEventStderr, textNonEvent].filter(Boolean))].join(" | ");
    if (stderrCombined) {
      note = (note ? note + "\n" : "") + `vyges-lvs stderr: ${stderrCombined}`;
    }

    return { engine: "vyges-lvs", matched, json, report: textResult.stdout + (note ? "\n\n" + note : ""), stderr: stderrCombined, events };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function nameBasedToRawResult(nb: NameBasedResult): LvsRawResult {
  // Copy unbalanced as-is (device-only, net-count imbalances)
  const unbalanced = [...nb.unbalanced];

  // Add type/connection mismatches as unbalanced device entries
  // so buildDiffs() Phase 2a can pick them up and compare lines
  for (const md of nb.details.mismatchedDevices) {
    if (md.reason === "param") continue;
    unbalanced.push({
      what: "device",
      a_count: 1, b_count: 1,
      a: [md.name], b: [md.name],
    });
  }

  return {
    matched: nb.matched,
    verified: true,
    a_devices: nb.a_devices,
    b_devices: nb.b_devices,
    a_nets: nb.a_nets,
    b_nets: nb.b_nets,
    iterations: 1,
    only_in_a_ports: [],
    only_in_b_ports: [],
    unbalanced,
    property_diffs: nb.property_diffs,
  };
}

function runNameBasedEngine(
  layoutNetlist: string,
  schematicNetlist: string,
): LvsEngineResult {
  const nb = compareByName(layoutNetlist, schematicNetlist);
  const mismatches = nb.details.mismatchedDevices;
  const unmatched = mismatches.filter((d) => d.reason !== "param");
  const typeMismatches = mismatches.filter((d) => d.reason === "type");
  const connMismatches = mismatches.filter((d) => d.reason === "connection");
  const paramMismatches = mismatches.filter((d) => d.reason === "param");

  // Detect name variants: different names, same signature
  // (Phase 2b already handles this via buildDiffs on frontend)
  const nameVariants = nb.details.mismatchedDevices
    .filter((d) => d.layout.modelType === d.schematic.modelType);

  // Build Calibre-like report
  const lines: string[] = [];
  lines.push(`${"=".repeat(70)}`);
  lines.push(`  NAME-BASED LVS REPORT`);
  lines.push(`${"=".repeat(70)}`);
  lines.push(``);
  lines.push(`  Verdict: ${nb.matched ? "CORRECT" : "INCORRECT"}`);
  lines.push(`  Devices: L ${nb.a_devices}  S ${nb.b_devices}`);
  lines.push(`  Nets:    L ${nb.a_nets}  S ${nb.b_nets}`);
  lines.push(``);

  if (nb.matched && nb.property_diffs.length === 0 && mismatches.length === 0) {
    lines.push(`  ✅ The two netlists match structurally.`);
    lines.push(`  (name-based: names + types + connections identical)`);
  }

  // Per-type breakdown (Calibre-style)
  if (!nb.matched || nb.property_diffs.length > 0) {
    lines.push(``);
    lines.push(`  INITIAL NUMBERS OF OBJECTS`);
    lines.push(`  ${"-".repeat(50)}`);
    lines.push(`                   Layout    Source`);
    lines.push(`                   ------    ------`);
    lines.push(`  Nets:               ${String(nb.a_nets).padStart(4)}    ${String(nb.b_nets).padStart(5)}`);
    lines.push(`  Instances:          ${String(nb.a_devices).padStart(4)}    ${String(nb.b_devices).padStart(5)}`);
    lines.push(``);
  }

  // Net imbalances
  const netImbalances = nb.unbalanced.filter(u => u.what === "net");
  if (netImbalances.length > 0) {
    lines.push(`  INCORRECT NETS (${netImbalances.length} classes)`);
    lines.push(`  ${"-".repeat(50)}`);
    for (const ni of netImbalances) {
      lines.push(`    L ${ni.a_count} connections  S ${ni.b_count} connections`);
      if (ni.a.length) lines.push(`      L: ${ni.a.join(", ")}`);
      if (ni.b.length) lines.push(`      S: ${ni.b.join(", ")}`);
    }
    lines.push(``);
  }

  // Device-only imbalances
  const devOnly = nb.unbalanced.filter(u => u.what === "device" && (u.a_count === 0 || u.b_count === 0));
  if (devOnly.length > 0) {
    lines.push(`  INCORRECT DEVICES (${devOnly.length})`);
    lines.push(`  ${"-".repeat(50)}`);
    for (const d of devOnly) {
      if (d.a_count > 0 && d.b_count === 0) {
        lines.push(`    L-only: ${d.a.join(", ")}`);
      } else if (d.a_count === 0 && d.b_count > 0) {
        lines.push(`    S-only: ${d.b.join(", ")}`);
      }
    }
    lines.push(``);
  }

  // Device diffs
  if (unmatched.length > 0) {
    lines.push(`  INCORRECT DEVICES — MISMATCH (${unmatched.length})`);
    lines.push(`  ${"-".repeat(50)}`);
    for (const d of unmatched) {
      const reasonLabel =
        d.reason === "type" ? "TYPE MISMATCH" :
        d.reason === "connection" ? "CONNECTION MISMATCH" :
        d.reason === "param" ? "PARAM CHANGED" : "MISMATCH";
      lines.push(`    ${d.name} — ${reasonLabel}`);
      lines.push(`      L: ${d.layout.modelType}  [${d.layout.terminals.join(", ")}]`);
      lines.push(`      S: ${d.schematic.modelType}  [${d.schematic.terminals.join(", ")}]`);
      // Name variant hint
      if (d.reason === "connection" && d.layout.modelType === d.schematic.modelType) {
        lines.push(`      ⚠ Same type, different connections`);
      }
    }
    lines.push(``);
  }

  // Property diffs
  if (nb.property_diffs.length > 0) {
    lines.push(`  PROPERTY DIFFS (${nb.property_diffs.length})`);
    lines.push(`  ${"-".repeat(50)}`);
    for (const pd of nb.property_diffs) {
      lines.push(`    ${pd.a_device}: ${pd.param}  ${pd.a_value} → ${pd.b_value}`);
    }
    lines.push(``);
  }

  // Name-variant warning: detect pairs of L-only + S-only names that
  // could be the same device with different names (e.g., R6 vs R66)
  const lOnlyNames = nb.unbalanced
    .filter(u => u.what === "device" && u.a_count > 0 && u.b_count === 0)
    .flatMap(u => u.a);
  const sOnlyNames = nb.unbalanced
    .filter(u => u.what === "device" && u.a_count === 0 && u.b_count > 0)
    .flatMap(u => u.b);
  if (lOnlyNames.length > 0 && sOnlyNames.length > 0) {
    lines.push(`  ⚠ Possible name variants detected: ${lOnlyNames.length} L-only + ${sOnlyNames.length} S-only`);
    lines.push(`    Devices with the same topology but different names may have been`);
    lines.push(`    renamed between layout and schematic (e.g., R6 → R66).`);
    lines.push(`    Check the list above for L-only / S-only entries.`);
    lines.push(``);
  }

  // Overall
  if (!nb.matched) {
    lines.push(`  ⚠ Netlists differ. Check INCORRECT sections above.`);
  }

  const report = lines.join("\n");

  return {
    engine: "name-based",
    matched: nb.matched,
    json: nameBasedToRawResult(nb),
    report,
  };
}

// ── Router ───────────────────────────────────────────────────

function buildSingleResponse(result: LvsEngineResult): LvsCombinedResult {
  return {
    engine: result.engine,
    matched: result.matched,
    json: result.json,
    report: result.report,
    events: result.events,
  };
}

export function createLvsRouter(_config: { dataRoot: string }) {
  const router = Router();

  router.post("/api/dies/:dieId/lvs/compare", async (request, response, next) => {
    try {
      const { layoutNetlist, schematicNetlist, dialect, moduleName, engine } = (request.body ?? {}) as LvsCompareRequest;
  
      if (!layoutNetlist || !schematicNetlist) {
        response.status(400).json({ ok: false, error: "Both layoutNetlist and schematicNetlist are required" });
        return;
      }

      const requestedEngine: LvsEngine = engine ?? "vyges-lvs";

      if (requestedEngine === "vyges-lvs") {
        const result = await runVygesLvs(layoutNetlist, schematicNetlist, dialect, moduleName);
        response.json({ ok: true, data: buildSingleResponse(result) });
      } else if (requestedEngine === "name-based") {
        const result = runNameBasedEngine(layoutNetlist, schematicNetlist);
        response.json({ ok: true, data: buildSingleResponse(result) });
      } else {
        response.status(400).json({ ok: false, error: `Unknown engine: ${requestedEngine}` });
      }
    } catch (error: unknown) {
      if (error instanceof LvsTimeoutError) {
        response.json({ ok: false, error: "LVS comparison timed out", detail: `Timeout: ${LVS_TIMEOUT_MS}ms` });
        return;
      }
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        response.json({ ok: false, error: "vyges-lvs CLI not found", detail: "Install vyges-lvs via vyges install loom or build from source: cargo install --git https://github.com/vyges-tools/lvs" });
        return;
      }
      next(error);
    }
  });

  return router;
}
