import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DieSummary, OverlayTileSourceProgress } from "shared";
import type { BackendClient } from "../client.js";
import type { McpConfig } from "../config.js";
import { InputError, guarded, json } from "../result.js";

const BASE64_LIMIT_BYTES = 1_500_000;
const PREVIEW_MAX_SIDE = 4096;

/** Shape of one item from `GET /api/dies/:dieId/overlay-images/list`. */
export interface OverlayImageListItem {
  id: string;
  name: string;
  originalFilename: string;
  size: number;
  width: number;
  height: number;
  tileSize: number;
  tileFormat: "jpg" | "png";
  hasAlpha: boolean;
  maxZoomLevel: number;
  ready: boolean;
  createdAt: string;
  updatedAt: string;
  purpose?: string | null;
  explicitPurpose?: string | null;
  purposeSource?: "user" | "auto" | "none";
  suggestedPurpose?: string | null;
  purposeEditable?: boolean;
  legacy?: boolean;
}

interface OverlayListResponse {
  images?: OverlayImageListItem[];
}

export async function listOverlayImages(
  client: BackendClient,
  dieId: string
): Promise<OverlayImageListItem[]> {
  const response = await client.getJson<OverlayListResponse>(
    `/api/dies/${encodeURIComponent(dieId)}/overlay-images/list`
  );
  return Array.isArray(response.images) ? response.images : [];
}

/**
 * Resolve a layer the way an agent names it: by id or by case-insensitive
 * display name (e.g. `sirtl`). The base image is handled by the caller.
 */
export async function resolveOverlaySource(
  client: BackendClient,
  dieId: string,
  value: string
): Promise<OverlayImageListItem> {
  const images = await listOverlayImages(client, dieId);
  const needle = value.trim();
  const match =
    images.find((image) => image.id === needle) ??
    images.find((image) => image.name.toLowerCase() === needle.toLowerCase());
  if (!match) {
    const available = images.length
      ? images.map((image) => `${image.id} (${image.name})`).join(", ")
      : "none";
    throw new InputError(
      `Overlay layer "${value}" not found on die "${dieId}". Available overlays: ${available}. ` +
        `Call list_overlay_layers to get the current ids and names.`
    );
  }
  return match;
}

function imageExtension(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  return "bin";
}

function safe(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned;
}

interface SavedImage {
  path: string;
  bytes: number;
  contentType: string;
}

async function saveImage(
  client: BackendClient,
  config: McpConfig,
  url: string,
  stem: string
): Promise<{ saved: SavedImage; data: Buffer }> {
  const raw = await client.getRaw(url);
  const extension = imageExtension(raw.contentType);
  await fs.mkdir(config.cropsDir, { recursive: true });
  const file = path.join(config.cropsDir, `${stem}.${extension}`);
  await fs.writeFile(file, raw.data);
  return {
    saved: { path: file, bytes: raw.data.length, contentType: raw.contentType },
    data: raw.data
  };
}

function withBase64(
  saved: SavedImage,
  data: Buffer,
  encoding: "path" | "base64",
  notes: string[]
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...saved };
  if (encoding === "base64") {
    if (data.length <= BASE64_LIMIT_BYTES) {
      payload.base64 = data.toString("base64");
    } else {
      notes.push(`too large for base64 (${data.length} bytes); use the path`);
    }
  }
  return payload;
}

/** Layer list with the base image first, then every uploaded overlay. */
export function registerOverlayTools(
  server: McpServer,
  client: BackendClient,
  config: McpConfig
): string[] {
  const names: string[] = [];
  const diePath = (dieId: string): string => `/api/dies/${encodeURIComponent(dieId)}`;

  server.registerTool(
    "list_overlay_layers",
    {
      title: "List image layers",
      description:
        "List the die's image layers: the base photograph (id `__base__`) plus every overlay source " +
        "(for example `sirtl`, a developed-silicon image, or a metal layer). Returns each layer's " +
        "id, display name, pixel size, tile format, purpose (`purpose`, `purposeSource` = user/auto/none, " +
        "`suggestedPurpose`) and tile-build progress. `sirtl` auto-detects as diffusion, `me1` as metal1; " +
        "a layer with no match reports `purposeSource:none`, so an absent purpose is explicit rather than guessed. " +
        "Pass the id or name as `overlayId` to get_crop, or to get_overlay_image, to inspect that layer. " +
        "This is the read tool to call before claiming that a wire is or is not connected: crops of a metal layer show " +
        "the actual metal, which the base photograph may hide.",
      inputSchema: {
        dieId: z.string().describe("Project id from list_projects")
      }
    },
    async ({ dieId }) =>
      guarded(async () => {
        const [die, images] = await Promise.all([
          client.getJson<DieSummary>(diePath(dieId)),
          listOverlayImages(client, dieId)
        ]);
        const progressById = new Map<string, OverlayTileSourceProgress>();
        for (const source of die.overlayTileProgress?.sources ?? []) {
          progressById.set(source.id, source);
        }
        const layers: Array<Record<string, unknown>> = [
          {
            id: "__base__",
            name: "base image",
            kind: "base",
            width: die.width,
            height: die.height,
            tileSize: die.tileSize,
            maxZoomLevel: die.maxZoomLevel,
            ready: true,
            tileProgress: null
          },
          ...images.map((image) => {
            const progress =
              progressById.get(image.id) ??
              [...progressById.values()].find((source) => source.name === image.name);
            return {
              id: image.id,
              name: image.name,
              kind: "overlay",
              originalFilename: image.originalFilename,
              width: image.width,
              height: image.height,
              tileSize: image.tileSize,
              tileFormat: image.tileFormat,
              hasAlpha: image.hasAlpha,
              maxZoomLevel: image.maxZoomLevel,
              legacy: Boolean(image.legacy),
              ready: image.ready,
              purpose: image.purpose ?? null,
              explicitPurpose: image.explicitPurpose ?? null,
              purposeSource: image.purposeSource ?? "none",
              suggestedPurpose: image.suggestedPurpose ?? null,
              purposeEditable: image.purposeEditable ?? !image.legacy,
              createdAt: image.createdAt,
              updatedAt: image.updatedAt,
              tileProgress: progress ?? null
            };
          })
        ];
        return json({
          dieId,
          width: die.width,
          height: die.height,
          count: layers.length,
          layers,
          hint:
            "Use overlayId (id or name) with get_crop for a cell/type/rect, or get_overlay_image " +
            "for a full-layer preview. The base image is __base__."
        });
      })
  );
  names.push("list_overlay_layers");

  server.registerTool(
    "get_die_image",
    {
      title: "Get die image",
      description:
        "Fetch a full-die preview of the base photograph (the backend caches a JPEG whose longest " +
        "side is at most 4096 px) and write it to disk. Use this for a cheap overview before " +
        "requesting full-resolution crops; use get_crop for measurements or device detail. Returns " +
        "an absolute file path, byte count and the die's source-pixel dimensions. Not a layer crop: " +
        "for an overlay layer use get_overlay_image or get_crop with overlayId.",
      inputSchema: {
        dieId: z.string().describe("Project id from list_projects"),
        encoding: z.enum(["path", "base64"]).default("path")
      }
    },
    async ({ dieId, encoding }) =>
      guarded(async () => {
        const die = await client.getJson<DieSummary>(diePath(dieId));
        const stem = `die-${safe(dieId)}-preview`;
        const { saved, data } = await saveImage(
          client,
          config,
          `${diePath(dieId)}/image`,
          stem
        );
        const notes = [
          `preview: longest side <= ${PREVIEW_MAX_SIDE}px; use get_crop with x/y/w/h for native detail`
        ];
        return json({
          dieId,
          kind: "die",
          width: die.width,
          height: die.height,
          previewMaxSide: PREVIEW_MAX_SIDE,
          ...withBase64(saved, data, encoding, notes),
          notes
        });
      })
  );
  names.push("get_die_image");

  server.registerTool(
    "get_overlay_image",
    {
      title: "Get overlay layer image",
      description:
        "Fetch a full-layer preview of one overlay image (for example `sirtl`, developed silicon) " +
        "and write it to disk. The backend serves a cached JPEG whose longest side is at most " +
        "4096 px; use get_crop with overlayId for native-resolution detail. Resolves overlayId by " +
        "id or by display name. Returns the layer metadata, absolute path and byte count.",
      inputSchema: {
        dieId: z.string().describe("Project id from list_projects"),
        overlayId: z
          .string()
          .describe("Overlay id or name from list_overlay_layers (e.g. a sirtl id or `sirtl`)"),
        encoding: z.enum(["path", "base64"]).default("path")
      }
    },
    async ({ dieId, overlayId, encoding }) =>
      guarded(async () => {
        const overlay = await resolveOverlaySource(client, dieId, overlayId);
        const stem = `overlay-${safe(overlay.id)}-preview`;
        const { saved, data } = await saveImage(
          client,
          config,
          `${diePath(dieId)}/overlay-images/${encodeURIComponent(overlay.id)}/original`,
          stem
        );
        const notes = [
          `preview: longest side <= ${PREVIEW_MAX_SIDE}px; use get_crop with overlayId for native detail`
        ];
        return json({
          dieId,
          kind: "overlay",
          overlayId: overlay.id,
          overlayName: overlay.name,
          width: overlay.width,
          height: overlay.height,
          tileFormat: overlay.tileFormat,
          hasAlpha: overlay.hasAlpha,
          previewMaxSide: PREVIEW_MAX_SIDE,
          ...withBase64(saved, data, encoding, notes),
          notes
        });
      })
  );
  names.push("get_overlay_image");

  return names;
}
