// ── Floorplan region geometry editing ────────────────────────────────
//
// Pure helpers behind the floorplan edit handles (FloorplanOverlay). Rect
// regions store two opposite corners; polygon regions store their vertices.
// All coordinates are die (world) pixels.

import type { FloorplanRegion } from "shared";

export type Pt = { x: number; y: number };

/** Rect handles: corners and edge midpoints, by compass direction. */
export type RectHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const RECT_HANDLES: readonly RectHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Polygons need at least this many vertices. */
export const MIN_POLY_VERTICES = 3;

/** Legacy data may carry "poly" instead of "polygon". */
export function isPolyRegion(region: Pick<FloorplanRegion, "kind">): boolean {
  return (region.kind as string) === "poly" || region.kind === "polygon";
}

export function rectBounds(geometry: Pt[]) {
  const xs = geometry.map((p) => p.x);
  const ys = geometry.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Handle position (world) on the normalised rect. */
export function rectHandlePoint(geometry: Pt[], handle: RectHandle): Pt {
  const { x0, y0, x1, y1 } = rectBounds(geometry);
  const x = handle.includes("w") ? x0 : handle.includes("e") ? x1 : (x0 + x1) / 2;
  const y = handle.includes("n") ? y0 : handle.includes("s") ? y1 : (y0 + y1) / 2;
  return { x, y };
}

/**
 * Rect geometry with the side(s) of `handle` moved to `p`. Edge handles move
 * one axis only. Dragging past the opposite side flips the rect instead of
 * inverting it; the result is always normalised to [top-left, bottom-right].
 */
export function dragRectHandle(geometry: Pt[], handle: RectHandle, p: Pt): Pt[] {
  let { x0, y0, x1, y1 } = rectBounds(geometry);
  if (handle.includes("w")) x0 = p.x;
  if (handle.includes("e")) x1 = p.x;
  if (handle.includes("n")) y0 = p.y;
  if (handle.includes("s")) y1 = p.y;
  return [
    { x: Math.min(x0, x1), y: Math.min(y0, y1) },
    { x: Math.max(x0, x1), y: Math.max(y0, y1) }
  ];
}

export function translateGeometry(geometry: Pt[], dx: number, dy: number): Pt[] {
  return geometry.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function moveVertex(geometry: Pt[], index: number, p: Pt): Pt[] {
  return geometry.map((q, i) => (i === index ? { x: p.x, y: p.y } : q));
}

/** Insert `p` between vertex `afterIndex` and the next one (wrapping). */
export function insertVertex(geometry: Pt[], afterIndex: number, p: Pt): Pt[] {
  const next = [...geometry];
  next.splice(afterIndex + 1, 0, { x: p.x, y: p.y });
  return next;
}

/** Remove a vertex; refused (returns null) if it would leave < 3 vertices. */
export function deleteVertex(geometry: Pt[], index: number): Pt[] | null {
  if (geometry.length <= MIN_POLY_VERTICES) return null;
  return geometry.filter((_, i) => i !== index);
}

/** Midpoint of edge i → i+1 (wrapping), where a new vertex can be pulled out. */
export function edgeMidpoints(geometry: Pt[]): Pt[] {
  return geometry.map((p, i) => {
    const q = geometry[(i + 1) % geometry.length];
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  });
}

/** Round to whole die pixels (what gets persisted). */
export function roundGeometry(geometry: Pt[]): Pt[] {
  return geometry.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
}

/** A rect is degenerate (not worth saving) below this size, in die px. */
export function isDegenerate(region: Pick<FloorplanRegion, "kind">, geometry: Pt[]): boolean {
  if (isPolyRegion(region)) return geometry.length < MIN_POLY_VERTICES;
  const { x0, y0, x1, y1 } = rectBounds(geometry);
  return x1 - x0 < 1 || y1 - y0 < 1;
}
