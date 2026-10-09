import { describe, expect, it } from "vitest";
import {
  addWarpLine,
  axisKnots,
  moveWarpKnot,
  normalizeWarp,
  removeWarpKnot,
  segmentScales,
  unwarpValue,
  warpPieces,
  warpValue
} from "./cellWarp";

describe("cell stretch (warp)", () => {
  it("a new line pins the content under it without changing the picture", () => {
    const w = addWarpLine(undefined, "x", 30, 100)!;
    expect(w.x).toEqual([{ src: 0, dst: 0 }, { src: 30, dst: 30 }, { src: 100, dst: 100 }]);
    // Identity still: normalising drops nothing but the picture is unchanged.
    for (const v of [0, 12, 30, 77, 100]) expect(warpValue(w.x!, v)).toBeCloseTo(v);
  });

  it("dragging the line stretches the two sides differently", () => {
    const w = moveWarpKnot(addWarpLine(undefined, "x", 40, 100)!, "x", 1, 50, 100);
    expect(segmentScales(w.x!)).toEqual([50 / 40, 50 / 60]);
    expect(warpValue(w.x!, 20)).toBeCloseTo(25);
    expect(warpValue(w.x!, 70)).toBeCloseTo(75);
    expect(unwarpValue(w.x!, 75)).toBeCloseTo(70);
  });

  it("a line drawn on a stretched picture lands on the content shown there", () => {
    const w1 = moveWarpKnot(addWarpLine(undefined, "x", 40, 100)!, "x", 1, 50, 100);
    const w2 = addWarpLine(w1, "x", 75, 100)!;
    expect(w2.x!.map((k) => k.src)).toEqual([0, 40, 70, 100]);
    expect(w2.x![2]).toEqual({ src: 70, dst: 75 });
  });

  it("lines can't cross their neighbours, and edges move too", () => {
    const w = addWarpLine(undefined, "y", 50, 80)!;
    expect(moveWarpKnot(w, "y", 1, 500, 80).y![1].dst).toBe(79);
    expect(moveWarpKnot(w, "y", 1, -5, 80).y![1].dst).toBe(1);
    const edge = moveWarpKnot(w, "y", 2, 90, 80);
    expect(edge.y![2]).toEqual({ src: 80, dst: 90 });
  });

  it("double-click removes a line, or resets an edge; identity goes away", () => {
    const w = moveWarpKnot(addWarpLine(undefined, "x", 40, 100)!, "x", 2, 104, 100);
    const noLine = removeWarpKnot(w, "x", 1, 100)!;
    expect(noLine.x).toEqual([{ src: 0, dst: 0 }, { src: 100, dst: 104 }]);
    expect(removeWarpKnot(noLine, "x", 1, 100)).toBeUndefined();
  });

  it("refuses lines outside the box or on top of another", () => {
    expect(addWarpLine(undefined, "x", 0, 100)).toBeNull();
    expect(addWarpLine(undefined, "x", 120, 100)).toBeNull();
    const w = addWarpLine(undefined, "x", 40, 100)!;
    expect(addWarpLine(w, "x", 40.5, 100)).toBeNull();
  });

  it("pieces tile the shown box", () => {
    const w = normalizeWarp({
      ...moveWarpKnot(addWarpLine(undefined, "x", 40, 100)!, "x", 1, 50, 100),
      ...addWarpLine(undefined, "y", 20, 60)!
    });
    const pieces = warpPieces(w, 100, 60);
    expect(pieces).toHaveLength(4);
    expect(pieces[0]).toMatchObject({ sx0: 0, sx1: 40, dx0: 0, dx1: 50, sy0: 0, sy1: 20 });
    expect(axisKnots(w?.y, 60)).toHaveLength(3);
  });
});
