import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, "..");
const baseUrl = (process.env.MMO_BASE_URL ?? "http://127.0.0.1:3001").trim();

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
  const client = new Client({ name: "mmo-chip-smoke", version: "0.1.0" });
  console.log(`[smoke] spawning MCP server (cwd ${mcpRoot}), backend ${baseUrl}`);
  await client.connect(transport);
  try {
    await check(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function check(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  console.log(`[smoke] tools/list OK: ${names.length} tools`);
  console.log(`        ${names.join(", ")}`);
  if (names.length !== 24) {
    console.error(`[smoke] expected 24 tools, got ${names.length}`);
    process.exitCode = 1;
    return;
  }

  const result = (await client.callTool({ name: "list_projects", arguments: {} })) as CallResult;
  const text = (result.content ?? []).map((entry) => entry.text ?? "").join("\n");
  if (result.isError) {
    console.error(`[smoke] list_projects -> error: ${text.split("\n")[0]}`);
    if (text.includes("Backend unreachable")) {
      console.error(
        `[smoke] handshake works, backend at ${baseUrl} is not answering. Start it with "npm run dev".`
      );
      process.exitCode = 2;
      return;
    }
    process.exitCode = 1;
    return;
  }

  let rows: Array<{ id?: string; name?: string }> = [];
  try {
    rows = JSON.parse(text) as Array<{ id?: string; name?: string }>;
  } catch {
    console.error(`[smoke] list_projects returned non-JSON: ${text.slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[smoke] list_projects OK: ${rows.length} project(s)`);
  for (const row of rows.slice(0, 10)) {
    console.log(`        - ${row.id}: ${row.name}`);
  }
  if (rows.length === 0) {
    console.log(
      "[smoke] no projects imported yet — import a die image in the app to exercise the rest."
    );
    return;
  }

  const first = rows[0];
  if (first?.id) {
    const layersResult = (await client.callTool({
      name: "list_overlay_layers",
      arguments: { dieId: first.id }
    })) as CallResult;
    const layerText = (layersResult.content ?? []).map((entry) => entry.text ?? "").join("\n");
    if (layersResult.isError) {
      console.error(`[smoke] list_overlay_layers -> error: ${layerText.split("\n")[0]}`);
      process.exitCode = 1;
      return;
    }
    try {
      const layers = JSON.parse(layerText) as { count?: number; layers?: Array<{ name?: string }> };
      console.log(
        `[smoke] list_overlay_layers OK: ${layers.count ?? 0} layer(s)` +
          (layers.layers?.length
            ? ` (${layers.layers.map((layer) => layer.name).join(", ")})`
            : "")
      );
    } catch {
      console.error(`[smoke] list_overlay_layers returned non-JSON: ${layerText.slice(0, 200)}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log("[smoke] PASS");
}

main().catch((error: unknown) => {
  console.error("[smoke] FAILED:", error);
  process.exit(1);
});
