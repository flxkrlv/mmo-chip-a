import os from "node:os";
import path from "node:path";

export interface McpConfig {
  /** Backend origin without a trailing slash. */
  baseUrl: string;
  /** Bearer token; the backend only enforces auth when JWT_SECRET is set. */
  token: string | undefined;
  /** Name stamped on comments / floorplans the server authors. */
  agentName: string;
  /** Directory get_crop writes image files into. */
  cropsDir: string;
  /** Directory export_project writes ZIPs into when no path is given. */
  exportDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const value = (key: string): string => (env[key] ?? "").trim();
  return {
    baseUrl: (value("MMO_BASE_URL") || "http://127.0.0.1:3001").replace(/\/+$/, ""),
    token: value("MMO_TOKEN") || undefined,
    agentName: value("MMO_AGENT_NAME") || "mcp-agent",
    cropsDir: value("MMO_CROPS_DIR") || path.join(os.tmpdir(), "mmo-crops"),
    exportDir: value("MMO_EXPORT_DIR") || path.join(os.tmpdir(), "mmo-exports")
  };
}
