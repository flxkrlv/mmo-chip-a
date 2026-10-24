import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DieAnnotations, DieSummary } from "shared";
import type { BackendClient } from "../client.js";
import type { McpConfig } from "../config.js";
import {
  MAX_CROP_SIDE,
  cellDieRect,
  clampToDie,
  collectTypeBoxes,
  expandRect,
  limitCropSide,
  type Rect
} from "../footprint.js";
import { InputError, guarded, json, requireFields } from "../result.js";
import {
  resolveOverlaySource,
  type OverlayImageListItem
} from "./overlays.js";

const BASE64_LIMIT_BYTES = 1_500_000;
const CROP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function registerInspectTools(
  server: McpServer,
  client: BackendClient,
  config: McpConfig
): string[] {
  const names: string[] = [];
  const diePath = (dieId: string): string => `/api/dies/${encodeURIComponent(dieId)}`;

  server.registerTool(
    "get_crop",
    {
      title: "Get image crop",
      description:
        "Fetch a JPEG/PNG crop of the die image and write it to disk. Target one of: cellId (the cell's footprint, resolved by the backend), cellTypeId (a type's reference window), or a raw rect x/y/w/h in source pixels (w/h must be ≤ 4096; anything larger is clipped and flagged). `padding` (px, cellId only) expands the cell footprint — computed locally and served through the rect endpoint. `px` asks for a preview limited to that long side instead of full resolution. Pass `overlayId` (id or name from list_overlay_layers, e.g. `sirtl`) to crop an overlay layer composited over the base image; this is the tool that shows whether metal really connects two devices. Returns an absolute file path (plus base64 when asked and the bytes fit), so you can hand the file to any vision tool.",
      inputSchema: {
        dieId: z.string().describe("Project id from list_projects"),
        cellId: z.string().optional().describe("Crop this cell instance's footprint"),
        cellTypeId: z.string().optional().describe("Crop this cell type's reference window"),
        overlayId: z
          .string()
          .optional()
          .describe(
            "Overlay layer id or name from list_overlay_layers (e.g. `sirtl`); omit for the base image"
          ),
        x: z.number().optional().describe("Rect left, source pixels"),
        y: z.number().optional().describe("Rect top, source pixels"),
        w: z.number().optional().describe("Rect width, source pixels (≤ 4096)"),
        h: z.number().optional().describe("Rect height, source pixels (≤ 4096)"),
        padding: z
          .number()
          .int()
          .min(0)
          .max(512)
          .default(0)
          .describe("Pixels added around the cell footprint (cellId only)"),
        px: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Preview mode: keep the long side around this many pixels"),
        encoding: z.enum(["path", "base64"]).default("path")
      }
    },
    async (args) =>
      guarded(async () => {
        const { dieId, cellId, cellTypeId, overlayId, x, y, w, h, padding, px, encoding } = args;
        const rectGiven = [x, y, w, h].some((value) => value !== undefined);
        const targets = [cellId ? "cellId" : null, cellTypeId ? "cellTypeId" : null, rectGiven ? "rect" : null]
          .filter((value): value is string => value !== null);
        if (targets.length !== 1) {
          throw new InputError(
            `get_crop needs exactly one target: cellId, cellTypeId, or the rect fields x/y/w/h ` +
              `(got ${targets.length === 0 ? "none" : targets.join(", ")})`
          );
        }

        let overlay: OverlayImageListItem | undefined;
        if (overlayId && overlayId !== "__base__") {
          overlay = await resolveOverlaySource(client, dieId, overlayId);
        }

        const notes: string[] = [];
        const query: string[] = [];
        if (overlay) query.push(`overlaySourceId=${encodeURIComponent(overlay.id)}`);
        if (px !== undefined) query.push(`px=${px}`);
        let rect: Rect | undefined;
        let url: string;
        let stem: string;

        if (cellId) {
          if (padding > 0) {
            const die = await client.getJson<DieSummary>(diePath(dieId));
            const annotations = await client.getJson<DieAnnotations>(`${diePath(dieId)}/annotations`);
            const cell = annotations.cells.find((candidate) => candidate.id === cellId);
            if (!cell) throw new InputError(`Cell "${cellId}" not found in this die's annotations`);
            const boxes = await collectTypeBoxes(client, die, annotations);
            const box = boxes.get(cell.cellTypeId);
            if (!box) {
              throw new InputError(
                `Cell type "${cell.cellTypeId}" could not be resolved for "${cellId}". ` +
                  `Retry without padding to let the backend resolve it.`
              );
            }
            const footprint = cellDieRect(cell, box.width, box.height);
            const limited = limitCropSide(clampToDie(expandRect(footprint, padding), die));
            rect = limited.rect;
            if (limited.clipped) {
              notes.push(`crop clamped to the die and to at most ${MAX_CROP_SIDE}px per side`);
            }
            url = `${diePath(dieId)}/crop?x=${rect.x}&y=${rect.y}&w=${rect.width}&h=${rect.height}`;
            stem = rectStem(dieId, rect, px, overlay?.id);
          } else {
            url = `${diePath(dieId)}/cells/${encodeURIComponent(cellId)}/crop`;
            stem = targetStem(dieId, "cell", cellId, px, overlay?.id);
          }
        } else if (cellTypeId) {
          if (padding > 0) notes.push("padding is ignored for cellTypeId; use a rect target");
          url = `${diePath(dieId)}/cell-types/${encodeURIComponent(cellTypeId)}/crop`;
          stem = targetStem(dieId, "type", cellTypeId, px, overlay?.id);
        } else {
          requireFields("get_crop rect", { x, y, w, h }, ["x", "y", "w", "h"]);
          rect = { x: x!, y: y!, width: w!, height: h! };
          const limited = limitCropSide(rect);
          rect = limited.rect;
          if (limited.clipped) notes.push(`cropped to ${MAX_CROP_SIDE}px per side (backend limit)`);
          url =
            `${diePath(dieId)}/crop?x=${Math.round(rect.x)}&y=${Math.round(rect.y)}` +
            `&w=${Math.round(rect.width)}&h=${Math.round(rect.height)}`;
          stem = rectStem(dieId, rect, px, overlay?.id);
        }
        if (query.length > 0) url += (url.includes("?") ? "&" : "?") + query.join("&");

        const raw = await client.getRaw(url);
        const extension = imageExtension(raw.contentType);
        await fs.mkdir(config.cropsDir, { recursive: true });
        const file = path.join(config.cropsDir, `${stem}.${extension}`);
        await fs.writeFile(file, raw.data);

        const payload: Record<string, unknown> = {
          path: file,
          bytes: raw.data.length,
          contentType: raw.contentType,
          dieId
        };
        if (cellId) payload.cellId = cellId;
        if (cellTypeId) payload.cellTypeId = cellTypeId;
        if (overlay) {
          payload.overlayId = overlay.id;
          payload.overlayName = overlay.name;
        }
        if (rect) payload.rect = rect;
        if (encoding === "base64") {
          if (raw.data.length <= BASE64_LIMIT_BYTES) {
            payload.base64 = raw.data.toString("base64");
          } else {
            notes.push(`too large for base64 (${raw.data.length} bytes); use the path`);
          }
        }
        if (notes.length > 0) payload.notes = notes;
        return json(payload);
      })
  );
  names.push("get_crop");

  server.registerTool(
    "get_metal_stack",
    {
      title: "Get metal stack",
      description:
        "The die's interconnect stack: metal levels (id, layer name, z order, colour) and via levels, plus the defaults used when drawing and exporting wires. Falls back to the built-in default stack when the project has none configured. Read-only.",
      inputSchema: { dieId: z.string() }
    },
    async ({ dieId }) =>
      guarded(async () => {
        const stack = await client.getJson<unknown>(`${diePath(dieId)}/metal-stack`);
        return json(stack);
      })
  );
  names.push("get_metal_stack");

  server.registerTool(
    "get_spice_config",
    {
      title: "Get SPICE config",
      description:
        "The saved SPICE technology configuration for the project (model library options, tolerances) used by analog extraction/export. Empty object {} when never saved. Read-only.",
      inputSchema: { dieId: z.string() }
    },
    async ({ dieId }) =>
      guarded(async () => {
        const config = await client.getJson<unknown>(`${diePath(dieId)}/spice-config`);
        return json(config);
      })
  );
  names.push("get_spice_config");

  server.registerTool(
    "get_analog_devices",
    {
      title: "Get analog device names",
      description:
        "The project's analog device name store: device name → geometry, the names netlist export prints beside devices. Defaults to { version: 1, devices: {} }. Read-only.",
      inputSchema: { dieId: z.string() }
    },
    async ({ dieId }) =>
      guarded(async () => {
        const devices = await client.getJson<unknown>(`${diePath(dieId)}/analog-devices`);
        return json(devices);
      })
  );
  names.push("get_analog_devices");

  return names;
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

function pxSuffix(px: number | undefined): string {
  return px === undefined ? "" : `_px${px}`;
}

function overlaySuffix(overlayId: string | undefined): string {
  return overlayId ? `_ov-${safe(overlayId)}` : "";
}

function rectStem(
  dieId: string,
  rect: Rect,
  px: number | undefined,
  overlayId: string | undefined
): string {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  return `crop_${safe(dieId)}_${x}_${y}_${w}x${h}${pxSuffix(px)}${overlaySuffix(overlayId)}`;
}

function targetStem(
  dieId: string,
  kind: "cell" | "type",
  targetId: string,
  px: number | undefined,
  overlayId: string | undefined
): string {
  return `crop_${safe(dieId)}_${kind}_${safe(targetId)}${pxSuffix(px)}${overlaySuffix(overlayId)}`;
}

/** Drop crops older than 24h so the directory cannot grow without bound. */
export async function cleanupCrops(dir: string, now = Date.now()): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile() && now - stat.mtimeMs > CROP_MAX_AGE_MS) {
        await fs.rm(file, { force: true });
        removed += 1;
      }
    } catch {
      // A file that vanished mid-sweep is fine.
    }
  }
  return removed;
}
