import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DieSummary } from "shared";
import type { BackendClient } from "../client.js";
import type { McpConfig } from "../config.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { guarded, json } from "../result.js";

const EXPORT_TIMEOUT_MS = 600_000;

export function registerProjectTools(
  server: McpServer,
  client: BackendClient,
  config: McpConfig
): string[] {
  const names: string[] = [];

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List every die project (chip) stored in this MMO Chip instance: id, name, image size in source pixels, cell library and scale, storage location and whether its files are present. Start here: the returned ids are the dieId values every other tool expects.",
      inputSchema: {}
    },
    async () =>
      guarded(async () => {
        const dies = await client.getJson<DieSummary[]>("/api/dies");
        return json(dies.map(projectSummary));
      })
  );
  names.push("list_projects");

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description:
        "Full record for one die project: name, image geometry (width/height/maxZoomLevel/tileSize), cell library + cellScale, import timestamps, tile build progress, location (managed or folder) and availability. Read-only; dies are created by importing an image, not by MCP.",
      inputSchema: {
        dieId: z.string().describe("Project id from list_projects")
      }
    },
    async ({ dieId }) =>
      guarded(async () => {
        const die = await client.getJson<DieSummary>(`/api/dies/${encodeURIComponent(dieId)}`);
        return json(die);
      })
  );
  names.push("get_project");

  server.registerTool(
    "export_project",
    {
      title: "Export project ZIP",
      description:
        "Export a project as a portable ZIP (annotations, metadata, images). mode light = annotations + metadata, mode full = also images (large). The ZIP is written to disk and its absolute path is returned; without outPath it lands in the server's export directory (OS temp / mmo-exports). preferences / deviceRegistry / analogNames are the versioned JSON blobs an export may embed; omit them unless you already hold the exact JSON text.",
      inputSchema: {
        dieId: z.string().describe("Project id from list_projects"),
        mode: z.enum(["light", "full"]).default("light"),
        outPath: z
          .string()
          .optional()
          .describe("Target file path; a directory is created if missing"),
        preferences: z.string().nullish().describe("Raw JSON text stored as preferences.json"),
        deviceRegistry: z
          .string()
          .nullish()
          .describe("Raw JSON text stored as device-registry.json"),
        analogNames: z.string().nullish().describe("Raw JSON text stored as analog-names.json")
      }
    },
    async ({ dieId, mode, outPath, preferences, deviceRegistry, analogNames }) =>
      guarded(async () => {
        const body = {
          mode,
          ...(preferences === undefined ? {} : { preferences }),
          ...(deviceRegistry === undefined ? {} : { deviceRegistry }),
          ...(analogNames === undefined ? {} : { analogNames })
        };
        const raw = await client.postRaw(
          `/api/dies/${encodeURIComponent(dieId)}/export-project`,
          body,
          EXPORT_TIMEOUT_MS
        );
        const filename = raw.filename ?? `mmochip-${dieId}-${mode}.zip`;
        const target = outPath
          ? path.resolve(outPath)
          : path.join(config.exportDir, filename);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, raw.data);
        return json({ path: target, bytes: raw.data.length, filename, mode });
      })
  );
  names.push("export_project");

  return names;
}

function projectSummary(die: DieSummary): Record<string, unknown> {
  return {
    id: die.id,
    name: die.name,
    originalFilename: die.originalFilename,
    width: die.width,
    height: die.height,
    tileSize: die.tileSize,
    maxZoomLevel: die.maxZoomLevel,
    cellLibrary: die.cellLibrary ?? null,
    cellScale: die.cellScale ?? null,
    location: die.location ?? "managed",
    available: die.available ?? true,
    ...(die.folderPath ? { folderPath: die.folderPath } : {}),
    createdAt: die.createdAt,
    updatedAt: die.updatedAt
  };
}
