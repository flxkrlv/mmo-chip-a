/**
 * windowAnchor.ts — where a dragged element window (net / cell / floorplan /
 * comment) reopens. A window is pinned to one *anchor point* of its element
 * (a net node, a polygon vertex, a rect / cell corner, the comment position)
 * plus a screen-pixel offset of the window's top-left from that point, so it
 * keeps its place beside the element at any zoom.
 *
 * Anchors are matched back to the element by a stable `key` (node id, corner
 * index, vertex index); `sig` guards keys that are only stable while the
 * geometry keeps its shape (vertex indices shift when the point count
 * changes). When the key no longer matches — the anchor point was deleted —
 * the point nearest the anchor's last known position takes over, i.e. the
 * window re-anchors to the neighbour of the deleted point.
 */

import type { Cell, CellType, CommentAnnotation, DieAnnotations, FloorplanRegion } from "shared";
import { cellWorldRect } from "./cellFootprint";

/** A candidate anchor point of an element, in world coordinates. */
export interface AnchorPoint {
  key: string;
  x: number;
  y: number;
}

/** A stored window placement. */
export interface WindowAnchor {
  /** AnchorPoint.key at the time it was stored / last re-anchored. */
  key: string;
  /** Guard for `key` (e.g. vertex count); a mismatch forces nearest-point. */
  sig?: string;
  /** Last known world position of the anchor point. */
  x: number;
  y: number;
  /** Window top-left minus the anchor's screen position, CSS px. */
  dx: number;
  dy: number;
}

/** Element kinds that own a window. */
export type WindowElementKind = "net" | "cell" | "floorplan" | "comment";

/** Preferences key of an element's window anchor. */
export function windowAnchorKey(dieId: string, kind: WindowElementKind, id: string): string {
  return `${dieId}:${kind}:${id}`;
}

/** Four corners of an axis-aligned rect, keyed `c0..c3` clockwise from top-left. */
function rectCorners(x0: number, y0: number, x1: number, y1: number): AnchorPoint[] {
  const [l, r] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const [t, b] = y0 <= y1 ? [y0, y1] : [y1, y0];
  return [
    { key: "c0", x: l, y: t },
    { key: "c1", x: r, y: t },
    { key: "c2", x: r, y: b },
    { key: "c3", x: l, y: b }
  ];
}

export function netAnchorPoints(net: { nodes: { id: string; x: number; y: number }[] }): AnchorPoint[] {
  return net.nodes.map((n) => ({ key: n.id, x: n.x, y: n.y }));
}

export function floorplanAnchorPoints(region: FloorplanRegion): { points: AnchorPoint[]; sig?: string } {
  const g = region.geometry;
  if (region.kind === "rect" && g.length >= 2) return { points: rectCorners(g[0].x, g[0].y, g[1].x, g[1].y) };
  return { points: g.map((p, i) => ({ key: `v${i}`, x: p.x, y: p.y })), sig: String(g.length) };
}

export function cellAnchorPoints(cell: Cell, cellType: CellType | undefined): AnchorPoint[] {
  const w = cellType?.cropRect.width ?? 0;
  const h = cellType?.cropRect.height ?? 0;
  const r = cellWorldRect(cell, w, h);
  return rectCorners(r.x, r.y, r.x + r.width, r.y + r.height);
}

export function commentAnchorPoints(comment: CommentAnnotation): AnchorPoint[] {
  return [{ key: "pos", x: comment.x, y: comment.y }];
}

/**
 * Anchor points (and key guard) of the element behind a stored anchor key
 * `kind:id`, or null when the element no longer exists.
 */
export function anchorPointsFor(
  annotations: DieAnnotations,
  kind: WindowElementKind,
  id: string
): { points: AnchorPoint[]; sig?: string } | null {
  switch (kind) {
    case "net": {
      const net = annotations.nets.find((n) => n.id === id);
      return net ? { points: netAnchorPoints(net) } : null;
    }
    case "cell": {
      const cell = annotations.cells.find((c) => c.id === id);
      if (!cell) return null;
      return { points: cellAnchorPoints(cell, annotations.cellTypes.find((t) => t.id === cell.cellTypeId)) };
    }
    case "floorplan": {
      const region = (annotations.floorplanRegions ?? []).find((r) => r.id === id);
      return region ? floorplanAnchorPoints(region) : null;
    }
    case "comment": {
      const comment = (annotations.comments ?? []).find((c) => c.id === id);
      return comment ? { points: commentAnchorPoints(comment) } : null;
    }
  }
}

function nearest(points: AnchorPoint[], x: number, y: number): AnchorPoint | null {
  let best: AnchorPoint | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * The anchor point `stored` refers to now: the same key (when its guard still
 * holds), else the point nearest the anchor's last known position — so a
 * deleted anchor hands over to its nearest neighbour. Null without points.
 */
export function resolveAnchorPoint(
  points: AnchorPoint[],
  sig: string | undefined,
  stored: WindowAnchor
): AnchorPoint | null {
  if (stored.sig === sig) {
    const same = points.find((p) => p.key === stored.key);
    if (same) return same;
  }
  return nearest(points, stored.x, stored.y);
}

/**
 * `stored` updated to follow its element's current geometry (same offset),
 * or `stored` itself when nothing changed / the element has no points.
 */
export function reanchor(points: AnchorPoint[], sig: string | undefined, stored: WindowAnchor): WindowAnchor {
  const p = resolveAnchorPoint(points, sig, stored);
  if (!p) return stored;
  if (p.key === stored.key && p.x === stored.x && p.y === stored.y && sig === stored.sig) return stored;
  return { ...stored, key: p.key, sig, x: p.x, y: p.y };
}

/**
 * Anchor for a window just dropped with its top-left at screen (left, top)
 * and size w×h: the element point closest to the window's rectangle (0
 * when inside it), with the offset measured from that point. `toScreen`
 * maps world → container CSS px under the current viewport.
 */
export function anchorForDrop(
  points: AnchorPoint[],
  sig: string | undefined,
  win: { left: number; top: number; width: number; height: number },
  toScreen: (p: { x: number; y: number }) => { x: number; y: number }
): WindowAnchor | null {
  let best: { p: AnchorPoint; s: { x: number; y: number } } | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const s = toScreen(p);
    const cx = Math.max(win.left, Math.min(s.x, win.left + win.width));
    const cy = Math.max(win.top, Math.min(s.y, win.top + win.height));
    const d = (s.x - cx) ** 2 + (s.y - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { p, s };
    }
  }
  if (!best) return null;
  return {
    key: best.p.key,
    sig,
    x: best.p.x,
    y: best.p.y,
    dx: Math.round(win.left - best.s.x),
    dy: Math.round(win.top - best.s.y)
  };
}
