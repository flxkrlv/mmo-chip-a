import { describe, expect, it } from "vitest";
import type { Cell, CellType } from "shared";
import { floorplanEnclosure } from "./cellDetection";

const type = (id: string, w: number, h: number): CellType =>
  ({
    id,
    name: id,
    color: "#000",
    createdAt: "",
    updatedAt: "",
    cropRect: { x: 0, y: 0, width: w, height: h }
  }) as unknown as CellType;

const cell = (id: string, cellTypeId: string, x: number, y: number): Cell =>
  ({ id, cellTypeId, x, y }) as unknown as Cell;

describe("floorplanEnclosure", () => {
  const types = [type("t1", 100, 50), type("t2", 40, 40)];

  it("encloses a single hit cell", () => {
    const cells = [cell("a", "t1", 10, 20)];
    expect(floorplanEnclosure(cells, types, [], "a")).toEqual({
      rect: { x: 10, y: 20, width: 100, height: 50 },
      label: "cell"
    });
  });

  it("encloses the whole selection (union of footprints)", () => {
    const cells = [cell("a", "t1", 10, 20), cell("b", "t2", 200, 100)];
    expect(floorplanEnclosure(cells, types, ["a", "b"])).toEqual({
      rect: { x: 10, y: 20, width: 230, height: 120 },
      label: "selection"
    });
  });

  it("returns null with nothing selected and no hit cell", () => {
    const cells = [cell("a", "t1", 10, 20)];
    expect(floorplanEnclosure(cells, types, [], null)).toBeNull();
  });

  it("skips cells whose type is missing", () => {
    const cells = [cell("gone", "nope", 10, 20)];
    expect(floorplanEnclosure(cells, types, ["gone"], "gone")).toBeNull();
  });

  it("accounts for cell orientation via cellFootprint", () => {
    // 90° rotation keeps the centre at (60, 45) and swaps W×H: 100×50 → 50×100.
    const rotated = { ...cell("a", "t1", 10, 20), rotation: 90 };
    expect(floorplanEnclosure([rotated as Cell], types, [], "a")?.rect).toEqual({
      x: 35,
      y: -5,
      width: 50,
      height: 100
    });
  });
});
