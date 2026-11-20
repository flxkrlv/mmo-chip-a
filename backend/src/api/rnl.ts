/**
 * rnl.ts — RNL export for the analog schematic.
 *
 * The RNL writer is analog-canvas's own Netlist panel export. It runs as a
 * separate local process (the analog-canvas MCP in `--local` mode), so this
 * MIT application does not link or copy AGPL-3.0 code: the backend writes the
 * project file, asks the process for `netlist_code` with `rnl:true`, and keeps
 * the returned SPICE+RNL text beside the project.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import { readRnl, rnlModuleName, writeRnl } from "../rnlStore.js";

export interface RnlRouterOptions {
  dataRoot: string;
  /** Path to `analog-canvas-mcp` (a .js/.mjs entry, or an executable). */
  mcpPath?: string;
  /** Path to `analog-canvas-headless.mjs` the local mode loads. */
  headlessPath?: string;
  /** A CLI run's time limit (default 120 s). */
  timeoutMs?: number;
}

class RnlError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface RnlExport {
  text: string;
  diagnostics: unknown[];
  format: "spice" | "spectre";
  documentId?: string;
  status: string;
}

function setting(options: RnlRouterOptions, key: "mcpPath" | "headlessPath"): string {
  const envKey =
    key === "mcpPath" ? "CHIPTOOL_ANALOG_CANVAS_MCP" : "CHIPTOOL_ANALOG_CANVAS_HEADLESS";
  return (options[key] ?? process.env[envKey] ?? "").trim();
}

function cliCommand(entry: string): { command: string; args: string[] } {
  return /\.(?:mjs|cjs|js)$/i.test(entry)
    ? { command: process.execPath, args: [entry] }
    : { command: entry, args: [] };
}

/** Run the CLI once; resolve its stdout and stderr. */
function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const limit = 64 * 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new RnlError(
          504,
          `analog-canvas did not answer within ${Math.round(options.timeoutMs / 1000)} s`,
        ),
      );
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((sum, part) => sum + part.length, 0) < 2_000_000)
        stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
      });
    });
    child.stdin.end(`${options.stdin}\n`);
  });
}

/** The JSON payload inside the CLI's MCP content wrapper, or the JSON itself. */
function payloadOf(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start)
    throw new RnlError(502, `analog-canvas returned no JSON: ${stdout.slice(0, 400)}`);
  const outer = JSON.parse(stdout.slice(start, end + 1)) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  if (Array.isArray(outer.content) && typeof outer.content[0]?.text === "string")
    return JSON.parse(outer.content[0].text) as Record<string, unknown>;
  return outer as Record<string, unknown>;
}

async function exportRnl(
  project: unknown,
  format: "spice" | "spectre",
  options: RnlRouterOptions,
): Promise<RnlExport> {
  const entry = setting(options, "mcpPath");
  if (!entry)
    throw new RnlError(
      503,
      "RNL export is not configured. Set CHIPTOOL_ANALOG_CANVAS_MCP to an analog-canvas MCP entry (apps/mcp-server/dist/main.js) and CHIPTOOL_ANALOG_CANVAS_HEADLESS to its headless bundle.",
    );
  const headless = setting(options, "headlessPath");
  if (!headless)
    throw new RnlError(
      503,
      "RNL export needs the analog-canvas headless bundle: set CHIPTOOL_ANALOG_CANVAS_HEADLESS (analog-canvas-headless.mjs).",
    );

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mmo-rnl-"));
  try {
    await fs.writeFile(
      path.join(dir, "project.icproj.json"),
      JSON.stringify(project),
      "utf8",
    );
    const { command, args } = cliCommand(entry);
    const run = await runProcess(
      command,
      [...args, "--local", dir, "--http", "netlist_code"],
      {
        cwd: dir,
        env: { ...process.env, ANALOG_CANVAS_HEADLESS: headless },
        stdin: JSON.stringify({ action: "read", format, rnl: true }),
        timeoutMs: options.timeoutMs ?? 120_000,
      },
    );
    if (run.code !== 0)
      throw new RnlError(
        502,
        `analog-canvas exited with ${run.code}: ${run.stderr.trim().slice(-1500) || run.stdout.trim().slice(-1500)}`,
      );
    const payload = payloadOf(run.stdout);
    if (payload.ok === false || payload.error)
      throw new RnlError(
        502,
        `analog-canvas refused the export: ${JSON.stringify(payload.error ?? payload)}`,
      );
    const netlist = payload.netlist as
      | {
          text?: unknown;
          diagnostics?: unknown;
          format?: unknown;
          documentId?: unknown;
          status?: unknown;
        }
      | undefined;
    if (!netlist || typeof netlist.text !== "string")
      throw new RnlError(
        502,
        "analog-canvas returned no RNL text; is this a current build with netlist_code rnl:true?",
      );
    const status = typeof netlist.status === "string" ? netlist.status : "ready";
    if (status !== "ready")
      throw new RnlError(
        422,
        `analog-canvas could not write RNL: ${JSON.stringify(netlist.diagnostics ?? [])}`,
      );
    return {
      text: netlist.text,
      diagnostics: Array.isArray(netlist.diagnostics) ? netlist.diagnostics : [],
      format: netlist.format === "spectre" ? "spectre" : format,
      ...(typeof netlist.documentId === "string"
        ? { documentId: netlist.documentId }
        : {}),
      status,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export function createRnlRouter(options: RnlRouterOptions) {
  const router = Router();

  router.post("/api/dies/:dieId/rnl/export", async (request, response) => {
    const dieId = String(request.params.dieId ?? "");
    const project = (request.body as { project?: unknown } | undefined)?.project;
    if (!project || typeof project !== "object")
      return response.status(400).json({ error: '"project" must be a project object' });
    const moduleName = rnlModuleName(
      (request.body as { moduleName?: unknown }).moduleName,
    );
    const format =
      (request.body as { format?: unknown }).format === "spectre" ? "spectre" : "spice";
    try {
      const result = await exportRnl(project, format, options);
      const file = await writeRnl(options.dataRoot, dieId, moduleName, result.text);
      return response.json({ ok: true, moduleName, file, ...result });
    } catch (error) {
      const status = error instanceof RnlError ? error.status : 502;
      return response.status(status).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/api/dies/:dieId/rnl", async (request, response) => {
    const dieId = String(request.params.dieId ?? "");
    const moduleName = rnlModuleName(request.query.moduleName);
    try {
      const saved = await readRnl(options.dataRoot, dieId, moduleName);
      if (!saved)
        return response.status(404).json({ error: "No RNL export for this module" });
      return response.json({ ok: true, moduleName, text: saved.text });
    } catch (error) {
      return response
        .status(500)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put("/api/dies/:dieId/rnl", async (request, response) => {
    const dieId = String(request.params.dieId ?? "");
    const body = request.body as { moduleName?: unknown; text?: unknown } | undefined;
    if (typeof body?.text !== "string")
      return response.status(400).json({ error: '"text" must be a string' });
    const moduleName = rnlModuleName(body.moduleName);
    try {
      const file = await writeRnl(options.dataRoot, dieId, moduleName, body.text);
      return response.json({ ok: true, moduleName, file });
    } catch (error) {
      return response
        .status(500)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
