import { describe, expect, it } from "vitest";
import type { FloorplanRegion } from "shared";
import { floorplanBounds, floorplanClips, pasteFloorplanActions, selectedFloorplans } from "./floorplanClipboard";

const region = (id: string, geometry: { x: number; y: number }[], extra: Partial<FloorplanRegion> = {}): FloorplanRegion => ({
  id, name: `R${id}`, kind: "rect", geometry, color: "#4dabf7",
  createdBy: "u1", createdByName: "alice", createdAt: "2026-01-01T00:00:00Z",
  reservedBy: "u1", reservedByName: "alice", reservedAt: "2026-01-01T00:00:00Z",
  ...extra
});

const a = region("a", [{ x: 100, y: 50 }, { x: 200, y: 120 }], { portAliases: { 3: "VREF" } });
const b = region("b", [{ x: 80, y: 90 }, { x: 140, y: 60 }, { x: 120, y: 150 }], { kind: "polygon", name: "Bandgap\nref" });

describe("floorplan copy / paste", () => {
  it("picks the selected regions and their common top-left", () => {
    const sel = selectedFloorplans([a, b], new Set(["floorplan:b", "cell:x"]));
    expect(sel.map((r) => r.id)).toEqual(["b"]);
    expect(floorplanBounds([a, b])).toEqual({ minX: 80, minY: 50 });
    expect(floorplanBounds([])).toBeNull();
  });

  it("pastes copies with fresh ids, same shape / name / color, unreserved, no aliases", () => {
    const clips = floorplanClips([a, b], 80, 50);
    const actions = pasteFloorplanActions(clips, { x: 1000, y: 2000 }, { userId: "u2", username: "bob" }, "now");
    expect(actions).toHaveLength(2);
    const [pa, pb] = actions.map((x) => (x.kind === "upsertFloorplan" ? x.region : null));
    expect(pa).toMatchObject({
      name: "Ra", kind: "rect", color: "#4dabf7",
      geometry: [{ x: 1020, y: 2000 }, { x: 1120, y: 2070 }],
      createdBy: "u2", createdByName: "bob", createdAt: "now", reservedBy: null
    });
    expect(pa?.id).not.toBe("a");
    expect(pa && "portAliases" in pa).toBe(false);
    expect(pb).toMatchObject({ name: "Bandgap\nref", kind: "polygon", geometry: [{ x: 1000, y: 2040 }, { x: 1060, y: 2010 }, { x: 1040, y: 2100 }] });
  });
});
