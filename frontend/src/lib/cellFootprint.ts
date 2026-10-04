import type { AnnotationRect, Cell } from "shared";
import { applyOrientation, type Orientation, type Point, type Rect } from "./geometry";

/**
 * A placed cell's footprint on the die: its box in *type* coordinates — the
 * per-instance `Cell.bounds`, else the type's `cropRect` box
 * `(0, 0, width, height)` — pushed through the instance orientation exactly
 * like its content (mirror, then rotate about the type-box centre; see
 * `applyOrientation`) and placed at the cell origin `(x, y)`.
 *
 * So the outline always wraps the drawn content: a 90°/270° cell of a W×H
 * type covers H×W on the die, centred where the unrotated box would be.
 * Mirrors never change it. Because rotation is about the centre, a rotated
 * cell whose W−H is odd sits on half-pixel die coordinates.
 */

/** Footprint box in type coordinates: the instance override, else the type's box. */
export function cellBox(cell: Cell, typeW: number, typeH: number): AnnotationRect {
  return cell.bounds ?? { x: 0, y: 0, width: typeW, height: typeH };
}

/** Axis-aligned bbox of `r`'s corners after `map`. */
function mapRect(r: Rect, map: (p: Point) => Point): Rect {
  const ps = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y + r.height }
  ].map(map);
  const x = Math.min(ps[0].x, ps[1].x);
  const y = Math.min(ps[0].y, ps[1].y);
  return { x, y, width: Math.abs(ps[1].x - ps[0].x), height: Math.abs(ps[1].y - ps[0].y) };
}

/** Die-space footprint of a placed cell (`typeW/H` = its type's cropRect). */
export function cellWorldRect(cell: Cell, typeW: number, typeH: number): Rect {
  const r = mapRect(cellBox(cell, typeW, typeH), (p) => applyOrientation(p, cell, typeW, typeH));
  return { ...r, x: cell.x + r.x, y: cell.y + r.y };
}

/** Inverse of `applyOrientation`: oriented cell-local → type coordinates. */
export function unorient(q: Point, cell: Orientation, typeW: number, typeH: number): Point {
  // M is orthogonal, so M⁻¹v = Mᵀv = (Mx̂·v, Mŷ·v).
  const ex = applyOrientation({ x: 1, y: 0 }, cell, 0, 0);
  const ey = applyOrientation({ x: 0, y: 1 }, cell, 0, 0);
  const vx = q.x - typeW / 2;
  const vy = q.y - typeH / 2;
  return { x: ex.x * vx + ex.y * vy + typeW / 2, y: ey.x * vx + ey.y * vy + typeH / 2 };
}

/**
 * Canvas matrix `[a, b, c, d, e, f]` (for `ctx.transform`) taking die
 * coordinates relative to the cell origin `(x, y)` into the type frame — the
 * inverse of how the type content is placed on the die. A crop of the die
 * footprint drawn at its cell-relative rect under this matrix lands exactly
 * on the type box, upright, whatever the instance orientation.
 */
export function dieToTypeMatrix(
  cell: Orientation,
  typeW: number,
  typeH: number
): [number, number, number, number, number, number] {
  const o = unorient({ x: 0, y: 0 }, cell, typeW, typeH);
  const ex = unorient({ x: 1, y: 0 }, cell, typeW, typeH);
  const ey = unorient({ x: 0, y: 1 }, cell, typeW, typeH);
  return [ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y];
}

/** Round to the half-pixel grid that centre rotation can land on. */
const half = (v: number) => Math.round(v * 2) / 2;

/**
 * `bounds` that put `cell`'s footprint at die rect `r` for a type of size
 * `typeW×typeH` (inverse of `cellWorldRect`). Undefined when it equals the
 * type's own box, so untouched cells stay override-free.
 */
export function boundsForWorldRect(
  cell: Cell,
  typeW: number,
  typeH: number,
  r: Rect
): AnnotationRect | undefined {
  const t = mapRect({ ...r, x: r.x - cell.x, y: r.y - cell.y }, (q) => unorient(q, cell, typeW, typeH));
  const b = { x: half(t.x), y: half(t.y), width: half(t.width), height: half(t.height) };
  return b.x === 0 && b.y === 0 && b.width === typeW && b.height === typeH ? undefined : b;
}

/** `cell` with its `bounds` replaced (dropped when undefined). */
export function withBounds(cell: Cell, bounds: AnnotationRect | undefined): Cell {
  const { bounds: _prev, ...rest } = cell;
  return bounds ? { ...rest, bounds } : rest;
}

/**
 * `cell` moved onto type `cellTypeId`, adopting that type's size (its own
 * `bounds` override is dropped) so every instance of a type has the same
 * size. Its origin, and so its place on the die, is kept.
 */
export function retypeCell(cell: Cell, cellTypeId: string): Cell {
  return withBounds({ ...cell, cellTypeId }, undefined);
}
