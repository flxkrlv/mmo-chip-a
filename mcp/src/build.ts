import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BackendClient } from "./client.js";
import { loadConfig, type McpConfig } from "./config.js";
import { registerAnnotationTools } from "./tools/annotations.js";
import { registerInspectTools } from "./tools/inspect.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerNetlistTools } from "./tools/netlist.js";
import { registerOverlayTools } from "./tools/overlays.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerRegionTools } from "./tools/region.js";
import { registerSimulationTools } from "./tools/simulate.js";

export const SERVER_NAME = "mmo-chip";
export const SERVER_VERSION = "0.1.0";

export interface BuiltServer {
  server: McpServer;
  config: McpConfig;
  client: BackendClient;
  tools: string[];
}

/** Wire every tool onto a fresh server. Side-effect free: no transport, no IO. */
export function buildServer(
  config: McpConfig = loadConfig(),
  client: BackendClient = new BackendClient(config)
): BuiltServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const tools = [
    ...registerProjectTools(server, client, config),
    ...registerOverlayTools(server, client, config),
    ...registerRegionTools(server, client),
    ...registerAnnotationTools(server, client, config),
    ...registerInspectTools(server, client, config),
    ...registerSimulationTools(server, client),
    ...registerNetlistTools(server, client),
    ...registerJobTools(server, client)
  ];
  return { server, config, client, tools };
}
