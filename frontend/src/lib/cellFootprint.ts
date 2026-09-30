import type { AnnotationRect, Cell } from "shared";
import type { Rect } from "./geometry";

/**
 * A placed cell's footprint on the die: an axis-aligned rect in *die* axes,
 * anchored at the cell origin `(x, y)`. By default it is the type's `cropRect`
 * box `(0, 0, width, height)`; a per-instance `Cell.bounds` overrides it.
 *
 * Orientation (rotation / mirrors) deliberately plays no part: it only decides
 * how the type's content is presented on the cell (die-viewer layer drawing,
 * merge-cells comparison), never where the cell sits on the die. Translation
 * (`x`, `y`) does move the footprint.
 */

/** Footprint relative to the cell origin: the instance override, else the type's box. */
export function cellBox(cell: Cell, typeW: number, typeH: number): AnnotationRect {
  return cell.bounds ?? { x: 0, y: 0, width: typeW, height: typeH };
}

/** Die-space footprint of a placed cell (`typeW/H` = its type's cropRect). */
export function cellWorldRect(cell: Cell, typeW: number, typeH: number): Rect {
  const b = cellBox(cell, typeW, typeH);
  return { x: cell.x + b.x, y: cell.y + b.y, width: b.width, height: b.height };
}

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
  const b = {
    x: Math.round(r.x - cell.x),
    y: Math.round(r.y - cell.y),
    width: Math.round(r.width),
    height: Math.round(r.height)
  };
  return b.x === 0 && b.y === 0 && b.width === typeW && b.height === typeH ? undefined : b;
}

/** `cell` with its `bounds` replaced (dropped when undefined). */
export function withBounds(cell: Cell, bounds: AnnotationRect | undefined): Cell {
  const { bounds: _prev, ...rest } = cell;
  return bounds ? { ...rest, bounds } : rest;
}

/**
 * `next` (a re-typed / re-positioned version of `prev`) with `bounds`
 * re-solved so its die footprint equals `prev`'s — e.g. changing a cell's
 * type never changes its size or place on the die.
 */
export function keepFootprint(
  prev: Cell,
  prevTypeW: number,
  prevTypeH: number,
  next: Cell,
  nextTypeW: number,
  nextTypeH: number
): Cell {
  const world = cellWorldRect(prev, prevTypeW, prevTypeH);
  return withBounds(next, boundsForWorldRect(next, nextTypeW, nextTypeH, world));
}
