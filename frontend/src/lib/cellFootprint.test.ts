import { describe, expect, it } from "vitest";
import type { Cell, CellType, DieAnnotations } from "shared";
import { boundsForWorldRect, cellInstanceScale, cellWorldRect } from "./cellFootprint";
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

  it("mirrors / 180° keep the footprint; 90° / 270° swap it about the centre", () => {
    const base = cellWorldRect(cell, 40, 20);
    expect(base).toEqual({ x: 100, y: 200, width: 40, height: 20 });
    for (const patch of [{ flippedV: true }, { flippedH: true }, { rotation: 180 as const, flippedH: true, flippedV: true }]) {
      expect(cellWorldRect(upserted(buildOrientAction(cell, patch)), 40, 20)).toEqual(base);
    }
    for (const patch of [{ rotation: 90 as const }, { rotation: 270 as const, flippedH: true }]) {
      expect(cellWorldRect(upserted(buildOrientAction(cell, patch)), 40, 20)).toEqual({ x: 110, y: 190, width: 20, height: 40 });
    }
  });

  it("bounds are type-frame and round-trip through boundsForWorldRect", () => {
    for (const rotation of [0, 90, 180, 270] as const)
      for (const flippedH of [false, true]) {
        const c: Cell = { ...cell, rotation, flippedH, bounds: { x: -3, y: 2, width: 31, height: 17 } };
        const r = cellWorldRect(c, 41, 20);
        expect(boundsForWorldRect(c, 41, 20, r)).toEqual(c.bounds);
        expect(boundsForWorldRect(c, 41, 20, cellWorldRect({ ...c, bounds: undefined }, 41, 20))).toBeUndefined();
      }
  });

  it("translation after rotation/flip moves the footprint by the die delta only", () => {
    const rotated = upserted(buildOrientAction(cell, { rotation: 90, flippedH: true }));
    // MergeCanvas hands onAlign an already un-rotated, un-mirrored die delta.
    const moved = upserted(buildOrientAction(rotated, { x: rotated.x + 7, y: rotated.y - 3 }));
    expect(cellWorldRect(moved, 40, 20)).toEqual({ x: 117, y: 187, width: 20, height: 40 });
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
    // The candidate box centre (120, 210) is kept: 44×22 on the die around it.
    expect(merged).toMatchObject({ x: 109, y: 188 });
    expect(cellWorldRect(merged, 22, 44)).toEqual({ x: 98, y: 199, width: 44, height: 22 });
  });
});

describe("cellInstanceScale", () => {
  const plain = type("a", 40, 20);

  it("draws a cell at the library's default scale", () => {
    expect(cellInstanceScale({ id: "c", cellTypeId: "a", x: 0, y: 0 }, plain, 20)).toBe(1);
  });

  it("lets a cell carry its own scale", () => {
    const cell: Cell = { id: "c", cellTypeId: "a", x: 0, y: 0, scale: 10 };
    expect(cellInstanceScale(cell, plain, 20)).toBe(0.5);
    expect(cellInstanceScale(cell, plain, 10)).toBe(1);
  });

  it("keeps a generated device at its own scale (its layers are final)", () => {
    const generated: CellType = {
      ...plain,
      pcell: {
        template: "pmos",
        params: { kind: "mos", mosType: "pmos", fingers: 1, W_um: 10, L_um: 1, bulk: "none" },
        scale: 20,
        rules: {
          spacing: 1, polyOverhang: 0.5, polyStrap: 0.4, contactSize: 0.4,
          metal1Pad: 0.3, wellMargin: 1, baseMargin: 0.5, collectorWidth: 1,
          lpnpEmitterCollectorGap: 0.8, lpnpBaseCollectorGap: 0.8, lpnpCollectorWidth: 1
        }
      }
    };
    const cell: Cell = { id: "c", cellTypeId: "a", x: 0, y: 0, scale: 20 };
    expect(cellInstanceScale(cell, generated, 20)).toBe(1);
    // A device re-generated at another scale is drawn at its own scale.
    expect(cellInstanceScale({ ...cell, scale: 40 }, generated, 20)).toBe(2);
  });
});
