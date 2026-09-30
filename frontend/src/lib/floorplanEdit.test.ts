import { describe, expect, it } from "vitest";
import {
  deleteVertex,
  dragRectHandle,
  edgeMidpoints,
  insertVertex,
  isDegenerate,
  isPolyRegion,
  moveVertex,
  rectHandlePoint,
  translateGeometry
} from "./floorplanEdit";

const rect = [
  { x: 100, y: 50 },
  { x: 10, y: 20 } // corners stored in any order
];

describe("rect handles", () => {
  it("positions handles on the normalised rect", () => {
    expect(rectHandlePoint(rect, "nw")).toEqual({ x: 10, y: 20 });
    expect(rectHandlePoint(rect, "se")).toEqual({ x: 100, y: 50 });
    expect(rectHandlePoint(rect, "n")).toEqual({ x: 55, y: 20 });
    expect(rectHandlePoint(rect, "e")).toEqual({ x: 100, y: 35 });
  });

  it("corner drag moves two sides, edge drag one", () => {
    expect(dragRectHandle(rect, "se", { x: 120, y: 80 })).toEqual([
      { x: 10, y: 20 },
      { x: 120, y: 80 }
    ]);
    // Edge handle ignores the other axis of the pointer.
    expect(dragRectHandle(rect, "w", { x: 0, y: 999 })).toEqual([
      { x: 0, y: 20 },
      { x: 100, y: 50 }
    ]);
  });

  it("dragging past the opposite side flips instead of inverting", () => {
    expect(dragRectHandle(rect, "e", { x: 5, y: 0 })).toEqual([
      { x: 5, y: 20 },
      { x: 10, y: 50 }
    ]);
  });
});

describe("polygon vertices", () => {
  const tri = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: 10 }
  ];

  it("moves one vertex", () => {
    expect(moveVertex(tri, 1, { x: 20, y: 5 })).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 5 },
      { x: 0, y: 10 }
    ]);
  });

  it("inserts after an edge start, including the closing edge", () => {
    expect(insertVertex(tri, 0, { x: 5, y: -3 })[1]).toEqual({ x: 5, y: -3 });
    expect(insertVertex(tri, 2, { x: -3, y: 5 })).toHaveLength(4);
    expect(insertVertex(tri, 2, { x: -3, y: 5 })[3]).toEqual({ x: -3, y: 5 });
  });

  it("midpoints wrap around to the closing edge", () => {
    expect(edgeMidpoints(tri)).toEqual([
      { x: 5, y: 0 },
      { x: 5, y: 5 },
      { x: 0, y: 5 }
    ]);
  });

  it("refuses to delete below three vertices", () => {
    expect(deleteVertex(tri, 0)).toBeNull();
    const quad = insertVertex(tri, 0, { x: 5, y: -3 });
    expect(deleteVertex(quad, 1)).toEqual(tri);
  });
});

describe("misc", () => {
  it("translates every point", () => {
    expect(translateGeometry(rect, 1, -2)).toEqual([
      { x: 101, y: 48 },
      { x: 11, y: 18 }
    ]);
  });

  it("accepts legacy 'poly' kind", () => {
    expect(isPolyRegion({ kind: "poly" as never })).toBe(true);
    expect(isPolyRegion({ kind: "rect" })).toBe(false);
  });

  it("flags zero-area rects", () => {
    expect(isDegenerate({ kind: "rect" }, [{ x: 1, y: 1 }, { x: 1, y: 50 }])).toBe(true);
    expect(isDegenerate({ kind: "rect" }, rect)).toBe(false);
  });
});
