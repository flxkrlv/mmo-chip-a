import type { Point } from "./geometry";
import type { Orient, Rotation } from "./mergeCells";

/**
 * 2D point-set registration over the dihedral group D4 (8 orientations) +
 * translation. Used by the merge-cells "Auto align" button to find the
 * orientation + offset that best lines up the candidate's ML vias with the
 * specimen's. Robust to outliers (vias detected in one cell but not the
 * other) and missing points because it uses a Hough-style histogram vote
 * rather than a least-squares fit — no correspondences needed up front.
 *
 * Complexity: O(|S| × |C|) per orientation × 8 orientations. For typical
 * cell-sized via counts (<50 each), well under a millisecond.
 */

export interface AlignResult {
  flippedH: boolean;
  flippedV: boolean;
  rotation: Rotation;
  /** Delta (die-coord px) to add to candidate `cell.x` / `cell.y`. The
   *  patch is `{flippedH, flippedV, rotation, x: cell.x + dx, y: cell.y + dy}`
   *  so callers can drop it straight into `buildOrientAction`. */
  dx: number;
  dy: number;
  /** Pairs that voted for the winning translation (within the 3×3 bin
   *  neighbourhood of the peak). Treat as a confidence — at least 3 here
   *  with a small both-side count is a good rule of thumb. */
  matched: number;
  /** Upper bound on `matched` for the inputs (= min of the two via counts). */
  ceiling: number;
}

interface OrientCombo {
  flippedH: boolean;
  rotation: Rotation;
}

// Dihedral group D4 — 8 unique orientations (rotation × {no h-flip, h-flip}).
// `flippedV` is dropped intentionally: it's expressible as `flippedH +
// rotation 180`, so iterating both would double-count solutions.
const ORIENTATIONS: OrientCombo[] = [
  { flippedH: false, rotation: 0 },
  { flippedH: false, rotation: 90 },
  { flippedH: false, rotation: 180 },
  { flippedH: false, rotation: 270 },
  { flippedH: true, rotation: 0 },
  { flippedH: true, rotation: 90 },
  { flippedH: true, rotation: 180 },
  { flippedH: true, rotation: 270 }
];

// ── Geometry helpers ─────────────────────────────────────────────────

/** Map a raw (uncentred) local cell-coord point through an orientation to
 *  the canonical-frame position. Mirrors the canvas display transform:
 *  centre → flip → rotate → uncentre. */
function applyOrient(p: Point, o: OrientCombo, W: number, H: number): Point {
  const cx = p.x - W / 2;
  const cy = p.y - H / 2;
  // Flip H first to match the canvas's `scale(±1, ±1)` after the rotate.
  const fx = o.flippedH ? -cx : cx;
  const fy = cy;
  const θ = (o.rotation * Math.PI) / 180;
  const c = Math.cos(θ);
  const s = Math.sin(θ);
  // Canvas convention: math-CCW (visually CW under canvas's y-down).
  return {
    x: c * fx - s * fy + W / 2,
    y: s * fx + c * fy + H / 2
  };
}

/** Project specimen vias into the specimen's canonical frame. Exported so
 *  the page can compute once and reuse. `vias` are raw local (already
 *  shifted by `-cell.x, -cell.y`). */
export function viasToCanonical(
  vias: Point[],
  o: Orient,
  W: number,
  H: number
): Point[] {
  return vias.map((v) =>
    applyOrient(v, { flippedH: o.flippedH, rotation: o.rotation }, W, H)
  );
}

// ── Voting ───────────────────────────────────────────────────────────

interface Bin {
  sumX: number;
  sumY: number;
  count: number;
}

/** Hough-style vote: every (s, c) pair contributes its `s − c` translation
 *  into a histogram. The peak bin (+ its 3×3 neighbourhood for sub-bin
 *  centroid recovery) is the consensus translation. */
function bestTranslation(
  specCanon: Point[],
  candCanon: Point[],
  binSize: number
): { dx: number; dy: number; matched: number } {
  if (specCanon.length === 0 || candCanon.length === 0) {
    return { dx: 0, dy: 0, matched: 0 };
  }
  const bins = new Map<string, Bin>();
  for (const s of specCanon) {
    for (const c of candCanon) {
      const dx = s.x - c.x;
      const dy = s.y - c.y;
      const bx = Math.round(dx / binSize);
      const by = Math.round(dy / binSize);
      const key = `${bx},${by}`;
      let bin = bins.get(key);
      if (!bin) {
        bin = { sumX: 0, sumY: 0, count: 0 };
        bins.set(key, bin);
      }
      bin.sumX += dx;
      bin.sumY += dy;
      bin.count += 1;
    }
  }
  let bestKey = "";
  let bestCount = 0;
  for (const [key, bin] of bins) {
    if (bin.count > bestCount) {
      bestCount = bin.count;
      bestKey = key;
    }
  }
  if (bestCount === 0) return { dx: 0, dy: 0, matched: 0 };

  // Refine: pool the peak with its 3×3 neighbours so the centroid is at
  // sub-bin precision rather than locked to the bin grid.
  const [bxStr, byStr] = bestKey.split(",");
  const bx = parseInt(bxStr, 10);
  const by = parseInt(byStr, 10);
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let nx = bx - 1; nx <= bx + 1; nx++) {
    for (let ny = by - 1; ny <= by + 1; ny++) {
      const bin = bins.get(`${nx},${ny}`);
      if (!bin) continue;
      sumX += bin.sumX;
      sumY += bin.sumY;
      count += bin.count;
    }
  }
  return { dx: sumX / count, dy: sumY / count, matched: count };
}

// ── Public entry point ──────────────────────────────────────────────

export interface AlignOptions {
  /** Vote histogram bin size in canonical px. Defaults to 3 — generous
   *  enough to swallow sub-pixel ML detection noise without merging
   *  obviously distinct vias. */
  binSize?: number;
  /** Reject the result when fewer than this many vias matched. Defaults to
   *  3 (or the ceiling if both sides have <3 vias). */
  minMatches?: number;
}

/**
 * Find the orientation + offset that maps `candidateRawVias` onto
 * `specimenCanonVias`. Returns `null` when there isn't enough signal to
 * commit — either side empty / nearly empty, or no orientation produces a
 * cluster above `minMatches`.
 *
 * Inputs:
 *   • `specimenCanonVias` — specimen via positions in the specimen's
 *     canonical frame (run through `viasToCanonical` first).
 *   • `candidateRawVias`  — candidate via positions in raw cell-local
 *     coords (`vx - cell.x, vy - cell.y`) — the algorithm tries every
 *     orientation against these, so they must NOT be pre-oriented.
 *   • `cellW`, `cellH`    — cell-type cropRect dimensions.
 *
 * Output: an `AlignResult` ready to feed into `buildOrientAction` as a
 * one-shot patch. `dx` / `dy` is the die-coord delta to add to candidate
 * `cell.x` / `cell.y`; the inverse-orientation math is baked in so it
 * matches the existing drag-align convention.
 */
export function alignVias(
  specimenCanonVias: Point[],
  candidateRawVias: Point[],
  cellW: number,
  cellH: number,
  options: AlignOptions = {}
): AlignResult | null {
  const binSize = options.binSize ?? 3;
  const ceiling = Math.min(specimenCanonVias.length, candidateRawVias.length);
  const minMatches = options.minMatches ?? Math.min(3, ceiling);
  if (ceiling < 2) return null;

  let best: {
    o: OrientCombo;
    dx: number;
    dy: number;
    matched: number;
  } | null = null;
  for (const o of ORIENTATIONS) {
    const canon = candidateRawVias.map((v) => applyOrient(v, o, cellW, cellH));
    const result = bestTranslation(specimenCanonVias, canon, binSize);
    if (!best || result.matched > best.matched) {
      best = { o, dx: result.dx, dy: result.dy, matched: result.matched };
    }
  }
  if (!best || best.matched < minMatches) return null;

  // Canonical translation → raw die-coord delta to apply to cell.x / cell.y.
  // Same inverse-orientation math as drag-align (the displayed shift wants
  // the crop bbox to move oppositely in raw coords), but parameterised by
  // the NEW orientation we're committing to — not the old one.
  const θ = (best.o.rotation * Math.PI) / 180;
  const c = Math.cos(θ);
  const s = Math.sin(θ);
  // R(-θ) · (dx, dy)
  const ax = c * best.dx + s * best.dy;
  const ay = -s * best.dx + c * best.dy;
  const sx = best.o.flippedH ? -1 : 1;
  const sy = 1; // flippedV is always false in our orientation set
  return {
    flippedH: best.o.flippedH,
    flippedV: false,
    rotation: best.o.rotation,
    dx: Math.round(-sx * ax),
    dy: Math.round(-sy * ay),
    matched: best.matched,
    ceiling
  };
}
