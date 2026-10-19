import { describe, expect, it } from "vitest";
import type { Cell, CellType } from "shared";
import { buildCellAnnotation } from "./dieAnnotations";

const type: CellType = {
  id: "t",
  name: "t",
  cropRect: { x: 0, y: 0, width: 40, height: 20 }
};

const cell = (over: Partial<Cell> = {}): Cell => ({
  id: "c",
  cellTypeId: "t",
  x: 100,
  y: 200,
  ...over
});

const build = (c: Cell, dieScale?: number) =>
  buildCellAnnotation(c, type, () => "#fff", () => true, undefined, dieScale);

describe("buildCellAnnotation", () => {
  it("draws a cell at the library's default scale", () => {
    expect(build(cell(), 20).bbox).toEqual({ x: 100, y: 200, width: 40, height: 20 });
  });

  it("grows the footprint with the cell's own scale", () => {
    expect(build(cell({ scale: 40 }), 20).bbox).toEqual({ x: 100, y: 200, width: 80, height: 40 });
    expect(build(cell({ scale: 10 }), 20).bbox).toEqual({ x: 100, y: 200, width: 20, height: 10 });
  });

  it("keeps a generated device at the size it was laid out at", () => {
    const generated: CellType = {
      ...type,
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
    const a = buildCellAnnotation(
      cell({ scale: 20 }),
      generated,
      () => "#fff",
      () => true,
      undefined,
      20
    );
    expect(a.bbox).toEqual({ x: 100, y: 200, width: 40, height: 20 });
  });
});
