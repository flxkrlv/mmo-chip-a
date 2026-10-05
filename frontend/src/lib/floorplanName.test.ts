import { describe, expect, it } from "vitest";
import { floorplanNameInline, floorplanNameLines, normalizeFloorplanName } from "./floorplanName";

describe("multiline floorplan names", () => {
  it("normalizes line endings, trailing spaces and blank edge lines", () => {
    expect(normalizeFloorplanName("\n  \nBandgap  \r\nref\r\n\n")).toBe("Bandgap\nref");
    expect(normalizeFloorplanName("VCC_UVLO")).toBe("VCC_UVLO");
    expect(normalizeFloorplanName(" \n ")).toBe("");
  });

  it("keeps inner blank lines for the canvas label", () => {
    expect(floorplanNameLines("A\n\nB")).toEqual(["A", "", "B"]);
    expect(floorplanNameLines("")).toEqual([]);
  });

  it("joins non-blank lines for single-line display", () => {
    expect(floorplanNameInline("Bandgap\n\n  1.2 V ref ")).toBe("Bandgap · 1.2 V ref");
    expect(floorplanNameInline("OSC")).toBe("OSC");
  });
});
