import { describe, expect, it } from "vitest";
import type { CellType } from "shared";
import { CELL_TYPE_PALETTE, colorOwner, nextFreeColor, normHex } from "./cellTypeColor";

const ct = (id: string, color?: string): CellType => ({
  id,
  name: id,
  cropRect: { x: 0, y: 0, width: 10, height: 10 },
  color
});

describe("cellTypeColor", () => {
  it("normalises hex colors", () => {
    expect(normHex(" #AbCdEf ")).toBe("#abcdef");
    expect(normHex("#abc")).toBeNull();
    expect(normHex(undefined)).toBeNull();
  });

  it("finds the other type owning a color, case-insensitively", () => {
    const types = [ct("a", "#EF4444"), ct("b")];
    expect(colorOwner(types, "#ef4444", "b")?.id).toBe("a");
    // A type never conflicts with itself.
    expect(colorOwner(types, "#ef4444", "a")).toBeNull();
  });

  it("suggests the first unused palette color", () => {
    const types = [ct("a", CELL_TYPE_PALETTE[0].value), ct("b")];
    expect(nextFreeColor(types, "b")).toBe(CELL_TYPE_PALETTE[1].value);
    expect(nextFreeColor(types, "a")).toBe(CELL_TYPE_PALETTE[0].value);
  });
});
