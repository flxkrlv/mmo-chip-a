import { describe, expect, it } from "vitest";
import {
  maxScreenshotScale,
  nativeScreenshotScale,
  resolveScreenshotScale,
  screenshotSize,
  snapScreenshotScale
} from "./screenshot";

describe("screenshot sizing", () => {
  it("scales the screen canvas", () => {
    expect(screenshotSize(1920, 1080, 2)).toEqual({ width: 3840, height: 2160 });
  });

  it("native = one output px per finest image px", () => {
    // Zoomed out 1:40 on a dpr-2 screen: 20× gives 1 px per source px.
    expect(nativeScreenshotScale(1 / 40, 2)).toBeCloseTo(20);
    expect(nativeScreenshotScale(1 / 40, 2, 0.5)).toBeCloseTo(40);
  });

  it("the slider tops out at native, at least 4×, within the pixel budget", () => {
    expect(maxScreenshotScale(1920, 1080, 20)).toBe(20);
    expect(maxScreenshotScale(1920, 1080, 0.3)).toBe(4);
    // 1920×1080 × s² ≤ 2 GP ⇒ s ≤ ~31.
    expect(maxScreenshotScale(1920, 1080, 100)).toBeCloseTo(Math.sqrt(2e9 / (1920 * 1080)));
  });

  it("resolves 'native' and clamps numbers", () => {
    expect(resolveScreenshotScale("native", 20, 31)).toBe(20);
    expect(resolveScreenshotScale("native", 50, 31)).toBe(31);
    expect(resolveScreenshotScale(0.1, 20, 31)).toBe(0.5);
    expect(resolveScreenshotScale(3, 20, 31)).toBe(3);
  });

  it("snaps to readable steps", () => {
    expect(snapScreenshotScale(1.1)).toBe(1);
    expect(snapScreenshotScale(3.3)).toBe(3.5);
    expect(snapScreenshotScale(17.4)).toBe(17);
  });
});
