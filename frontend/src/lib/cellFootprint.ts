import type { AnnotationRect, Cell } from "shared";
import { applyOrientation, polygonBounds, type Rect } from "./geometry";

/**
 * A placed cell's footprint. By default it is its type's `cropRect` box; a
 * per-instance `Cell.bounds` (cell-local canonical frame, same as the type's
 * layers) overrides it. Orientation always pivots on the *type* box centre,
 * so resizing an instance never moves its content on the die.
 */

/** Cell-local footprint: the instance override, else the type's box. */
export function cellBox(cell: Cell, typeW: number, typeH: number): AnnotationRect {
  return cell.bounds ?? { x: 0, y: 0, width: typeW, height: typeH };
}

/** World AABB of a placed cell's footprint (`typeW/H` = its type's cropRect). */
export function cellWorldRect(cell: Cell, typeW: number, typeH: number): Rect {
  const b = cellBox(cell, typeW, typeH);
  const r = polygonBounds(
    [
      { x: b.x, y: b.y },
      { x: b.x + b.width, y: b.y },
      { x: b.x + b.width, y: b.y + b.height },
      { x: b.x, y: b.y + b.height }
    ].map((p) => applyOrientation(p, cell, typeW, typeH))
  ) ?? { x: 0, y: 0, width: b.width, height: b.height };
  return { x: cell.x + r.x, y: cell.y + r.y, width: r.width, height: r.height };
}

/**
 * Cell-local `bounds` that put `cell`'s footprint at world rect `r` for a
 * type of size `typeW×typeH` (inverse of `cellWorldRect`). Undefined when it
 * equals the type's own box, so untouched cells stay override-free.
 */
export function boundsForWorldRect(
  cell: Cell,
  typeW: number,
  typeH: number,
  r: Rect
): AnnotationRect | undefined {
  // Orientation is a 90°-step rotation + mirrors: an orthonormal M, so the
  // canonical centre offset is Mᵀ·(world centre offset from the pivot).
  const cx = r.x + r.width / 2 - cell.x - typeW / 2;
  const cy = r.y + r.height / 2 - cell.y - typeH / 2;
  const ex = applyOrientation({ x: 1, y: 0 }, cell, 0, 0);
  const ey = applyOrientation({ x: 0, y: 1 }, cell, 0, 0);
  const ux = ex.x * cx + ex.y * cy;
  const uy = ey.x * cx + ey.y * cy;
  const swap = Math.round(Math.abs(ex.y)) === 1; // 90°/270°: extents swap
  const w = swap ? r.height : r.width;
  const h = swap ? r.width : r.height;
  const b = {
    x: Math.round(typeW / 2 + ux - w / 2),
    y: Math.round(typeH / 2 + uy - h / 2),
    width: Math.round(w),
    height: Math.round(h)
  };
  return b.x === 0 && b.y === 0 && b.width === typeW && b.height === typeH ? undefined : b;
}

