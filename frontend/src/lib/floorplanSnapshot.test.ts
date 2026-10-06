import { describe, expect, it } from "vitest";
import type { FloorplanRegion } from "shared";
import { drawFloorplansForSnapshot, isFloorplanVisible } from "./floorplanSnapshot";

const region = (extra: Partial<FloorplanRegion>): FloorplanRegion => ({
  id: "r", name: "", kind: "rect", geometry: [{ x: 100, y: 50 }, { x: 20, y: 10 }], color: "#ff0000",
  createdBy: null, createdByName: null, createdAt: null, reservedBy: null, reservedByName: null, reservedAt: null,
  ...extra
});

/** Records the calls / state a drawing makes. */
function recorder() {
  const calls: string[] = [];
  const texts: { text: string; x: number; y: number; font: string; fill: unknown }[] = [];
  const strokes: { color: unknown; width: number; dash: number[] }[] = [];
  let dash: number[] = [];
  const ctx: Record<string, unknown> = {
    save: () => {}, restore: () => {}, beginPath: () => {}, closePath: () => calls.push("close"),
    moveTo: (x: number, y: number) => calls.push(`M${x},${y}`),
    lineTo: (x: number, y: number) => calls.push(`L${x},${y}`),
    roundRect: (x: number, y: number, w: number, h: number) => calls.push(`R${x},${y},${w},${h}`),
    rect: () => {},
    setLineDash: (d: number[]) => { dash = d; },
    stroke: () => strokes.push({ color: ctx.strokeStyle, width: ctx.lineWidth as number, dash }),
    fillText: (text: string, x: number, y: number) => texts.push({ text, x, y, font: ctx.font as string, fill: ctx.fillStyle })
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, texts, strokes };
}

describe("floorplans in screenshots", () => {
  it("follows the overlay's visibility rule", () => {
    const r = region({ name: "OSC" });
    expect(isFloorplanVisible(r, false, {})).toBe(true);
    expect(isFloorplanVisible(r, true, {})).toBe(false);
    expect(isFloorplanVisible(r, true, { OSC: false })).toBe(true);
    expect(isFloorplanVisible(region({}), false, { "(unnamed)": true })).toBe(false);
  });

  it("draws a normalized rect with screen-sized dashes and a multiline label", () => {
    const rec = recorder();
    // zoom 2 CSS px per world unit → 1 CSS px = 0.5 world.
    drawFloorplansForSnapshot(rec.ctx, [region({ name: "Bandgap\nref" })], { zoom: 2, pxPerWorld: 4, pxPerCss: 2 });
    expect(rec.calls).toEqual(["R20,10,80,40"]);
    expect(rec.strokes[0]).toEqual({ color: "#ff0000", width: 1.1, dash: [3.5, 2] });
    expect(rec.texts.map((t) => [t.text, t.x, t.y])).toEqual([
      ["Bandgap", 23, 18],
      ["ref", 23, 18 + 6.5 * 1.2]
    ]);
    expect(rec.texts[0].font).toContain("6.5px");
  });

  it("closes polygons and labels them at the first vertex", () => {
    const rec = recorder();
    const poly = region({ kind: "polygon", name: "P", geometry: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }] });
    drawFloorplansForSnapshot(rec.ctx, [poly], { zoom: 1, pxPerWorld: 1, pxPerCss: 1 });
    expect(rec.calls).toEqual(["M0,0", "L10,0", "L5,8", "close"]);
    expect(rec.strokes[0].width).toBeCloseTo(2.86);
    expect(rec.texts[0]).toMatchObject({ text: "P", x: 8, y: 18 });
  });
});
