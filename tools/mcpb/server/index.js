#!/usr/bin/env node
/**
 * stdio ↔ Streamable HTTP bridge for the mmo-chip MCP endpoint.
 *
 * Claude Desktop extensions (.mcpb) launch a local stdio server; mmo-chip
 * serves MCP over HTTP at /mcp (all dies) or /mcp/<dieId> (backend/src/api/mcp.ts). This relays
 * each newline-delimited JSON-RPC message from stdin as a POST and writes the
 * JSON reply to stdout. No dependencies: Node >= 18 (global fetch).
 *
 * Env:
 *   MMO_CHIP_MCP_URL  endpoint, e.g. http://localhost:3001/mcp (or …/mcp/<dieId>)
 *   MMO_CHIP_TOKEN    optional login token (when the backend has JWT_SECRET)
 */
"use strict";

const readline = require("node:readline");

const endpoint = (process.env.MMO_CHIP_MCP_URL || "").trim();
const rawToken = (process.env.MMO_CHIP_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
// An unset optional user_config field may arrive as the literal placeholder.
const token = rawToken.startsWith("${") ? "" : rawToken;

const log = (...args) => console.error("[mmo-chip-mcp]", ...args);

// A bad URL is reported on every request instead of exiting, so the client
// shows the reason rather than "server disconnected".
const configError = /^https?:\/\/.+\/mcp(\/[^/]+)?\/?$/.test(endpoint)
  ? null
  : `MMO_CHIP_MCP_URL must look like http://localhost:3001/mcp, got "${endpoint}" — fix the endpoint in the extension settings`;
if (configError) log(configError);

let sessionId = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function replyError(message, code, text) {
  if (message && message.id !== undefined && message.method) {
    send({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
  }
}

async function relay(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  if (configError) {
    replyError(message, -32000, `mmo-chip: ${configError}`);
    return;
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(endpoint, { method: "POST", headers, body: line });
  } catch (error) {
    log(`POST ${endpoint} failed:`, error && error.message);
    replyError(
      message,
      -32000,
      `mmo-chip backend unreachable at ${endpoint} — is it running (npm run dev)?`
    );
    return;
  }

  const newSession = response.headers.get("mcp-session-id");
  if (newSession) sessionId = newSession;
  if (response.status === 202) return;

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON (e.g. an HTML error page) — handled below
  }
  if (body && (body.jsonrpc || Array.isArray(body))) {
    for (const reply of Array.isArray(body) ? body : [body]) send(reply);
    return;
  }
  const reason =
    response.status === 401
      ? "authentication required: set the login token in the extension settings"
      : `HTTP ${response.status}${body && body.error ? `: ${body.error}` : ""}`;
  log(reason);
  replyError(message, -32000, `mmo-chip: ${reason}`);
}

// Strictly in order: the session id from `initialize` must be known before
// the next request goes out, and replies keep the client's ordering.
let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  queue = queue.then(() => relay(line)).catch((error) => log("relay failed:", error));
});
process.stdin.on("end", () => {
  void queue.then(() => process.exit(0));
});

log(`relaying to ${endpoint}`);
