import type { CellWarp, WarpKnot } from "shared";

/**
 * Piecewise-linear stretch of a cell instance's image in its type frame
 * (see `Cell.warp`). Each axis is a list of knots `src → dst`, sorted, the
 * first at 0 and the last at the type size (the box edges, which can move
 * too). Image content at `src` is shown at `dst`; between knots it stretches
 * linearly. Vertical lines are `x` knots, horizontal lines `y` knots.
 */

export type WarpAxis = "x" | "y";

/** Closest two lines' shown positions may get (type px). */
export const MIN_KNOT_GAP = 1;

/** The axis knots with the box edges, identity when absent. */
export function axisKnots(knots: WarpKnot[] | undefined, size: number): WarpKnot[] {
  if (knots && knots.length >= 2) return knots;
  return [{ src: 0, dst: 0 }, { src: size, dst: size }];
}

/** Segment index whose `key` range holds `v` (end segments extrapolate). */
function segmentOf(knots: WarpKnot[], v: number, key: "src" | "dst"): number {
  let i = 0;
  while (i < knots.length - 2 && v > knots[i + 1][key]) i++;
  return i;
}

function lerp(knots: WarpKnot[], v: number, from: "src" | "dst", to: "src" | "dst"): number {
  const i = segmentOf(knots, v, from);
  const a = knots[i];
  const b = knots[i + 1];
  const span = b[from] - a[from];
  if (span === 0) return a[to];
  return a[to] + ((v - a[from]) * (b[to] - a[to])) / span;
}

/** Shown position of image content at `src`. */
export function warpValue(knots: WarpKnot[], src: number): number {
  return lerp(knots, src, "src", "dst");
}

/** Image content shown at `dst`. */
export function unwarpValue(knots: WarpKnot[], dst: number): number {
  return lerp(knots, dst, "dst", "src");
}

/** Drop identity axes; undefined when nothing is left. */
export function normalizeWarp(warp: CellWarp | undefined): CellWarp | undefined {
  if (!warp) return undefined;
  const keep = (k?: WarpKnot[]) =>
    k && k.length >= 2 && !(k.length === 2 && k.every((p) => p.src === p.dst)) ? k : undefined;
  const x = keep(warp.x);
  const y = keep(warp.y);
  if (!x && !y) return undefined;
  return { ...(x ? { x } : {}), ...(y ? { y } : {}) };
}

/**
 * Add a stretch line where it is shown at `dst` (no visible change yet: it
 * pins the content currently there). Null when outside the box's shown span
 * or too close to an existing line.
 */
export function addWarpLine(
  warp: CellWarp | undefined,
  axis: WarpAxis,
  dst: number,
  size: number
): CellWarp | null {
  const knots = axisKnots(warp?.[axis], size);
  const first = knots[0].dst;
  const last = knots[knots.length - 1].dst;
  if (dst <= first + MIN_KNOT_GAP || dst >= last - MIN_KNOT_GAP) return null;
  if (knots.some((k) => Math.abs(k.dst - dst) < MIN_KNOT_GAP * 2)) return null;
  const src = unwarpValue(knots, dst);
  const next = [...knots, { src, dst }].sort((a, b) => a.src - b.src);
  return { ...warp, [axis]: next };
}

/** Move knot `index` to be shown at `dst`, kept between its neighbours. */
export function moveWarpKnot(
  warp: CellWarp | undefined,
  axis: WarpAxis,
  index: number,
  dst: number,
  size: number
): CellWarp {
  const knots = axisKnots(warp?.[axis], size);
  const lo = index > 0 ? knots[index - 1].dst + MIN_KNOT_GAP : -Infinity;
  const hi = index < knots.length - 1 ? knots[index + 1].dst - MIN_KNOT_GAP : Infinity;
  const next = knots.map((k, i) => (i === index ? { src: k.src, dst: Math.min(hi, Math.max(lo, dst)) } : k));
  return { ...warp, [axis]: next };
}

/** Remove an inner line; on an edge knot, put the edge back in place. */
export function removeWarpKnot(
  warp: CellWarp | undefined,
  axis: WarpAxis,
  index: number,
  size: number
): CellWarp | undefined {
  const knots = axisKnots(warp?.[axis], size);
  const edge = index === 0 || index === knots.length - 1;
  const next = edge
    ? knots.map((k, i) => (i === index ? { src: k.src, dst: k.src } : k))
    : knots.filter((_, i) => i !== index);
  return normalizeWarp({ ...warp, [axis]: next });
}

/** One rectangle of the piecewise map: content `src` is shown in `dst`. */
export interface WarpPiece {
  sx0: number; sx1: number; sy0: number; sy1: number;
  dx0: number; dx1: number; dy0: number; dy1: number;
}

/** The grid of rectangles the stretch is made of. */
export function warpPieces(warp: CellWarp | undefined, w: number, h: number): WarpPiece[] {
  const xs = axisKnots(warp?.x, w);
  const ys = axisKnots(warp?.y, h);
  const out: WarpPiece[] = [];
  for (let i = 0; i < xs.length - 1; i++)
    for (let j = 0; j < ys.length - 1; j++)
      out.push({
        sx0: xs[i].src, sx1: xs[i + 1].src, sy0: ys[j].src, sy1: ys[j + 1].src,
        dx0: xs[i].dst, dx1: xs[i + 1].dst, dy0: ys[j].dst, dy1: ys[j + 1].dst
      });
  return out;
}

/** Stretch factor of each segment along an axis (shown / content length). */
export function segmentScales(knots: WarpKnot[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < knots.length - 1; i++) {
    const s = knots[i + 1].src - knots[i].src;
    out.push(s > 0 ? (knots[i + 1].dst - knots[i].dst) / s : 1);
  }
  return out;
}
