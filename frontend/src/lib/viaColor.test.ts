import { describe, expect, it } from "vitest";
import type { DieAnnotations, HumanAnnotation } from "shared";
import { selectedVias, viaBaseColor, viaColorAction, viaColorActions, viaColorTargets } from "./viaColor";

const v1: HumanAnnotation = { id: "v1", class: "point_via", geometry: { kind: "point", x: 1, y: 2 }, layer: "VIA12" };
const v2: HumanAnnotation = { id: "v2", class: "irregular_via", geometry: { kind: "rectangle", x: 0, y: 0, width: 4, height: 4 }, color: "#ff0000" };
const v3: HumanAnnotation = { id: "v3", class: "point_via", geometry: { kind: "point", x: 9, y: 9 } };
const ann = { annotations: [v1, v2, v3] } as unknown as DieAnnotations;

describe("via colors", () => {
  it("collects placed vias from a mixed selection", () => {
    expect(selectedVias(ann, ["anno:v1", "net:n", "ml-via:3:4", "anno:missing", "anno:v2"]).map((a) => a.id)).toEqual(["v1", "v2"]);
  });

  it("targets the whole via selection when the clicked via is in it", () => {
    const sel = new Set(["anno:v1", "anno:v2", "net:n"]);
    expect(viaColorTargets(ann, sel, "anno:v2")).toEqual(["anno:v1", "anno:v2"]);
    expect(viaColorTargets(ann, sel, "anno:v3")).toEqual(["anno:v3"]);
    expect(viaColorTargets(ann, sel, "net:n")).toEqual([]);
  });

  it("falls back from via layer override to the stack to the global color", () => {
    const stack = [{ id: "VIA12", from: "ME1", to: "ME2", layer: "via1", color: "#00ff00" }];
    expect(viaBaseColor(v1, {}, stack, "#123456")).toBe("#00ff00");
    expect(viaBaseColor(v1, { VIA12: "#abcdef" }, stack, "#123456")).toBe("#abcdef");
    expect(viaBaseColor(v3, {}, stack, "#123456")).toBe("#123456");
  });

  it("sets / clears the override and skips vias already in that state", () => {
    const set = viaColorActions([v1, v2], "#ff0000");
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({ kind: "upsertAnnotation", annotation: { id: "v1", color: "#ff0000" }, prevAnnotation: v1 });
    const cleared = viaColorActions([v1, v2], null);
    expect(cleared).toHaveLength(1);
    if (cleared[0].kind !== "upsertAnnotation") throw new Error("kind");
    expect("color" in cleared[0].annotation).toBe(false);
    expect(viaColorAction([v1, v3], "#0000ff")?.kind).toBe("batch");
    expect(viaColorAction([v2], "#ff0000")).toBeNull();
  });
});
