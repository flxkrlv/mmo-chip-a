/**
 * rnl.ts — RNL export for the analog schematic.
 *
 * The RNL writer is analog-canvas's own Netlist panel export. It runs as a
 * separate local process (the analog-canvas MCP in `--local` mode), so this
 * MIT application does not link or copy AGPL-3.0 code: the backend writes the
 * project file, asks the process for `netlist_code` with `rnl:true`, and keeps
 * the returned SPICE+RNL text beside the project.
 *
 * The saved file is a snapshot, not a live view: a schematic export replaces
 * it, so it asks first when the drawing has edits, and it refuses while the
 * user pinned the drawing. Every write is also a version in `rnl/history`,
 * so an overwrite stays recoverable.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import {
  analogCanvasSetupHint,
  resolveAnalogCanvasPaths,
} from "../analogCanvas.js";
import {
  readRnl,
  readRnlRevision,
  readRnlStatus,
  restoreRnlRevision,
  rnlModuleName,
  setRnlFrozen,
  writeRnl,
} from "../rnlStore.js";

export interface RnlRouterOptions {
  dataRoot: string;
  /** Path to `analog-canvas-mcp` (a .js/.mjs entry, or an executable). */
  mcpPath?: string;
  /** Path to `analog-canvas-headless.mjs` the local mode loads. */
  headlessPath?: string;
  /** A CLI run's time limit (default 120 s). */
  timeoutMs?: number;
  /** Keep the search to the paths above and the environment (tests). */
  discover?: boolean;
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
  const paths = resolveAnalogCanvasPaths({
    mcpPath: options.mcpPath,
    headlessPath: options.headlessPath,
    discover: options.discover,
  });
  if (!paths.mcpPath || !paths.headlessPath)
    throw new RnlError(503, analogCanvasSetupHint(paths));
  const entry = paths.mcpPath;
  const headless = paths.headlessPath;

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

  /** What the RNL tab needs to say before a first export. */
  router.get("/api/rnl/status", (_request, response) => {
    const paths = resolveAnalogCanvasPaths({
      mcpPath: options.mcpPath,
      headlessPath: options.headlessPath,
      discover: options.discover,
    });
    const ready = !!paths.mcpPath && !!paths.headlessPath;
    return response.json({
      ok: ready,
      ready,
      mcpPath: paths.mcpPath,
      headlessPath: paths.headlessPath,
      home: paths.home,
      ignored: paths.ignored,
      searched: paths.searched,
      ...(ready ? {} : { hint: analogCanvasSetupHint(paths) }),
    });
  });

  router.post("/api/dies/:dieId/rnl/export", async (request, response) => {
    const dieId = String(request.params.dieId ?? "");
    const body = request.body as
      | {
          project?: unknown;
          moduleName?: unknown;
          format?: unknown;
          sourceHash?: unknown;
          confirmOverwrite?: unknown;
        }
      | undefined;
    const project = body?.project;
    if (!project || typeof project !== "object")
      return response.status(400).json({ error: '"project" must be a project object' });
    const moduleName = rnlModuleName(body?.moduleName);
    const format =
      body?.format === "spectre" ? "spectre" : "spice";
    const sourceHash = typeof body?.sourceHash === "string" ? body.sourceHash : null;
    try {
      const status = await readRnlStatus(options.dataRoot, dieId, moduleName);
      if (status.state.frozen) {
        return response.status(409).json({
          error:
            "The RNL drawing is pinned as a fixed snapshot. Unpin it on the RNL tab before regenerating it from the schematic.",
          code: "frozen",
          state: status.state,
        });
      }
      if (status.exists && status.state.edited && body?.confirmOverwrite !== true) {
        return response.status(409).json({
          error:
            status.state.revisionCount === 0
              ? "The saved RNL file has no history, so it may contain edits. Regenerating it from the schematic replaces the drawing; the current text is kept as the first history version."
              : "The saved RNL drawing has edits (by an MCP agent or by hand). Regenerating it from the schematic replaces the drawing; the current version stays in the RNL history and can be restored.",
          code: "agent-edits",
          state: status.state,
        });
      }
      const result = await exportRnl(project, format, options);
      const write = await writeRnl(options.dataRoot, dieId, moduleName, result.text, {
        author: "schematic",
        note: `exported from the schematic (${result.format})`,
        format: result.format,
        sourceHash,
        forceRevision: true,
      });
      return response.json({
        ok: true,
        moduleName,
        file: write.file,
        text: write.text,
        revision: write.revision,
        state: write.state,
        diagnostics: result.diagnostics,
        format: result.format,
        status: result.status,
        ...(result.documentId ? { documentId: result.documentId } : {}),
      });
    } catch (error) {
      const status = error instanceof RnlError ? error.status : 502;
      return response.status(status).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/api/dies/:dieId/rnl/history", async (request, response) => {
    const dieId = String(request.params.dieId ?? "");
    const moduleName = rnlModuleName(request.query.moduleName);
    try {
      const status = await readRnlStatus(options.dataRoot, dieId, moduleName);
      return response.json({
        ok: true,
        moduleName,
        exists: status.exists,
        state: status.state,
        revisions: status.revisions,
      });
    } catch (error) {
      return response
        .status(500)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/api/dies/:dieId/rnl/history/:revisionId", async (request, response) => {
    const dieId = String(request.params.dieId ?? "");
    const moduleName = rnlModuleName(request.query.moduleName);
    try {
      const detail = await readRnlRevision(
        options.dataRoot,
        dieId,
        moduleName,
        String(request.params.revisionId ?? ""),
      );
      if (!detail)
        return response.status(404).json({ error: "No such RNL version" });
      return response.json({ ok: true, moduleName, ...detail });
    } catch (error) {
      return response
        .status(500)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post(
    "/api/dies/:dieId/rnl/history/:revisionId/restore",
    async (request, response) => {
      const dieId = String(request.params.dieId ?? "");
      const moduleName = rnlModuleName(
        (request.body as { moduleName?: unknown } | undefined)?.moduleName,
      );
      try {
        const restored = await restoreRnlRevision(
          options.dataRoot,
          dieId,
          moduleName,
          String(request.params.revisionId ?? ""),
        );
        if (!restored)
          return response.status(404).json({ error: "No such RNL version" });
        return response.json({
          ok: true,
          moduleName,
          file: restored.file,
          text: restored.text,
          revision: restored.revision,
          state: restored.state,
        });
      } catch (error) {
        return response
          .status(500)
          .json({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  router.get("/api/dies/:dieId/rnl", async (request, response) => {
    const dieId = String(request.params.dieId ?? "");
    const moduleName = rnlModuleName(request.query.moduleName);
    try {
      const saved = await readRnl(options.dataRoot, dieId, moduleName);
      if (!saved)
        return response.status(404).json({ error: "No RNL export for this module" });
      const status = await readRnlStatus(options.dataRoot, dieId, moduleName);
      return response.json({
        ok: true,
        moduleName,
        text: saved.text,
        state: status.state,
      });
    } catch (error) {
      return response
        .status(500)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put("/api/dies/:dieId/rnl", async (request, response) => {
    const dieId = String(request.params.dieId ?? "");
    const body = request.body as
      | { moduleName?: unknown; text?: unknown; note?: unknown }
      | undefined;
    if (typeof body?.text !== "string")
      return response.status(400).json({ error: '"text" must be a string' });
    const moduleName = rnlModuleName(body.moduleName);
    try {
      const write = await writeRnl(options.dataRoot, dieId, moduleName, body.text, {
        author: "user",
        ...(typeof body.note === "string" ? { note: body.note } : {}),
      });
      return response.json({
        ok: true,
        moduleName,
        file: write.file,
        text: write.text,
        revision: write.revision,
        state: write.state,
      });
    } catch (error) {
      return response
        .status(500)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put("/api/dies/:dieId/rnl/state", async (request, response) => {
    const dieId = String(request.params.dieId ?? "");
    const body = request.body as
      | { moduleName?: unknown; frozen?: unknown }
      | undefined;
    if (typeof body?.frozen !== "boolean")
      return response.status(400).json({ error: '"frozen" must be a boolean' });
    const moduleName = rnlModuleName(body.moduleName);
    try {
      const state = await setRnlFrozen(
        options.dataRoot,
        dieId,
        moduleName,
        body.frozen,
      );
      return response.json({ ok: true, moduleName, state });
    } catch (error) {
      return response
        .status(500)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
