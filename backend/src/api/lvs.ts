import { promises as fsp } from "node:fs";
import { accessSync } from "node:fs";
import path from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";
import { Router } from "express";
import type { LvsCompareRequest, LvsRawResult } from "shared";
import { normalizeForVyges } from "../lib/normalizeNetlist.js";

// Nets always treated as global (universal SPICE convention)
const ALWAYS_GLOBAL = new Set(["0"]);
// Common power/ground names — auto-detected if present in either netlist
const POWER_NET_NAMES = new Set(["GND", "VCC", "VDD", "VSS", "VEE", "VBB", "VSUB", "AVDD", "AVSS", "DVDD", "DVSS"]);

function extractGlobals(layout: string, schematic: string): string[] {
  const globals = new Set(ALWAYS_GLOBAL);

  // Parse explicit .GLOBAL directives from both sides
  for (const netlist of [layout, schematic]) {
    for (const line of netlist.split("\n")) {
      const trimmed = line.trim();
      if (/^global\s+/i.test(trimmed)) {
        const nets = trimmed.replace(/^global\s+/i, "").trim().split(/\s+/);
        for (const n of nets.filter(Boolean)) globals.add(n);
      }
    }
  }

  // Auto-detect common power/ground nets present in either netlist
  // (splits on whitespace/parens/comma to catch standalone tokens like (GND Net_42))
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

export function createLvsRouter(_config: { dataRoot: string }) {
  const router = Router();

  router.post("/api/dies/:dieId/lvs/compare", async (request, response, next) => {
    try {
      const { layoutNetlist, schematicNetlist, dialect, moduleName } = (request.body ?? {}) as LvsCompareRequest;

      if (!layoutNetlist || !schematicNetlist) {
        response.status(400).json({ ok: false, error: "Both layoutNetlist and schematicNetlist are required" });
        return;
      }

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
        response.json({ ok: true, data: { matched, json, report: textResult.stdout } });
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
