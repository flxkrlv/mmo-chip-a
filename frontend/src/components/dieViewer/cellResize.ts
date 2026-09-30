import type { Cell, CellLayers, CellType, DieAnnotations, LayerShape } from "shared";
import type { AnnotationAction } from "../../api/actions";
import { applyOrientation, type Point, type Rect } from "../../lib/geometry";
import { boundsForWorldRect, cellWorldRect, withBounds } from "../../lib/cellFootprint";

export { cellWorldRect } from "../../lib/cellFootprint";

/**
 * Edge-resize of placed cells (GIMP-style side handles). Dragging a side of
 * one cell resizes its *type* — every linked instance gets the same die-axis
 * change, which keeps them aligned — while content stays put on the die.
 * Footprints are die-axis rects (see lib/cellFootprint.ts).
 */

export type CellSide = "left" | "right" | "top" | "bottom";

const MIN_CELL_SIZE = 1;

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

export interface CellTypeResize {
  cellType: CellType;
  prevCellType: CellType;
  /** Every instance of the type, updated. */
  cells: { cell: Cell; prevCell: Cell }[];
}

function shiftShape(s: LayerShape, dx: number, dy: number): LayerShape {
  switch (s.kind) {
    case "rect":
    case "point":
    case "circle":
      return { ...s, x: s.x + dx, y: s.y + dy };
    case "line":
      return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
    case "polygon":
      return { ...s, points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
}

function shiftLayers(layers: CellLayers | undefined, dx: number, dy: number) {
  if (!layers || (dx === 0 && dy === 0)) return layers;
  const out: CellLayers = {};
  for (const [k, shapes] of Object.entries(layers) as [keyof CellLayers, LayerShape[] | undefined][]) {
    out[k] = shapes?.map((sh) => shiftShape(sh, dx, dy));
  }
  return out;
}

/**
 * Resize `cell`'s whole type by dragging its die-space `side` so that edge
 * lands at die coordinate `edgePos` (x for left/right, y for top/bottom).
 * Every instance's footprint grows by the same die-axis amount on that side
 * (keeps linked cells aligned). Content stays put on the die: growing on the
 * left/top shifts the type-local layers, and each instance's origin is
 * re-solved for its own orientation, with `bounds` absorbing any difference
 * so the footprint lands exactly. Returns null for a no-op.
 */
export function resizeCellType(
  ann: DieAnnotations,
  cell: Cell,
  cellType: CellType,
  side: CellSide,
  edgePos: number
): CellTypeResize | null {
  const { width: w, height: h } = cellType.cropRect;
  const r = cellWorldRect(cell, w, h);
  // Outward growth of the dragged edge, clamped so neither the dragged cell
  // nor the type box collapses below the minimum size.
  const horizontal = side === "left" || side === "right";
  let grow = Math.round(
    side === "left" ? r.x - edgePos
    : side === "right" ? edgePos - (r.x + r.width)
    : side === "top" ? r.y - edgePos
    : edgePos - (r.y + r.height)
  );
  grow = Math.max(grow, MIN_CELL_SIZE - Math.min(horizontal ? r.width : r.height, horizontal ? w : h));
  if (grow === 0) return null;

  const g = { left: 0, right: 0, top: 0, bottom: 0 };
  g[side] = grow;
  const nw = w + g.left + g.right;
  const nh = h + g.top + g.bottom;
  const nextType: CellType = {
    ...cellType,
    cropRect: { ...cellType.cropRect, width: nw, height: nh },
    layers: shiftLayers(cellType.layers, g.left, g.top)
  };

  // Content world pos is origin + c + M(p - c) with c the type-box centre.
  // Layers shift by t = (left, top) and c by Δc, so keeping it fixed needs
  // origin' = origin - Δc + M(Δc - t) = origin - Δc + M((right-left)/2, (bottom-top)/2).
  const dcx = (g.left + g.right) / 2;
  const dcy = (g.top + g.bottom) / 2;
  const cells = ann.cells
    .filter((c) => c.cellTypeId === cellType.id)
    .map((c) => {
      const m = applyOrientation({ x: (g.right - g.left) / 2, y: (g.bottom - g.top) / 2 }, c, 0, 0);
      const moved: Cell = {
        ...c,
        x: Math.round(c.x - dcx + m.x),
        y: Math.round(c.y - dcy + m.y)
      };
      const fp = cellWorldRect(c, w, h);
      const nextFp: Rect = {
        x: fp.x - g.left,
        y: fp.y - g.top,
        width: fp.width + g.left + g.right,
        height: fp.height + g.top + g.bottom
      };
      return {
        prevCell: c,
        cell: withBounds(moved, boundsForWorldRect(moved, nw, nh, nextFp))
      };
    });
  return { cellType: nextType, prevCellType: cellType, cells };
}

export function cellTypeResizeAction(res: CellTypeResize): AnnotationAction {
  return {
    kind: "batch",
    actions: [
      { kind: "upsertCellType", cellType: res.cellType, prevCellType: res.prevCellType },
      ...res.cells.map(
        ({ cell, prevCell }): AnnotationAction => ({ kind: "upsertCell", cell, prevCell })
      )
    ]
  };
}
