/**
 * Shared primitives for the extraction pipeline: shape→polygon conversion,
 * bounds math, union-find, an R-tree spatial index, and a bounds-pruned
 * polygon-intersection test.
 *
 * Pure data + geometry. The only heavy dependency (Clipper2) is reached only
 * through `polygonsOverlap`, so callers can unit-test the rest without WASM.
 */

import RBush from "rbush";
import type { LayerShape } from "shared";
import type { Point, Rect } from "../geometry";
import { polygonBounds, rectsIntersect } from "../geometry";
import { polygonsIntersect } from "./clipper";

export type { Point, Rect };
// Re-exported so extraction callers keep a single import surface.
export { polygonBounds };

const CIRCLE_SEGMENTS = 16;

/** Convert any annotated shape into a closed polygon ring (CCW not enforced). */
export function shapeToPolygon(s: LayerShape): Point[] {
  switch (s.kind) {
    case "rect":
      return [
        { x: s.x, y: s.y },
        { x: s.x + s.width, y: s.y },
        { x: s.x + s.width, y: s.y + s.height },
        { x: s.x, y: s.y + s.height },
      ];
    case "line": {
      const dx = s.x2 - s.x1;
      const dy = s.y2 - s.y1;
      const len = Math.hypot(dx, dy);
      const hw = s.width / 2;
      if (len === 0) {
        return [
          { x: s.x1 - hw, y: s.y1 - hw },
          { x: s.x1 + hw, y: s.y1 - hw },
          { x: s.x1 + hw, y: s.y1 + hw },
          { x: s.x1 - hw, y: s.y1 + hw },
        ];
      }
      const nx = (-dy / len) * hw;
      const ny = (dx / len) * hw;
      return [
        { x: s.x1 + nx, y: s.y1 + ny },
        { x: s.x2 + nx, y: s.y2 + ny },
        { x: s.x2 - nx, y: s.y2 - ny },
        { x: s.x1 - nx, y: s.y1 - ny },
      ];
    }
    case "circle": {
      const pts: Point[] = [];
      for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
        pts.push({
          x: s.x + Math.cos(a) * s.radius,
          y: s.y + Math.sin(a) * s.radius,
        });
      }
      return pts;
    }
    case "point": {
      const hs = s.size / 2;
      return [
        { x: s.x - hs, y: s.y - hs },
        { x: s.x + hs, y: s.y - hs },
        { x: s.x + hs, y: s.y + hs },
        { x: s.x - hs, y: s.y + hs },
      ];
    }
    case "polygon":
      return s.points.map((p) => ({ x: p.x, y: p.y }));
  }
}

export function shapeBounds(s: LayerShape): Rect | null {
  return polygonBounds(shapeToPolygon(s));
}

/**
 * Cheap reject + exact test: bounding boxes must overlap before we pay for the
 * Clipper2 boolean op. Mirrors what every connectivity pass needs.
 */
export function polygonsOverlap(
  a: ReadonlyArray<Point>,
  b: ReadonlyArray<Point>,
): boolean {
  const ba = polygonBounds(a);
  const bb = polygonBounds(b);
  if (!ba || !bb || !rectsIntersect(ba, bb)) return false;
  return polygonsIntersect(a, b);
}

// ── Union-find ────────────────────────────────────────────────────

/** Disjoint-set with path-halving + union-by-default. */
export class UnionFind {
  private parent: Int32Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) {
      this.parent[r] = this.parent[this.parent[r]];
      r = this.parent[r];
    }
    return r;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }

  connected(a: number, b: number): boolean {
    return this.find(a) === this.find(b);
  }
}

// ── Spatial index ─────────────────────────────────────────────────

interface IndexEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Caller-defined id (e.g. node index in a connectivity graph). */
  id: number;
}

/**
 * R-tree over rectangular bounds. Replaces the old O(n²) all-pairs scan: build
 * once, then `candidates(bounds)` returns only the entries whose boxes overlap,
 * turning connectivity construction into roughly O(n log n).
 */
export class SpatialIndex {
  private tree = new RBush<IndexEntry>();

  insert(id: number, b: Rect): void {
    this.tree.insert({
      id,
      minX: b.x,
      minY: b.y,
      maxX: b.x + b.width,
      maxY: b.y + b.height,
    });
  }

  /** Bulk-load for better tree quality than repeated `insert`. */
  load(items: ReadonlyArray<{ id: number; bounds: Rect }>): void {
    this.tree.load(
      items.map(({ id, bounds: b }) => ({
        id,
        minX: b.x,
        minY: b.y,
        maxX: b.x + b.width,
        maxY: b.y + b.height,
      })),
    );
  }

  /** Ids whose bounding box intersects `b` (broad phase — refine with Clipper). */
  candidates(b: Rect): number[] {
    return this.tree
      .search({
        minX: b.x,
        minY: b.y,
        maxX: b.x + b.width,
        maxY: b.y + b.height,
      })
      .map((e) => e.id);
  }
}
