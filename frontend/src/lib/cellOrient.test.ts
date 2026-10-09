import { describe, expect, it } from "vitest";
import type { Cell } from "shared";
import { applyOrientation, type Point } from "./geometry";
import { cellWorldRect, dieToTypeMatrix } from "./cellFootprint";
import { orientInTypeFrame, orientOnDie, type Orient, type OrientOp, type Rotation } from "./mergeCells";

const ALL: Orient[] = [];
for (const rotation of [0, 90, 180, 270] as Rotation[])
  for (const flippedH of [false, true])
    for (const flippedV of [false, true]) ALL.push({ rotation, flippedH, flippedV });

const OPS: OrientOp[] = ["rotateCw", "flipH", "flipV"];
/** The op as a linear map on screen vectors (y down). */
const opMap = (op: OrientOp, p: Point): Point =>
  op === "rotateCw" ? { x: -p.y, y: p.x } : op === "flipH" ? { x: -p.x, y: p.y } : { x: p.x, y: -p.y };
const M = (o: Orient, p: Point) => applyOrientation(p, o, 0, 0);
const PTS: Point[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 3, y: -7 }];
const close = (a: Point, b: Point) => {
  expect(a.x).toBeCloseTo(b.x);
  expect(a.y).toBeCloseTo(b.y);
};

describe("orientation operators", () => {
  it("on the die: the content turns / mirrors as seen (M' = OP·M)", () => {
    for (const o of ALL) for (const op of OPS) {
      const next = orientOnDie(o, op);
      for (const p of PTS) close(M(next, p), opMap(op, M(o, p)));
    }
  });

  it("in the type frame: the shown crop turns / mirrors as seen (M'⁻¹ = OP·M⁻¹)", () => {
    for (const o of ALL) for (const op of OPS) {
      const next = orientInTypeFrame(o, op);
      // M'⁻¹ = OP·M⁻¹  ⇔  M' = M·OP⁻¹  ⇔  M'·OP = M
      for (const p of PTS) close(M(next, opMap(op, p)), M(o, p));
    }
  });

  it("die rotation keeps the footprint centre and swaps its sides", () => {
    const cell: Cell = { id: "c", cellTypeId: "t", x: 100, y: 200 };
    const before = cellWorldRect(cell, 20, 40);
    const after = cellWorldRect({ ...cell, ...orientOnDie({ flippedH: false, flippedV: false, rotation: 0 }, "rotateCw") }, 20, 40);
    expect(after).toEqual({ x: 90, y: 210, width: 40, height: 20 });
    expect(after.x + after.width / 2).toBe(before.x + before.width / 2);
    expect(after.y + after.height / 2).toBe(before.y + before.height / 2);
  });
});

describe("dieToTypeMatrix", () => {
  it("takes the oriented footprint back onto the upright type box", () => {
    for (const o of ALL) {
      const cell: Cell = { id: "c", cellTypeId: "t", x: 0, y: 0, ...o };
      const [a, b, c, d, e, f] = dieToTypeMatrix(cell, 20, 40);
      for (const p of [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 5, y: 33 }]) {
        const q = applyOrientation(p, cell, 20, 40); // type → die
        close({ x: a * q.x + c * q.y + e, y: b * q.x + d * q.y + f }, p);
      }
    }
  });
});
