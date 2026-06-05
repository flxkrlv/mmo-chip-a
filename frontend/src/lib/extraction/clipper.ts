/**
 * Clipper2 (WASM) wrapper — the single place that touches the native polygon
 * engine. Everything else in the extraction library works with plain
 * `Point[]` rings and calls the helpers here.
 *
 * Lifecycle:
 *   - Browser: `await loadClipper()` once at startup. The emscripten module
 *     fetches `/clipper2z.wasm` (served from `frontend/public/`).
 *   - Node / tests: `await loadClipperWithBinary(buf)` with the wasm bytes.
 *   - Hot paths then call `getClipper()` (sync, throws if not loaded).
 *
 * Clipper2 hands back C++-owned objects; every one we allocate is `.delete()`d
 * before the helper returns. Keep that discipline if you add new ops.
 */

// @ts-expect-error — clipper2-wasm ships no module-level types for the factory
import initClipperImport from "clipper2-wasm/dist/es/clipper2z.js";
import type { MainModule, PathD, PathsD } from "clipper2-wasm/dist/clipper2z";
import type { Point } from "../geometry";

type Factory = (opts?: Record<string, unknown>) => Promise<MainModule>;

// Vite (browser) resolves the ESM default to the factory directly; Node's
// ESM↔CJS interop instead hands back `{ default: factory }`. Accept both.
const initClipper: Factory =
  typeof initClipperImport === "function"
    ? (initClipperImport as Factory)
    : ((initClipperImport as { default: Factory }).default);

let clipper: MainModule | null = null;
let loading: Promise<MainModule> | null = null;

/** Load the WASM module in a browser. Idempotent — safe to await repeatedly. */
export function loadClipper(): Promise<MainModule> {
  if (clipper) return Promise.resolve(clipper);
  if (!loading) {
    loading = initClipper({
      locateFile: () => "/clipper2z.wasm",
    }).then((m) => {
      clipper = m;
      return m;
    });
  }
  return loading;
}

/** Load with pre-read wasm bytes (Node.js / unit tests). Idempotent. */
export async function loadClipperWithBinary(
  wasmBinary: ArrayBuffer | Uint8Array,
): Promise<MainModule> {
  if (clipper) return clipper;
  clipper = await initClipper({ wasmBinary });
  return clipper;
}

/** Synchronous accessor for hot paths. Throws if not yet loaded. */
export function getClipper(): MainModule {
  if (!clipper) {
    throw new Error(
      "Clipper2 WASM not loaded — call loadClipper() (or loadClipperWithBinary) first.",
    );
  }
  return clipper;
}

/** True once the module is ready and `getClipper()` is safe to call. */
export function isClipperLoaded(): boolean {
  return clipper !== null;
}

// ── ring ⇄ Clipper path conversion ────────────────────────────────

function toPathD(c: MainModule, ring: ReadonlyArray<Point>): PathD {
  const path = new c.PathD();
  for (const p of ring) {
    const pt = new c.PointD(p.x, p.y, 0 as unknown as number);
    path.push_back(pt);
    pt.delete();
  }
  return path;
}

function toPathsD(c: MainModule, ring: ReadonlyArray<Point>): PathsD {
  const paths = new c.PathsD();
  const path = toPathD(c, ring);
  paths.push_back(path);
  path.delete();
  return paths;
}

function pathsDToRings(paths: PathsD): Point[][] {
  const rings: Point[][] = [];
  for (let i = 0; i < paths.size(); i++) {
    const path = paths.get(i);
    const ring: Point[] = [];
    for (let j = 0; j < path.size(); j++) {
      const pt = path.get(j);
      ring.push({ x: pt.x, y: pt.y });
      pt.delete();
    }
    path.delete();
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

// ── boolean ops ───────────────────────────────────────────────────

const PRECISION = 2;

/** True if the two polygons share any positive area. */
export function polygonsIntersect(
  a: ReadonlyArray<Point>,
  b: ReadonlyArray<Point>,
): boolean {
  const c = getClipper();
  const pa = toPathsD(c, a);
  const pb = toPathsD(c, b);
  const result = c.IntersectD(pa, pb, c.FillRule.EvenOdd, PRECISION);
  const hit = result.size() > 0;
  result.delete();
  pa.delete();
  pb.delete();
  return hit;
}

/**
 * `subject − clips` as a list of result rings. Used to cut a diffusion region
 * at the polysilicon gates that cross it (the pieces become the individual
 * source/drain terminals).
 */
export function polygonDifference(
  subject: ReadonlyArray<Point>,
  clips: ReadonlyArray<ReadonlyArray<Point>>,
): Point[][] {
  const c = getClipper();
  const subj = toPathsD(c, subject);
  const clip = new c.PathsD();
  for (const ring of clips) {
    const path = toPathD(c, ring);
    clip.push_back(path);
    path.delete();
  }
  const result = c.DifferenceD(subj, clip, c.FillRule.EvenOdd, PRECISION);
  const rings = pathsDToRings(result);
  result.delete();
  subj.delete();
  clip.delete();
  return rings;
}

/**
 * `subject ∩ clip` — intersection rings. Use this when the *shape* of the
 * intersection matters (e.g. counting how many disjoint transistor regions a
 * poly forms across a diffusion). For a yes/no overlap, prefer the cheaper
 * `polygonsIntersect`.
 *
 * The returned rings are flat (no hole nesting). Caller can inspect their
 * areas via `ringSignedArea` and filter by sign (positive = outer, negative =
 * hole) and magnitude. For our use cases — small straight-walled
 * transistor regions — holes are not expected.
 */
export function polygonIntersection(
  a: ReadonlyArray<Point>,
  b: ReadonlyArray<Point>,
): Point[][] {
  const c = getClipper();
  const pa = toPathsD(c, a);
  const pb = toPathsD(c, b);
  const result = c.IntersectD(pa, pb, c.FillRule.EvenOdd, PRECISION);
  const rings = pathsDToRings(result);
  result.delete();
  pa.delete();
  pb.delete();
  return rings;
}

/**
 * Signed area via the shoelace formula. CCW rings come back positive, CW
 * rings (typical Clipper hole representation) negative. Magnitude is the
 * actual area in world units, so callers can filter sub-MIN_AREA noise.
 *
 * Lives next to the Clipper ops because every callsite that wants area is
 * working with Clipper output rings; keeping it here avoids a separate
 * geometry import in the extraction pipeline.
 */
export function ringSignedArea(ring: ReadonlyArray<Point>): number {
  let a = 0;
  const n = ring.length;
  if (n < 3) return 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return a / 2;
}

/** Total absolute area summed across a ring list (drops hole sign). */
export function ringsAbsArea(rings: ReadonlyArray<ReadonlyArray<Point>>): number {
  let total = 0;
  for (const r of rings) total += Math.abs(ringSignedArea(r));
  return total;
}

/**
 * Inflate (positive `delta`) or shrink (negative `delta`) a single polygon
 * via Clipper's offset engine. We use this to absorb tiny precision
 * mismatches in adjacency tests: when two polygons should share an edge
 * but their vertices differ by sub-unit amounts (Clipper.Difference rounds
 * to `PRECISION` and the two shapes' rounded edges may not coincide
 * exactly), inflating one by ~1 unit creates a real positive-area overlap
 * exactly along the shared boundary that downstream tests can detect.
 *
 * Returns the inflated rings; for a simple convex polygon this is one
 * ring. JoinType.Miter + EndType.Polygon keeps the corners crisp (closed
 * polygon offset); the default miter limit prevents needle-thin spikes
 * at sharp corners.
 */
export function polygonInflate(
  poly: ReadonlyArray<Point>,
  delta: number,
): Point[][] {
  const c = getClipper();
  const paths = toPathsD(c, poly);
  const result = c.InflatePathsD(
    paths,
    delta,
    c.JoinType.Miter,
    c.EndType.Polygon,
    PRECISION,
    2.0,
    0.0,
  );
  const rings = pathsDToRings(result);
  result.delete();
  paths.delete();
  return rings;
}

/** Union of many polygons into (possibly multiple) result rings. */
export function polygonUnion(
  polys: ReadonlyArray<ReadonlyArray<Point>>,
): Point[][] {
  const c = getClipper();
  const subj = new c.PathsD();
  for (const ring of polys) {
    const path = toPathD(c, ring);
    subj.push_back(path);
    path.delete();
  }
  const empty = new c.PathsD();
  const result = c.UnionD(subj, empty, c.FillRule.NonZero, PRECISION);
  const rings = pathsDToRings(result);
  result.delete();
  subj.delete();
  empty.delete();
  return rings;
}
