import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BackendClient, type FetchLike } from "../src/client.js";
import type { McpConfig } from "../src/config.js";
import { buildServer } from "../src/build.js";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

export function recordingFetch(route: Route): {
  impl: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const impl: FetchLike = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined
    });
    return await route(url, init);
  };
  return { impl, requests };
}

export function testConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    baseUrl: "http://mmo.test:3001",
    token: undefined,
    agentName: "test-agent",
    cropsDir: path.join(os.tmpdir(), `mmo-crops-test-${process.pid}`),
    exportDir: path.join(os.tmpdir(), `mmo-exports-test-${process.pid}`),
    ...overrides
  };
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export async function connect(config: McpConfig, impl: FetchLike) {
  const backend = new BackendClient(config, impl);
  const built = buildServer(config, backend);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "mcp-test", version: "0.0.0" });
  await Promise.all([built.server.connect(serverTransport), mcp.connect(clientTransport)]);
  return {
    tools: built.tools,
    async list(): Promise<string[]> {
      return (await mcp.listTools()).tools.map((tool) => tool.name).sort();
    },
    async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
      return await mcp.callTool({ name, arguments: args });
    },
    async close(): Promise<void> {
      await mcp.close();
      await built.server.close();
    }
  };
}

export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((entry) => entry.text ?? "").join("\n");
}

export function isErrorResult(result: unknown): boolean {
  return Boolean((result as { isError?: boolean })?.isError);
}

export function jsonResult<T>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}
