import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DieAnnotations, DieSummary } from "shared";
import type { BackendClient } from "../client.js";
import { cellDieRect, collectTypeBoxes, type Rect } from "../footprint.js";
import { guarded, json } from "../result.js";

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

function intersects(a: Rect, b: Region): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function pointInside(x: number, y: number, region: Region): boolean {
  return x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height;
}

function pointsBBox(points: Array<{ x: number; y: number }>): Rect | null {
  if (points.length === 0) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  };
}

/**
 * Answer "what is inside this rectangle?" without pulling the whole 86-net /
 * 96-cell annotation store into the agent's context. Useful for block-level
 * reverse engineering: pick a floorplan or a suspicious region, then inspect
 * only its cells, nets, pins and comments.
 */
export function registerRegionTools(
  server: McpServer,
  client: BackendClient
): string[] {
  const names: string[] = [];
  const diePath = (dieId: string): string => `/api/dies/${encodeURIComponent(dieId)}`;

  server.registerTool(
    "get_region_summary",
    {
      title: "Summarize a region",
      description:
        "Spatial query over a die rectangle in source pixels: returns the cells (with their computed " +
        "die rect), wire nets and their bounding boxes, I/O pins, comments, floorplan regions and " +
        "rulers that intersect the rect. This is the cheap way to inspect one functional block " +
        "without reading all annotations. `limit` caps each collection (default 200, max 500). " +
        "Use a floorplan's geometry or a device crop to pick the rect, then read only what is there.",
      inputSchema: {
        dieId: z.string().describe("Project id from list_projects"),
        x: z.number().describe("Left, source pixels"),
        y: z.number().describe("Top, source pixels"),
        w: z.number().positive().describe("Width, source pixels"),
        h: z.number().positive().describe("Height, source pixels"),
        limit: z.number().int().min(1).max(500).default(200)
      }
    },
    async ({ dieId, x, y, w, h, limit }) =>
      guarded(async () => {
        const [die, annotations] = await Promise.all([
          client.getJson<DieSummary>(diePath(dieId)),
          client.getJson<DieAnnotations>(`${diePath(dieId)}/annotations`)
        ]);
        const region: Region = { x, y, width: w, height: h };
        const boxes = await collectTypeBoxes(client, die, annotations);

        const cells = annotations.cells.flatMap((cell) => {
          const box = boxes.get(cell.cellTypeId);
          const rect = box ? cellDieRect(cell, box.width, box.height) : null;
          const inside = rect
            ? intersects(rect, region)
            : pointInside(cell.x, cell.y, region);
          if (!inside) return [];
          return [
            {
              id: cell.id,
              cellTypeId: cell.cellTypeId,
              ...(cell.cellTypeDieId ? { cellTypeDieId: cell.cellTypeDieId } : {}),
              x: cell.x,
              y: cell.y,
              ...(cell.rotation ? { rotation: cell.rotation } : {}),
              rect
            }
          ];
        });

        const nets = annotations.nets
          .map((net) => {
            const bbox = pointsBBox(net.nodes);
            return {
              id: net.id,
              name: net.name,
              nodeCount: net.nodes.length,
              edgeCount: net.edges.length,
              bbox: bbox ?? null
            };
          })
          .filter((net) => net.bbox !== null && intersects(net.bbox, region));

        const pins = (annotations.pins ?? [])
          .filter((pin) => pointInside(pin.x, pin.y, region))
          .map((pin) => ({ id: pin.id, name: pin.name, pin: pin.pin, x: pin.x, y: pin.y }));

        const comments = (annotations.comments ?? [])
          .filter((comment) => pointInside(comment.x, comment.y, region))
          .map((comment) => ({
            id: comment.id,
            x: comment.x,
            y: comment.y,
            text: comment.text,
            authorName: comment.authorName
          }));

        const floorplans = (annotations.floorplanRegions ?? [])
          .map((regionItem) => ({
            id: regionItem.id,
            name: regionItem.name,
            kind: regionItem.kind,
            color: regionItem.color,
            bbox: pointsBBox(regionItem.geometry)
          }))
          .filter((item) => item.bbox !== null && intersects(item.bbox, region));

        const rulers = (annotations.rulers ?? [])
          .map((ruler) => {
            const bbox = pointsBBox([
              { x: ruler.x1, y: ruler.y1 },
              { x: ruler.x2, y: ruler.y2 }
            ]);
            return {
              id: ruler.id,
              ...(ruler.name ? { name: ruler.name } : {}),
              x1: ruler.x1,
              y1: ruler.y1,
              x2: ruler.x2,
              y2: ruler.y2,
              lengthPx: ruler.lengthPx,
              lengthUm: ruler.lengthUm,
              bbox
            };
          })
          .filter((ruler) => ruler.bbox !== null && intersects(ruler.bbox, region));

        const truncated = {
          cells: cells.length > limit,
          nets: nets.length > limit,
          pins: pins.length > limit,
          comments: comments.length > limit,
          floorplans: floorplans.length > limit,
          rulers: rulers.length > limit
        };
        return json({
          dieId,
          rev: annotations.rev,
          region,
          counts: {
            cells: cells.length,
            nets: nets.length,
            pins: pins.length,
            comments: comments.length,
            floorplans: floorplans.length,
            rulers: rulers.length
          },
          cells: cells.slice(0, limit),
          nets: nets.slice(0, limit),
          pins: pins.slice(0, limit),
          comments: comments.slice(0, limit),
          floorplans: floorplans.slice(0, limit),
          rulers: rulers.slice(0, limit),
          ...(Object.values(truncated).some(Boolean)
            ? { truncated, limitHint: `raise limit (max 500) or split the region` }
            : {})
        });
      })
  );
  names.push("get_region_summary");

  return names;
}
