import { describe, expect, it } from "vitest";
import type { Cell, CellType, DieAnnotations } from "shared";
import { applyOrientation, type Rect } from "../../lib/geometry";
import { cellWorldRect, resizeCellType, type CellSide } from "./cellResize";

/**
 * Orientation-aware type resize, as a property of the dihedral group D4.
 *
 * Each instance maps type-local p to the die as
 *   world(p) = origin + c + M (p - c),   c = (w/2, h/2),   M = R(θ) · F.
 * M is a signed permutation, so it maps outward side normals to outward side
 * normals and an outward growth δ stays δ — only the side label moves.
 *
 * Dragging die side s_die of cell A by δ must:
 *   1. grow the TYPE on side s_type = M_Aᵀ s_die (layers shift by (left, top));
 *   2. for every instance B, grow B's die footprint and B's content image on
 *      die side M_B s_type = M_B M_Aᵀ s_die, by exactly δ, other sides fixed;
 *   3. keep every instance's content fixed on the die (≤ ½ px rounding, from
 *      rotating about the box centre when a size changes parity);
 *   4. keep a default instance's footprint equal to its drawn content box, so
 *      the edge the user grabs is the one shown rotated on the die.
 *
 * Orientations, sizes, positions and drags are random. The run's seed is in
 * every failure message; reproduce with RESIZE_SEED=<seed> npm test.
 */

type Vec = { x: number; y: number };
type Mat = [Vec, Vec]; // columns: images of x̂ and ŷ
type Orientation = Pick<Cell, "rotation" | "flippedH" | "flippedV">;

// No Node types in this tsconfig; vitest runs under Node, so `process` exists.
const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SEED = Number(ENV.RESIZE_SEED ?? Math.floor(Math.random() * 2 ** 31));

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
type Rng = ReturnType<typeof mulberry32>;
const randInt = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];

const ROTATIONS = [0, 90, 180, 270] as const;
const SIDES: CellSide[] = ["left", "right", "top", "bottom"];
const NORMAL: Record<CellSide, Vec> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 }
};

/** All 16 flag combinations (each of the 8 D4 elements appears twice). */
const ORIENTATIONS: Orientation[] = ROTATIONS.flatMap((rotation) =>
  [false, true].flatMap((flippedH) => [false, true].map((flippedV) => ({ rotation, flippedH, flippedV })))
);
const oName = (o: Orientation) =>
  `rot${o.rotation ?? 0}${o.flippedH ? "+H" : ""}${o.flippedV ? "+V" : ""}`;

// ── Independent D4 algebra (spec, not the code under test) ─────────────

/** M = R(θ)·F: mirror first, then 90° steps (x,y) → (−y,x) (CW under y-down). */
function matrixOf(o: Orientation): Mat {
  const col = (v: Vec): Vec => {
    let r = { x: o.flippedH ? -v.x : v.x, y: o.flippedV ? -v.y : v.y };
    for (let k = 0; k < (o.rotation ?? 0) / 90; k++) r = { x: -r.y, y: r.x };
    return r;
  };
  return [col({ x: 1, y: 0 }), col({ x: 0, y: 1 })];
}
const mul = (m: Mat, v: Vec): Vec => ({ x: m[0].x * v.x + m[1].x * v.y, y: m[0].y * v.x + m[1].y * v.y });
const transpose = (m: Mat): Mat => [
  { x: m[0].x, y: m[1].x },
  { x: m[0].y, y: m[1].y }
];
function sideOf(n: Vec): CellSide {
  const s = SIDES.find((k) => NORMAL[k].x === n.x && NORMAL[k].y === n.y);
  if (!s) throw new Error(`not a side normal: ${JSON.stringify(n)}`);
  return s;
}

function worldPoint(cell: Cell, w: number, h: number, p: Vec): Vec {
  const q = mul(matrixOf(cell), { x: p.x - w / 2, y: p.y - h / 2 });
  return { x: cell.x + w / 2 + q.x, y: cell.y + h / 2 + q.y };
}

/** Die-axis bbox of the type box as drawn on this instance (its content image). */
function contentRect(cell: Cell, w: number, h: number): Rect {
  const ps = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: 0, y: h },
    { x: w, y: h }
  ].map((p) => worldPoint(cell, w, h, p));
  const xs = ps.map((p) => p.x);
  const ys = ps.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** `r` with its `side` pushed outward by δ (δ < 0 shrinks). */
function grow(r: Rect, side: CellSide, d: number): Rect {
  switch (side) {
    case "left":
      return { ...r, x: r.x - d, width: r.width + d };
    case "right":
      return { ...r, width: r.width + d };
    case "top":
      return { ...r, y: r.y - d, height: r.height + d };
    case "bottom":
      return { ...r, height: r.height + d };
  }
}

function expectRectClose(actual: Rect, expected: Rect, tol: number, msg: string) {
  for (const k of ["x", "y", "width", "height"] as const)
    expect(Math.abs(actual[k] - expected[k]), `${msg} · ${k}: got ${actual[k]}, want ${expected[k]}`).toBeLessThanOrEqual(tol);
}

// ── One trial ───────────────────────────────────────────────────────────

function runTrial(rng: Rng, oA: Orientation, oB: Orientation, sDie: CellSide, tag: string) {
  const w = randInt(rng, 8, 60);
  const h = randInt(rng, 8, 60);
  // Never 0 and never enough to hit the minimum-size clamp (sizes ≥ 8).
  const d = pick(rng, [-6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const pts: Vec[] = Array.from({ length: 3 }, () => ({ x: randInt(rng, 0, w), y: randInt(rng, 0, h) }));
  const ct = {
    id: "t",
    name: "t",
    cropRect: { x: randInt(rng, 0, 900), y: randInt(rng, 0, 900), width: w, height: h },
    layers: {
      metal1: [
        { id: "p", kind: "point", x: pts[0].x, y: pts[0].y, size: 1 },
        { id: "g", kind: "polygon", points: [pts[1], pts[2], { x: pts[0].x, y: pts[2].y }] }
      ]
    }
  } as unknown as CellType;
  const at = (id: string, o: Orientation): Cell => ({
    id,
    cellTypeId: "t",
    x: randInt(rng, 0, 5000),
    y: randInt(rng, 0, 5000),
    ...o
  });
  const A = at("a", oA);
  const B = at("b", oB);
  // A few more random siblings: the property must hold for every instance.
  const extra = Array.from({ length: randInt(rng, 0, 3) }, (_, i) => at(`x${i}`, pick(rng, ORIENTATIONS)));
  const unrelated: Cell = { id: "z", cellTypeId: "u", x: 1, y: 2 };
  const siblings = [A, B, ...extra];
  const ann = {
    cells: [...siblings, unrelated],
    cellTypes: [ct, { id: "u", name: "u", cropRect: { x: 0, y: 0, width: 5, height: 5 } }]
  } as unknown as DieAnnotations;

  const msg = `seed ${SEED} · ${tag} · A=${oName(oA)} B=${oName(oB)} drag ${sDie} δ=${d} type ${w}×${h}`;

  const fpA = cellWorldRect(A, w, h);
  const edgePos = {
    left: fpA.x - d,
    right: fpA.x + fpA.width + d,
    top: fpA.y - d,
    bottom: fpA.y + fpA.height + d
  }[sDie];
  // The outline is the oriented type box (what the content is drawn in).
  for (const c of siblings) expect(cellWorldRect(c, w, h), `${msg} · ${c.id} footprint is oriented`).toEqual(contentRect(c, w, h));
  const res = resizeCellType(ann, A, ct, sDie, edgePos);
  expect(res, msg).not.toBeNull();
  if (!res) return;

  // 1. The type changes in its own frame, on side s_type = M_Aᵀ s_die.
  const sType = sideOf(mul(transpose(matrixOf(A)), NORMAL[sDie]));
  const typeBox = grow({ x: 0, y: 0, width: w, height: h }, sType, d);
  const nw = typeBox.width;
  const nh = typeBox.height;
  const shift = { x: -typeBox.x, y: -typeBox.y }; // (left, top) growth
  expect(res.prevCellType, msg).toBe(ct);
  expect({ w: res.cellType.cropRect.width, h: res.cellType.cropRect.height }, `${msg} · type grows on ${sType}`).toEqual({
    w: nw,
    h: nh
  });
  const [pt, poly] = res.cellType.layers!.metal1! as unknown as [Vec, { points: Vec[] }];
  const moved = (p: Vec) => ({ x: p.x + shift.x, y: p.y + shift.y });
  expect({ x: pt.x, y: pt.y }, `${msg} · layers shift by (left, top)`).toEqual(moved(pts[0]));
  expect(poly.points, `${msg} · layers shift by (left, top)`).toEqual([pts[1], pts[2], { x: pts[0].x, y: pts[2].y }].map(moved));

  // Every instance of the type is updated, nothing else.
  expect(res.cells.map((c) => c.cell.id).sort(), msg).toEqual(siblings.map((c) => c.id).sort());

  for (const prev of siblings) {
    const next = res.cells.find((c) => c.cell.id === prev.id)!;
    expect(next.prevCell, msg).toBe(prev);
    const cell = next.cell;
    const who = `${msg} · instance ${prev.id} (${oName(prev)})`;
    // Orientation itself is untouched by a resize.
    expect(oName(cell), who).toBe(oName(prev));

    // 2. Die side for this instance: M_B s_type = M_B M_Aᵀ s_die.
    const sB = sideOf(mul(matrixOf(prev), NORMAL[sType]));
    expect(cellWorldRect(cell, nw, nh), `${who} · footprint grows on die ${sB}`).toEqual(
      grow(cellWorldRect(prev, w, h), sB, d)
    );
    expectRectClose(
      contentRect(cell, nw, nh),
      grow(contentRect(prev, w, h), sB, d),
      0.5,
      `${who} · content box grows on die ${sB}`
    );

    // 4. Still the drawn box after the resize (origins round to whole px).
    expectRectClose(cellWorldRect(cell, nw, nh), contentRect(cell, nw, nh), 0.5, `${who} · footprint wraps content`);

    // 3. Content fixed on the die.
    for (const p of pts) {
      const before = worldPoint(prev, w, h, p);
      const after = worldPoint(cell, nw, nh, moved(p));
      expect(Math.abs(after.x - before.x), `${who} · content moved (x) at ${p.x},${p.y}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(after.y - before.y), `${who} · content moved (y) at ${p.x},${p.y}`).toBeLessThanOrEqual(0.5);
    }
  }

  // The dragged edge of A lands where the pointer put it.
  const fpA2 = cellWorldRect(res.cells.find((c) => c.cell.id === "a")!.cell, nw, nh);
  const edgeA = { left: fpA2.x, right: fpA2.x + fpA2.width, top: fpA2.y, bottom: fpA2.y + fpA2.height }[sDie];
  expect(edgeA, `${msg} · dragged edge lands on the pointer`).toBe(edgePos);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("resizeCellType · orientation-aware (D4 properties)", () => {
  it("spec matrix M = R(θ)·F agrees with applyOrientation for all flag combos", () => {
    const rng = mulberry32(SEED);
    for (const o of ORIENTATIONS)
      for (let i = 0; i < 20; i++) {
        const w = randInt(rng, 1, 80);
        const h = randInt(rng, 1, 80);
        const p = { x: randInt(rng, -20, 100), y: randInt(rng, -20, 100) };
        const cell = { id: "c", cellTypeId: "t", x: 0, y: 0, ...o } as Cell;
        expect(worldPoint(cell, w, h, p), `seed ${SEED} · ${oName(o)}`).toEqual(applyOrientation(p, o, w, h));
      }
  });

  it("exhaustive: every (A, B) orientation pair × dragged side, random geometry", () => {
    const rng = mulberry32(SEED ^ 0x9e3779b9);
    for (const oA of ORIENTATIONS)
      for (const oB of ORIENTATIONS)
        for (const side of SIDES) for (let k = 0; k < 2; k++) runTrial(rng, oA, oB, side, `exhaustive#${k}`);
  });

  it("random: fully random orientations, sides, sizes and drags", () => {
    const rng = mulberry32(SEED ^ 0x85ebca6b);
    for (let i = 0; i < 2000; i++)
      runTrial(rng, pick(rng, ORIENTATIONS), pick(rng, ORIENTATIONS), pick(rng, SIDES), `random#${i}`);
  });
});
