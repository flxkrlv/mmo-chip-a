import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { McpStatus, McpWriteMode } from "shared";
import { requireAuth } from "../auth/middleware.js";
import { readDieRecord } from "../store.js";
import { commentImagePath } from "../mcp/commentImages.js";
import { callMcpTool, listMcpTools } from "../mcp/mcpTools.js";
import {
  historyItem,
  McpEditError,
  readMcpState,
  setMcpSettings,
  stepMcpHistory
} from "../mcp/mcpState.js";

/**
 * MCP (Model Context Protocol) access to one die.
 *
 *   POST /mcp/:dieId                 Streamable HTTP transport (JSON responses
 *                                    only, no server-initiated SSE stream)
 *   GET  /api/dies/:dieId/mcp        status for the GUI's MCP panel
 *   PUT  /api/dies/:dieId/mcp/settings { mode?: "off" | "create" | "edit", wires?: boolean, full?: boolean }
 *   GET  /api/dies/:dieId/comment-images/:file   images attached to comments
 *                                    (public like the other GET /api/dies/*
 *                                    image routes, so <img> can load them)
 *   POST /api/dies/:dieId/mcp/undo   undo / redo the newest MCP change
 *   POST /api/dies/:dieId/mcp/redo
 *
 * The MCP endpoint sits outside /api (so it isn't caught by the public
 * GET /api/dies/* exemption) and requires the same Bearer JWT as the API when
 * auth is enabled.
 */

const SERVER_NAME = "mmo-chip";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_MODES: McpWriteMode[] = ["off", "create", "edit"];

const INSTRUCTIONS =
  "This server exposes one chip die from mmo-chip, a tool for reverse engineering integrated circuits " +
  "from die photos. Coordinates are full-resolution die image pixels (origin top-left). Start with " +
  "get_die_info, look at the die with get_die_image (zoom in with a region), and read the extracted " +
  "circuit with get_annotations (find_wires_near gives exact wire ids around a point). Everything is " +
  "read-only except, when a user enabled it for this die: markup (comments, floorplan regions, rulers) " +
  "and, behind a separate switch, wires and vias — or everything with full edits. get_die_info says " +
  "what is currently allowed. render_annotated_image draws the layout with annotations, highlights and " +
  "your own marks; attach such a render to a comment with add_comment's `image` to show people what you mean.";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** clientInfo.name per session, for attribution in the undo history. */
const sessionClients = new Map<string, string | null>();
const MAX_SESSIONS = 500;

export function createMcpRouter(config: {
  dataRoot: string;
  onAnnotationsChanged?: (dieId: string, rev: number) => void;
}) {
  const router = Router();

  // ─── MCP endpoint ────────────────────────────────────────────────

  router.post("/mcp/:dieId", rejectForeignOrigin, requireAuth, async (request, response) => {
    const dieId = request.params.dieId as string;
    try {
      await readDieRecord(config.dataRoot, dieId);
    } catch {
      response.status(404).json(rpcError(null, -32001, `Unknown die ${dieId}`));
      return;
    }

    const body = request.body as JsonRpcMessage | JsonRpcMessage[] | undefined;
    const messages = Array.isArray(body) ? body : body ? [body] : [];
    if (messages.length === 0 || messages.some((m) => !m || typeof m !== "object" || m.jsonrpc !== "2.0")) {
      response.status(400).json(rpcError(null, -32600, "Invalid JSON-RPC request"));
      return;
    }

    let sessionId = request.header("mcp-session-id") ?? null;
    const replies: unknown[] = [];
    for (const message of messages) {
      // Notifications (no id) and client responses need no reply.
      if (message.id === undefined || !message.method) continue;
      if (message.method === "initialize") {
        sessionId = randomUUID();
        const clientInfo = message.params?.clientInfo as { name?: unknown } | undefined;
        rememberClient(sessionId, typeof clientInfo?.name === "string" ? clientInfo.name : null);
      }
      replies.push(
        await handle(message, {
          dataRoot: config.dataRoot,
          dieId,
          clientName: sessionId ? sessionClients.get(sessionId) ?? null : null,
          onAnnotationsChanged: config.onAnnotationsChanged
        })
      );
    }

    if (sessionId) response.setHeader("Mcp-Session-Id", sessionId);
    if (replies.length === 0) {
      response.status(202).end();
      return;
    }
    response.json(Array.isArray(body) ? replies : replies[0]);
  });

  // No server-initiated stream and no session teardown to do.
  router.get("/mcp/:dieId", (_request, response) => {
    response.status(405).set("Allow", "POST").end();
  });
  router.delete("/mcp/:dieId", (_request, response) => {
    response.status(405).set("Allow", "POST").end();
  });

  // ─── GUI: status, mode, undo / redo ──────────────────────────────

  router.get("/api/dies/:dieId/mcp", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      await readDieRecord(config.dataRoot, dieId);
      const state = await readMcpState(config.dataRoot, dieId);
      const status: McpStatus = {
        mode: state.mode,
        wires: state.wires,
        full: state.full,
        endpointPath: `/mcp/${encodeURIComponent(dieId)}`,
        undo: state.undo.map(historyItem),
        redo: state.redo.map(historyItem)
      };
      response.json(status);
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/dies/:dieId/mcp/settings", async (request, response, next) => {
    try {
      const { mode, wires, full } = (request.body ?? {}) as { mode?: unknown; wires?: unknown; full?: unknown };
      if (mode !== undefined && !MCP_MODES.includes(mode as McpWriteMode)) {
        response.status(400).json({ error: `mode must be one of ${MCP_MODES.join(", ")}` });
        return;
      }
      if ((wires !== undefined && typeof wires !== "boolean") || (full !== undefined && typeof full !== "boolean")) {
        response.status(400).json({ error: "wires and full must be booleans" });
        return;
      }
      await setMcpSettings(config.dataRoot, request.params.dieId, {
        mode: mode as McpWriteMode | undefined,
        wires,
        full
      });
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/comment-images/:file", async (request, response, next) => {
    try {
      const file = await commentImagePath(config.dataRoot, request.params.dieId, request.params.file);
      if (!file) {
        response.status(404).json({ error: "Not found" });
        return;
      }
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      response.sendFile(file);
    } catch (error) {
      next(error);
    }
  });

  for (const direction of ["undo", "redo"] as const) {
    router.post(`/api/dies/:dieId/mcp/${direction}`, async (request, response, next) => {
      const { dieId } = request.params;
      try {
        const { rev, entry } = await stepMcpHistory(config.dataRoot, dieId, direction);
        config.onAnnotationsChanged?.(dieId, rev);
        response.json({ ok: true, rev, entry });
      } catch (error) {
        if (error instanceof McpEditError) {
          response.status(error.status).json({ error: error.message });
          return;
        }
        next(error);
      }
    });
  }

  return router;
}

async function handle(
  message: JsonRpcMessage,
  ctx: Parameters<typeof callMcpTool>[0]
): Promise<unknown> {
  const id = message.id ?? null;
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: "mmo-chip die", version: SERVER_VERSION },
        instructions: INSTRUCTIONS
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: listMcpTools() });
    case "tools/call": {
      const name = params.name;
      const args = params.arguments ?? {};
      if (typeof name !== "string" || typeof args !== "object" || Array.isArray(args)) {
        return rpcError(id, -32602, "tools/call needs a tool name and an arguments object");
      }
      try {
        const result = await callMcpTool(ctx, name, args as Record<string, unknown>);
        return result ? rpcResult(id, result) : rpcError(id, -32602, `Unknown tool: ${name}`);
      } catch (error) {
        // Unexpected failures are still tool results, so the model can see them.
        console.error(`[mcp] ${name} failed for ${ctx.dieId}:`, error);
        const reason = error instanceof Error ? error.message : String(error);
        return rpcResult(id, { content: [{ type: "text", text: `Tool failed: ${reason}` }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`);
  }
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rememberClient(sessionId: string, name: string | null): void {
  sessionClients.set(sessionId, name);
  if (sessionClients.size > MAX_SESSIONS) {
    const oldest = sessionClients.keys().next().value;
    if (oldest !== undefined) sessionClients.delete(oldest);
  }
}

/**
 * DNS-rebinding guard required by the MCP spec: a browser page from another
 * site must not be able to drive the endpoint. Native MCP clients send no
 * Origin; a browser one must come from a loopback host.
 */
function rejectForeignOrigin(request: Request, response: Response, next: () => void): void {
  const origin = request.header("origin");
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).hostname;
    } catch {
      // unparsable → rejected below
    }
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
      response.status(403).json(rpcError(null, -32002, "Origin not allowed"));
      return;
    }
  }
  next();
}
