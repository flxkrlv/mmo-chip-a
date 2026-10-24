import { describe, expect, it } from "vitest";
import {
  MARQUEE_MIN_SECONDS,
  MARQUEE_PX_PER_SECOND,
  marqueeDuration,
  marqueeNeeded
} from "./statusMarquee";

describe("the status line ticker", () => {
  it("scrolls only when the text does not fit", () => {
    expect(marqueeNeeded(400, 600)).toBe(false);
    expect(marqueeNeeded(600, 600)).toBe(false);
    // A pixel of slack is not an overflow.
    expect(marqueeNeeded(601, 600)).toBe(false);
    expect(marqueeNeeded(602, 600)).toBe(true);
  });

  it("keeps the same speed whatever the length of the text", () => {
    const short = marqueeDuration(400);
    const long = marqueeDuration(1200);
    expect(long / short).toBeCloseTo(3, 6);
    expect(short).toBeCloseTo(400 / MARQUEE_PX_PER_SECOND, 6);
  });

  it("never scrolls faster than the minimum pass", () => {
    expect(marqueeDuration(10)).toBe(MARQUEE_MIN_SECONDS);
    expect(marqueeDuration(0)).toBe(0);
    expect(marqueeDuration(-5)).toBe(0);
    expect(marqueeDuration(100, 0)).toBe(0);
  });
});
