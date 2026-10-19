import { describe, expect, it } from "vitest";
import { analogFootprint, analogResizeFromCorner, type AnalogDraft } from "./analogPlacement";

const draft = (over: Partial<AnalogDraft> = {}): AnalogDraft => ({
  cx: 100,
  cy: 100,
  k: 1,
  rotation: 0,
  flippedH: false,
  flippedV: false,
  ...over
});

describe("analogFootprint", () => {
  it("is the generated box, centred on the draft", () => {
    expect(analogFootprint(draft(), 40, 20)).toEqual({ x: 80, y: 90, width: 40, height: 20 });
  });

  it("follows the stretch", () => {
    expect(analogFootprint(draft({ k: 2 }), 40, 20)).toEqual({ x: 60, y: 80, width: 80, height: 40 });
  });

  it("swaps the extents on a quarter turn", () => {
    expect(analogFootprint(draft({ rotation: 90 }), 40, 20)).toEqual({ x: 90, y: 80, width: 20, height: 40 });
  });
});

describe("analogResizeFromCorner", () => {
  it("stretches the template towards the pointer, the opposite corner pinned", () => {
    const d = draft();
    // Drag the bottom-right corner (index 2) twice as far out — along the
    // box diagonal, so the stretch is uniform.
    const next = analogResizeFromCorner(d, 40, 20, 2, { x: 160, y: 130 });
    expect(next.k).toBeCloseTo(2, 6);
    // The top-left corner (80, 90) stays put.
    expect(analogFootprint(next, 40, 20)).toEqual({ x: 80, y: 90, width: 80, height: 40 });
  });

  it("projects the pointer onto the diagonal, so the aspect never changes", () => {
    // (160, 120) is off the diagonal: the projection is 1.9, not 2.
    const next = analogResizeFromCorner(draft(), 40, 20, 2, { x: 160, y: 120 });
    expect(next.k).toBeCloseTo(1.9, 6);
  });

  it("keeps the aspect ratio", () => {
    const next = analogResizeFromCorner(draft(), 40, 20, 2, { x: 200, y: 300 });
    const fp = analogFootprint(next, 40, 20);
    expect(fp.width / fp.height).toBeCloseTo(2, 6);
  });

  it("never shrinks below the minimum", () => {
    const next = analogResizeFromCorner(draft(), 40, 20, 2, { x: 0, y: 0 }, 8);
    expect(analogFootprint(next, 40, 20).width).toBeGreaterThanOrEqual(8);
  });
});
