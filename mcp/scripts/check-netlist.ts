import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, "..");
const baseUrl = (process.env.MMO_BASE_URL ?? "http://127.0.0.1:3001").trim();
const dieId = process.argv[2] ?? "import-033c2867fef6";

interface CallResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: mcpRoot,
    env: { ...process.env, MMO_BASE_URL: baseUrl } as Record<string, string>,
    stderr: "inherit"
  });
  const client = new Client({ name: "mmo-chip-netlist-check", version: "0.1.0" });
  console.log(`[netlist-check] spawning MCP server, backend ${baseUrl}`);
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    console.log(`[netlist-check] tools/list: ${names.length} tools`);
    if (!names.includes("export_netlist")) {
      console.error("[netlist-check] FAIL: export_netlist not registered");
      process.exitCode = 1;
      return;
    }

    const started = Date.now();
    const result = (await client.callTool({
      name: "export_netlist",
      arguments: { dieId, moduleName: "mcp_check", dialect: "cdl", includeText: true }
    })) as CallResult;
    const elapsed = Date.now() - started;
    const text = (result.content ?? []).map((entry) => entry.text ?? "").join("\n");
    if (result.isError) {
      console.error(`[netlist-check] FAIL: export_netlist error after ${elapsed} ms`);
      console.error(text.slice(0, 1000));
      process.exitCode = 1;
      return;
    }

    const payload = JSON.parse(text) as Record<string, unknown>;
    console.log(`[netlist-check] export_netlist OK in ${elapsed} ms`);
    console.log(`        dieId          : ${payload.dieId}`);
    console.log(`        umPerPx        : ${payload.umPerPx}`);
    console.log(`        deviceCount    : ${payload.deviceCount} (${JSON.stringify(payload.byKind)})`);
    console.log(`        namedNetCount  : ${payload.namedNetCount}`);
    console.log(`        warnings       : ${JSON.stringify(payload.warnings)}`);
    console.log(`        virtualConnects: ${JSON.stringify(payload.virtualConnects)}`);
    console.log(`        textChars      : ${payload.textChars} truncated=${payload.textTruncated}`);
    console.log(`        persisted      : ${payload.persisted} path=${payload.netlistPath}`);
    const body = String(payload.text ?? "");
    console.log("[netlist-check] netlist head:");
    console.log(body.split("\n").slice(0, 12).map((line) => `        ${line}`).join("\n"));
    console.log("[netlist-check] PASS");
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error: unknown) => {
  console.error("[netlist-check] FAILED:", error);
  process.exit(1);
});
