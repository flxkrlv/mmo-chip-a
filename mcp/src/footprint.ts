import type { Cell, CellType, DieAnnotations, DieSummary } from "shared";
import type { BackendClient } from "./client.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The backend rejects crop sides above this (`GET /api/dies/:dieId/crop`). */
export const MAX_CROP_SIDE = 4096;

/**
 * A placed cell's footprint on the die. Port of the backend's `cellDieRect`
 * (tiles.ts) so summaries agree with the region the crop endpoints serve:
 * the type box mirrored, then rotated clockwise about the type-box centre,
 * placed at the cell origin. A 90°/270° cell of a W×H type covers H×W.
 */
export function cellDieRect(
  cell: Pick<Cell, "x" | "y" | "bounds" | "flippedH" | "flippedV" | "rotation">,
  typeW: number,
  typeH: number
): Rect {
  const box = cell.bounds ?? { x: 0, y: 0, width: typeW, height: typeH };
  const map = (px: number, py: number): [number, number] => {
    let qx = px - typeW / 2;
    let qy = py - typeH / 2;
    if (cell.flippedH) qx = -qx;
    if (cell.flippedV) qy = -qy;
    switch (cell.rotation ?? 0) {
      case 90:
        [qx, qy] = [-qy, qx];
        break;
      case 180:
        [qx, qy] = [-qx, -qy];
        break;
      case 270:
        [qx, qy] = [qy, -qx];
        break;
    }
    return [qx + typeW / 2, qy + typeH / 2];
  };
  const [ax, ay] = map(box.x, box.y);
  const [bx, by] = map(box.x + box.width, box.y + box.height);
  return {
    x: cell.x + Math.min(ax, bx),
    y: cell.y + Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay)
  };
}

export function expandRect(rect: Rect, padding: number): Rect {
  if (padding <= 0) return rect;
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2
  };
}

export function clampToDie(
  rect: Rect,
  die: { width: number; height: number }
): Rect {
  const x = Math.max(0, Math.min(Math.round(rect.x), die.width - 1));
  const y = Math.max(0, Math.min(Math.round(rect.y), die.height - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(rect.width), die.width - x)),
    height: Math.max(1, Math.min(Math.round(rect.height), die.height - y))
  };
}

export function limitCropSide(
  rect: Rect
): { rect: Rect; clipped: boolean } {
  const width = Math.min(rect.width, MAX_CROP_SIDE);
  const height = Math.min(rect.height, MAX_CROP_SIDE);
  return {
    rect: { ...rect, width, height },
    clipped: width !== rect.width || height !== rect.height
  };
}

function cellScaleOf(die: Pick<DieSummary, "cellScale"> | null | undefined): number {
  const scale = die?.cellScale;
  return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * Type boxes keyed by id, in this die's pixels: the die's own types, plus the
 * ones its cells take from other dies (`cellTypeDieId`), scaled by the two
 * dies' `cellScale` ratio exactly like the backend resolves them. Types only
 * reachable through a library scan are left out — a cell using one simply
 * gets no `rect`.
 */
export async function collectTypeBoxes(
  client: BackendClient,
  die: Pick<DieSummary, "id" | "cellScale">,
  annotations: DieAnnotations
): Promise<Map<string, Rect>> {
  const boxes = new Map<string, Rect>();
  for (const type of annotations.cellTypes) boxes.set(type.id, typeBox(type, 1));
  const owners = new Set<string>();
  for (const cell of annotations.cells) {
    if (cell.cellTypeDieId && cell.cellTypeDieId !== die.id && !boxes.has(cell.cellTypeId)) {
      owners.add(cell.cellTypeDieId);
    }
  }
  for (const ownerId of owners) {
    try {
      const owner = await client.getJson<DieSummary>(
        `/api/dies/${encodeURIComponent(ownerId)}`
      );
      const ownerAnnotations = await client.getJson<DieAnnotations>(
        `/api/dies/${encodeURIComponent(ownerId)}/annotations`
      );
      const ratio = cellScaleOf(die) / cellScaleOf(owner);
      for (const type of ownerAnnotations.cellTypes) {
        if (!boxes.has(type.id)) boxes.set(type.id, typeBox(type, ratio));
      }
    } catch {
      // Deleted or unreadable owner: instances of its types stay rect-less.
    }
  }
  return boxes;
}

export function cellRect(cell: Cell, boxes: Map<string, Rect>): Rect | undefined {
  const box = boxes.get(cell.cellTypeId);
  if (!box) return undefined;
  return cellDieRect(cell, box.width, box.height);
}

function typeBox(type: CellType, ratio: number): Rect {
  return {
    x: 0,
    y: 0,
    width: Math.round(type.cropRect.width * ratio * 1e6) / 1e6,
    height: Math.round(type.cropRect.height * ratio * 1e6) / 1e6
  };
}
