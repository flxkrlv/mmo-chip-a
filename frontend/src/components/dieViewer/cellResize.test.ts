import { describe, expect, it } from "vitest";
import type { Cell, CellType } from "shared";
import { cellWorldRect, resizeCell, retypeCellKeepingSize, type CellSide } from "./cellResize";

const type = (id: string, width: number, height: number): CellType =>
  ({ id, name: id, cropRect: { x: 0, y: 0, width, height } }) as CellType;

const rotations = [0, 90, 180, 270] as const;
const sides: CellSide[] = ["left", "right", "top", "bottom"];

describe("resizeCell", () => {
  for (const rotation of rotations)
    for (const flippedH of [false, true])
      for (const side of sides)
        it(`moves only the dragged edge (rot ${rotation}, flipH ${flippedH}, ${side})`, () => {
          const ct = type("t", 40, 20);
          const cell: Cell = { id: "a", cellTypeId: "t", x: 100, y: 200, rotation, flippedH };
          const r = cellWorldRect(cell, 40, 20);
          const edge = { left: r.x - 6, right: r.x + r.width + 6, top: r.y - 6, bottom: r.y + r.height + 6 }[side];

          const next = resizeCell(cell, ct, side, edge)!;
          // Type, placement and orientation untouched — only bounds change.
          expect(next).toMatchObject({ cellTypeId: "t", x: 100, y: 200, rotation, flippedH });
          expect(ct.cropRect).toEqual({ x: 0, y: 0, width: 40, height: 20 });

          const nr = cellWorldRect(next, 40, 20);
          const expected = {
            left: { ...r, x: r.x - 6, width: r.width + 6 },
            right: { ...r, width: r.width + 6 },
            top: { ...r, y: r.y - 6, height: r.height + 6 },
            bottom: { ...r, height: r.height + 6 }
          }[side];
          expect(nr).toEqual(expected);
        });

  it("drops the override when resized back to the type box", () => {
    const ct = type("t", 40, 20);
    const cell: Cell = { id: "a", cellTypeId: "t", x: 0, y: 0 };
    const grown = resizeCell(cell, ct, "right", 50)!;
    expect(grown.bounds).toEqual({ x: 0, y: 0, width: 50, height: 20 });
    expect(resizeCell(grown, ct, "right", 40)!.bounds).toBeUndefined();
  });

  it("clamps to a minimum size of 1", () => {
    const ct = type("t", 40, 20);
    const cell: Cell = { id: "a", cellTypeId: "t", x: 0, y: 0 };
    expect(resizeCell(cell, ct, "right", -100)!.bounds!.width).toBe(1);
  });
});

describe("retypeCellKeepingSize", () => {
  for (const rotation of rotations)
    for (const flippedV of [false, true])
      it(`keeps the world footprint (rot ${rotation}, flipV ${flippedV})`, () => {
        const oldT = type("a", 40, 20);
        const newT = type("b", 30, 30);
        const cell: Cell = { id: "c", cellTypeId: "a", x: 100, y: 200, rotation, flippedV };
        const next = retypeCellKeepingSize(cell, oldT, newT);
        expect(next.cellTypeId).toBe("b");
        expect(cellWorldRect(next, 30, 30)).toEqual(cellWorldRect(cell, 40, 20));
      });

  it("keeps a resized cell's size too", () => {
    const oldT = type("a", 40, 20);
    const newT = type("b", 10, 10);
    const cell = resizeCell({ id: "c", cellTypeId: "a", x: 0, y: 0, rotation: 90 }, oldT, "bottom", 50)!;
    const next = retypeCellKeepingSize(cell, oldT, newT);
    expect(cellWorldRect(next, 10, 10)).toEqual(cellWorldRect(cell, 40, 20));
  });

  it("needs no override when the new type has the same size", () => {
    const next = retypeCellKeepingSize({ id: "c", cellTypeId: "a", x: 5, y: 5 }, type("a", 40, 20), type("b", 40, 20));
    expect(next.bounds).toBeUndefined();
  });
});
