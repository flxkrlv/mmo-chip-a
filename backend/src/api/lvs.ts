import { promises as fsp } from "node:fs";
import { accessSync } from "node:fs";
import path from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";
import { Router } from "express";
import type { LvsCompareRequest, LvsRawResult, LvsEngine, LvsEngineResult, LvsCombinedResult } from "shared";
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
      if (/^global\s+/i.test(trimmed)) {
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
    const proc = spawn(cli, args, { timeout, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
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

async function runVygesLvs(
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
    await fsp.writeFile(layoutPath, layoutNorm, "utf-8");
    await fsp.writeFile(schematicPath, schematicNorm, "utf-8");

    let jobContent = `layout:    ${layoutPath}\nschematic: ${schematicPath}\n`;
    if (moduleName) jobContent += `top:       ${moduleName}\n`;
    await fsp.writeFile(jobPath, jobContent, "utf-8");

    const [jsonResult, textResult] = await Promise.all([
      runCli(LVS_CLI, ["run", jobPath, "--json"], LVS_TIMEOUT_MS),
      runCli(LVS_CLI, ["run", jobPath], LVS_TIMEOUT_MS),
    ]);

    const json = JSON.parse(jsonResult.stdout) as LvsRawResult;
    const firstLine = textResult.stdout.split("\n")[0] ?? "";
    const matched = /\bMATCH\b/.test(firstLine) && !/\bMISMATCH\b/.test(firstLine);
    return { engine: "vyges-lvs", matched, json, report: textResult.stdout };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function nameBasedToRawResult(nb: NameBasedResult): LvsRawResult {
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
    unbalanced: nb.unbalanced,
    property_diffs: nb.property_diffs,
  };
}

function runNameBasedEngine(
  layoutNetlist: string,
  schematicNetlist: string,
): LvsEngineResult {
  const nb = compareByName(layoutNetlist, schematicNetlist);
  const unmatched = nb.details.mismatchedDevices.filter((d) => d.reason !== "param");
  const details = nb.details.mismatchedDevices
    .map((d) => `  ${d.name}: ${d.reason} (${d.layout.modelType} vs ${d.schematic.modelType})`)
    .join("\n");
  const unbalLines = nb.unbalanced
    .map((u) => u.what === "device"
      ? `  ${u.a_count > u.b_count ? "L-only" : "S-only"}: [${u.a.concat(u.b).join(", ")}]`
      : `  net count: L=${u.a_count} S=${u.b_count}`)
    .join("\n");
  const report = [
    `name-based LVS — ${nb.matched ? "MATCH" : "MISMATCH"}`,
    `  devices  L ${nb.a_devices}  S ${nb.b_devices}`,
    `  nets     L ${nb.a_nets}  S ${nb.b_nets}`,
    ...(unbalLines ? ["", "unbalanced:", unbalLines] : []),
    ...(details ? ["", "device diffs:", details] : []),
    ...(nb.property_diffs.length > 0 ? ["", "property diffs:"] : []),
    ...nb.property_diffs.map((d) => `  ${d.a_device}: ${d.param} ${d.a_value} → ${d.b_value}`),
    ...(unmatched.length === 0 && unbalLines === "" ? ["", "  netlists match (name-based: topology + type + connections)"] : []),
  ].join("\n");

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
  };
}

function buildAllResponse(engines: LvsEngineResult[]): LvsCombinedResult {
  const map: Record<string, LvsEngineResult> = {};
  for (const e of engines) map[e.engine] = e;
  const allMatch = engines.every((e) => e.matched);
  const reports = engines.map((e) => `${e.engine}: ${e.matched ? "MATCH" : "MISMATCH"}`);
  return {
    engine: "all",
    matched: allMatch,
    json: engines[0]!.json,
    report: reports.join("\n") + "\n" + (allMatch ? "✅ All engines agree: MATCH" : "⚠️ Engines disagree!"),
    engines: map,
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
      } else if (requestedEngine === "all") {
        const [vygesResult, nameResult] = await Promise.all([
          runVygesLvs(layoutNetlist, schematicNetlist, dialect, moduleName).catch((err) => ({
            engine: "vyges-lvs" as const,
            matched: false,
            json: { matched: false, verified: false, a_devices: 0, b_devices: 0, a_nets: 0, b_nets: 0, iterations: 0, only_in_a_ports: [], only_in_b_ports: [], unbalanced: [], property_diffs: [] } as LvsRawResult,
            report: `ERROR: ${err.message}`,
          })),
          Promise.resolve().then(() => runNameBasedEngine(layoutNetlist, schematicNetlist)),
        ]);
        response.json({ ok: true, data: buildAllResponse([vygesResult, nameResult]) });
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
