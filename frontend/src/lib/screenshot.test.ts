import { describe, expect, it } from "vitest";
import { clampScreenshotScale, maxScreenshotScale, screenshotSize } from "./screenshot";

describe("screenshot sizing", () => {
  it("scales the screen canvas", () => {
    expect(screenshotSize(1920, 1080, 2)).toEqual({ width: 3840, height: 2160 });
    expect(screenshotSize(1920, 1080, 0.5)).toEqual({ width: 960, height: 540 });
  });

  it("caps by the longest side and the area, on the slider grid", () => {
    expect(maxScreenshotScale(1920, 1080)).toBe(7.5); // area: sqrt(120M / 2.07M) ≈ 7.6
    expect(maxScreenshotScale(4000, 500)).toBe(4); // side: 16384 / 4000 ≈ 4.1
    expect(maxScreenshotScale(800, 600)).toBe(8); // slider top
  });

  it("snaps and clamps a remembered scale", () => {
    expect(clampScreenshotScale(2.1, 8)).toBe(2);
    expect(clampScreenshotScale(9, 4)).toBe(4);
    expect(clampScreenshotScale(0.1, 4)).toBe(0.5);
  });
});
