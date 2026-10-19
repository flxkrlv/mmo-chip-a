import { describe, expect, it } from "vitest";
import {
  LABEL_SCALE_DEFAULT,
  LABEL_SCALE_MAX,
  LABEL_SCALE_MIN,
  LABEL_SCALE_PRESETS,
  clampLabelScale,
  migrateLabelScale
} from "./labelScale";

describe("the label size", () => {
  it("is a plain number now — the old presets are just values", () => {
    expect(LABEL_SCALE_PRESETS.small).toBe(0.2);
    expect(LABEL_SCALE_PRESETS.medium).toBe(0.5);
    expect(LABEL_SCALE_PRESETS.large).toBe(1);
    expect(LABEL_SCALE_DEFAULT).toBe(0.5);
  });

  it("keeps the factor inside the range the canvas can draw", () => {
    expect(clampLabelScale(0)).toBe(LABEL_SCALE_MIN);
    expect(clampLabelScale(-3)).toBe(LABEL_SCALE_MIN);
    expect(clampLabelScale(1000)).toBe(LABEL_SCALE_MAX);
    expect(clampLabelScale(1.5)).toBe(1.5);
    expect(clampLabelScale(Number.NaN)).toBe(LABEL_SCALE_DEFAULT);
  });

  it("moves the old preset index to its factor", () => {
    expect(migrateLabelScale(0)).toBe(0.2);
    expect(migrateLabelScale(1)).toBe(0.5);
    expect(migrateLabelScale(2)).toBe(1);
  });

  it("keeps a factor that was stored as one", () => {
    expect(migrateLabelScale(1.75)).toBe(1.75);
    expect(migrateLabelScale(0.05)).toBe(0.05);
  });

  it("has nothing to say about a broken value", () => {
    expect(migrateLabelScale(undefined)).toBeUndefined();
    expect(migrateLabelScale(null)).toBeUndefined();
    expect(migrateLabelScale("big")).toBeUndefined();
    expect(migrateLabelScale(0)).not.toBeUndefined();
  });
});
