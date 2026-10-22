import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, buildServer } from "./build.js";
import { cleanupCrops } from "./tools/inspect.js";

async function main(): Promise<void> {
  const built = buildServer();
  void cleanupCrops(built.config.cropsDir).catch(() => {});
  const transport = new StdioServerTransport();
  await built.server.connect(transport);
  console.error(`[${SERVER_NAME}] ready: ${built.tools.length} tools -> ${built.config.baseUrl}`);
}

main().catch((error: unknown) => {
  console.error("[mmo-chip] fatal:", error);
  process.exit(1);
});
