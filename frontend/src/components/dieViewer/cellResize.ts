import type { AnnotationRect, Cell, CellType, DieAnnotations } from "shared";
import type { Point, Rect } from "../../lib/geometry";
import { boundsForWorldRect, cellWorldRect } from "../../lib/cellFootprint";

export { cellWorldRect } from "../../lib/cellFootprint";

/**
 * Edge-resize of a single placed cell (GIMP-style side handles). Size is a
 * per-instance `Cell.bounds` override in the cell-local canonical frame (the
 * frame the type's layers live in); the type and its content are untouched,
 * and orientation keeps pivoting on the type's `cropRect` box, so layer
 * shapes never move on the die.
 */

export type CellSide = "left" | "right" | "top" | "bottom";

const MIN_CELL_SIZE = 1;

/** `cell` with its `bounds` replaced (dropped when undefined). */
function withBounds(cell: Cell, bounds: AnnotationRect | undefined): Cell {
  const { bounds: _prev, ...rest } = cell;
  return bounds ? { ...rest, bounds } : rest;
}

/** The selected cell + its type, when it's the only selection. */
export function resolveSelectedCell(
  selectedIds: ReadonlySet<string>,
  ann: DieAnnotations | null | undefined
): { cell: Cell; cellType: CellType } | null {
  if (!ann || selectedIds.size !== 1) return null;
  const id = selectedIds.values().next().value as string;
  if (!id.startsWith("cell:")) return null;
  const cell = ann.cells.find((c) => c.id === id.slice(5));
  const cellType = cell && ann.cellTypes.find((t) => t.id === cell.cellTypeId);
  return cell && cellType ? { cell, cellType } : null;
}

/** Side of `r` whose edge is within `tol` of `p` (nearest wins), or null. */
export function cellSideAt(r: Rect, p: Point, tol: number): CellSide | null {
  const inX = p.x >= r.x - tol && p.x <= r.x + r.width + tol;
  const inY = p.y >= r.y - tol && p.y <= r.y + r.height + tol;
  const cands: [CellSide, number, boolean][] = [
    ["left", Math.abs(p.x - r.x), inY],
    ["right", Math.abs(p.x - (r.x + r.width)), inY],
    ["top", Math.abs(p.y - r.y), inX],
    ["bottom", Math.abs(p.y - (r.y + r.height)), inX]
  ];
  let best: CellSide | null = null;
  let bestD = tol;
  for (const [side, d, ok] of cands) {
    if (ok && d <= bestD) {
      best = side;
      bestD = d;
    }
  }
  return best;
}

export const sideCursor = (s: CellSide) =>
  s === "left" || s === "right" ? "ew-resize" : "ns-resize";

/**
 * Resize `cell` alone by dragging its world-space `side` so that edge lands
 * at world coordinate `edgePos` (x for left/right, y for top/bottom). Only
 * the instance's `bounds` change. Returns null for a no-op.
 */
export function resizeCell(
  cell: Cell,
  cellType: CellType,
  side: CellSide,
  edgePos: number
): Cell | null {
  const { width: tw, height: th } = cellType.cropRect;
  const r = cellWorldRect(cell, tw, th);
  const pos = Math.round(edgePos);
  const next: Rect = { ...r };
  if (side === "left") {
    next.x = Math.min(pos, r.x + r.width - MIN_CELL_SIZE);
    next.width = r.x + r.width - next.x;
  } else if (side === "right") {
    next.width = Math.max(pos - r.x, MIN_CELL_SIZE);
  } else if (side === "top") {
    next.y = Math.min(pos, r.y + r.height - MIN_CELL_SIZE);
    next.height = r.y + r.height - next.y;
  } else {
    next.height = Math.max(pos - r.y, MIN_CELL_SIZE);
  }
  if (next.x === r.x && next.y === r.y && next.width === r.width && next.height === r.height) {
    return null;
  }
  return withBounds(cell, boundsForWorldRect(cell, tw, th, next));
}

/**
 * `cell` moved onto `newType` with its world footprint unchanged — changing
 * a cell's type never changes its size. Position is kept, so the new type's
 * content anchors where the old one's did.
 */
export function retypeCellKeepingSize(
  cell: Cell,
  oldType: CellType,
  newType: CellType
): Cell {
  const world = cellWorldRect(cell, oldType.cropRect.width, oldType.cropRect.height);
  const moved: Cell = { ...cell, cellTypeId: newType.id };
  return withBounds(
    moved,
    boundsForWorldRect(moved, newType.cropRect.width, newType.cropRect.height, world)
  );
}
