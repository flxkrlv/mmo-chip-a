import { describe, expect, it } from "vitest";
import type { Cell, CellType, DieAnnotations } from "shared";
import { applyOrientation } from "../../lib/geometry";
import { cellWorldRect, resizeCellType, type CellSide } from "./cellResize";
import { retypeCell } from "../../lib/cellFootprint";

const type = (id: string, width: number, height: number): CellType =>
  ({ id, name: id, cropRect: { x: 0, y: 0, width, height } }) as CellType;

const rotations = [0, 90, 180, 270] as const;
const sides: CellSide[] = ["left", "right", "top", "bottom"];

const world = (p: { x: number; y: number }, c: Cell, w: number, h: number) => {
  const q = applyOrientation(p, c, w, h);
  return { x: c.x + q.x, y: c.y + q.y };
};

describe("resizeCellType", () => {
  for (const rotation of rotations)
    for (const flippedH of [false, true])
      for (const side of sides)
        it(`resizes every instance the same, content fixed (rot ${rotation}, flipH ${flippedH}, ${side})`, () => {
          const ct = {
            ...type("t", 40, 20),
            layers: { metal1: [{ id: "s", kind: "point", x: 6, y: 4, size: 1 }] }
          } as CellType;
          const cell: Cell = { id: "a", cellTypeId: "t", x: 100, y: 200, rotation, flippedH };
          // A sibling with another orientation and an individual size override.
          const other: Cell = {
            id: "b", cellTypeId: "t", x: 500, y: 600, rotation: 90, flippedV: true,
            bounds: { x: -2, y: 1, width: 30, height: 25 }
          };
          const unrelated: Cell = { id: "z", cellTypeId: "u", x: 0, y: 0 };
          const ann = { cells: [cell, other, unrelated], cellTypes: [ct, type("u", 5, 5)] } as unknown as DieAnnotations;

          const r = cellWorldRect(cell, 40, 20);
          const edge = { left: r.x - 6, right: r.x + r.width + 6, top: r.y - 6, bottom: r.y + r.height + 6 }[side];
          const res = resizeCellType(ann, cell, ct, side, edge)!;
          const { width: nw, height: nh } = res.cellType.cropRect;
          expect(res.cellType.id).toBe("t");
          expect(res.cells.map((c) => c.cell.id)).toEqual(["a", "b"]);

          const grow = (fp: ReturnType<typeof cellWorldRect>) =>
            ({
              left: { ...fp, x: fp.x - 6, width: fp.width + 6 },
              right: { ...fp, width: fp.width + 6 },
              top: { ...fp, y: fp.y - 6, height: fp.height + 6 },
              bottom: { ...fp, height: fp.height + 6 }
            })[side];
          const s = res.cellType.layers!.metal1![0] as { x: number; y: number };
          for (const [i, prev] of [cell, other].entries()) {
            const next = res.cells[i].cell;
            // Same die-axis change for every instance.
            expect(cellWorldRect(next, nw, nh)).toEqual(grow(cellWorldRect(prev, 40, 20)));
            // Content stays put (±0.5 px rounding on odd half-shifts).
            const a = world(s, next, nw, nh);
            const b = world({ x: 6, y: 4 }, prev, 40, 20);
            expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(0.5);
            expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(0.5);
          }
          // An unrotated default cell needs no per-instance override.
          if (rotation === 0 && !flippedH) expect(res.cells[0].cell.bounds).toBeUndefined();
        });

  it("clamps to a minimum size of 1", () => {
    const ct = type("t", 40, 20);
    const cell: Cell = { id: "a", cellTypeId: "t", x: 0, y: 0 };
    const ann = { cells: [cell], cellTypes: [ct] } as unknown as DieAnnotations;
    expect(resizeCellType(ann, cell, ct, "right", -100)!.cellType.cropRect.width).toBe(1);
  });
});

describe("retypeCell", () => {
  it("adopts the target type's size at the same origin", () => {
    const cell: Cell = {
      id: "c", cellTypeId: "a", x: 100, y: 200, rotation: 90,
      bounds: { x: -3, y: 2, width: 55, height: 12 }
    };
    const next = retypeCell(cell, "b");
    expect(next.cellTypeId).toBe("b");
    expect(next.bounds).toBeUndefined();
    expect(cellWorldRect(next, 30, 30)).toEqual({ x: 100, y: 200, width: 30, height: 30 });
    expect(next).toMatchObject({ rotation: 90 });
  });
});
