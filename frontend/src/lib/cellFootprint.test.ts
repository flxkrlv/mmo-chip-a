import { describe, expect, it } from "vitest";
import type { Cell, CellType, DieAnnotations } from "shared";
import { cellWorldRect } from "./cellFootprint";
import { buildMergeAction, buildOrientAction } from "./mergeCells";

const type = (id: string, width: number, height: number, matched = false): CellType =>
  ({ id, name: id, cropRect: { x: 0, y: 0, width, height }, matched }) as CellType;

const upserted = (a: ReturnType<typeof buildOrientAction>): Cell => {
  const one = a.kind === "batch" ? a.actions.find((x) => x.kind === "upsertCell")! : a;
  if (one.kind !== "upsertCell") throw new Error("no upsertCell");
  return one.cell;
};

describe("die footprint vs orientation", () => {
  const cell: Cell = { id: "c", cellTypeId: "a", x: 100, y: 200 };

  it("rotating / flipping never moves the footprint", () => {
    const base = cellWorldRect(cell, 40, 20);
    expect(base).toEqual({ x: 100, y: 200, width: 40, height: 20 });
    for (const patch of [
      { rotation: 90 as const },
      { rotation: 270 as const, flippedH: true },
      { flippedV: true },
      { rotation: 180 as const, flippedH: true, flippedV: true }
    ]) {
      expect(cellWorldRect(upserted(buildOrientAction(cell, patch)), 40, 20)).toEqual(base);
    }
  });

  it("translation after rotation/flip moves the footprint by the die delta only", () => {
    const rotated = upserted(buildOrientAction(cell, { rotation: 90, flippedH: true }));
    // MergeCanvas hands onAlign an already un-rotated, un-mirrored die delta.
    const moved = upserted(buildOrientAction(rotated, { x: rotated.x + 7, y: rotated.y - 3 }));
    expect(cellWorldRect(moved, 40, 20)).toEqual({ x: 107, y: 197, width: 40, height: 20 });
    expect(moved).toMatchObject({ rotation: 90, flippedH: true });
  });

  it("merging adopts the specimen type's size", () => {
    const candType = type("a", 40, 20);
    const specimen = type("s", 22, 44, true);
    const cand: Cell = { id: "c", cellTypeId: "a", x: 100, y: 200, rotation: 90, bounds: { x: 1, y: 1, width: 9, height: 9 } };
    const ann = { cells: [cand], cellTypes: [candType, specimen] } as unknown as DieAnnotations;
    const plan = buildMergeAction(ann, cand, specimen, { flippedH: false, flippedV: false, rotation: 90, x: 100, y: 200 });
    const merged = upserted(plan.action);
    expect(merged.cellTypeId).toBe("s");
    expect(merged.bounds).toBeUndefined();
    expect(cellWorldRect(merged, 22, 44)).toEqual({ x: 100, y: 200, width: 22, height: 44 });
  });
});
