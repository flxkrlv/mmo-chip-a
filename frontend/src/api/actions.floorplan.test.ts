import { describe, expect, it } from "vitest";
import type { AnnotationNet, DieAnnotations, FloorplanRegion } from "shared";
import { applyAction, inverseOf, type AnnotationAction } from "./actions";

const region: FloorplanRegion = {
  id: "f1",
  name: "UVLO",
  kind: "rect",
  geometry: [
    { x: 0, y: 0 },
    { x: 100, y: 50 }
  ],
  color: "#4dabf7",
  createdBy: "u1",
  createdByName: "alice",
  createdAt: "2026-10-01T10:00:00.000Z",
  reservedBy: null,
  reservedByName: null,
  reservedAt: null
};

const die = (floorplanRegions: FloorplanRegion[] | undefined, nets: AnnotationNet[] = []): DieAnnotations =>
  ({ version: 2, floorplanRegions, nets } as unknown as DieAnnotations);

const undo = (start: DieAnnotations, action: AnnotationAction) =>
  applyAction(applyAction(start, action), inverseOf(action));

describe("floorplan actions", () => {
  it("creation undoes to no region, redo restores it", () => {
    const create: AnnotationAction = { kind: "upsertFloorplan", region, prevRegion: null };
    const after = applyAction(die(undefined), create);
    expect(after.floorplanRegions).toEqual([region]);
    const undone = applyAction(after, inverseOf(create));
    expect(undone.floorplanRegions).toEqual([]);
    expect(applyAction(undone, create).floorplanRegions).toEqual([region]);
  });

  it("geometry edit undoes to the previous geometry", () => {
    const moved = { ...region, geometry: [{ x: 10, y: 10 }, { x: 110, y: 60 }] };
    expect(undo(die([region]), { kind: "upsertFloorplan", region: moved, prevRegion: region }).floorplanRegions).toEqual([region]);
  });

  it("deletion undoes to the same region", () => {
    expect(undo(die([region]), { kind: "removeFloorplan", region }).floorplanRegions).toEqual([region]);
  });

  it("rename with net aliases undoes nets and region in one step", () => {
    const net = { id: "n1", name: "net_7" } as unknown as AnnotationNet;
    const renamedNet = { ...net, name: "VREF" } as AnnotationNet;
    const renamed = { ...region, name: "BANDGAP", portAliases: { 7: "VREF" } };
    const step: AnnotationAction = {
      kind: "batch",
      actions: [
        { kind: "upsertNet", net: renamedNet, prevNet: net },
        { kind: "upsertFloorplan", region: renamed, prevRegion: region }
      ]
    };
    const after = applyAction(die([region], [net]), step);
    expect(after.nets[0].name).toBe("VREF");
    expect(after.floorplanRegions![0].name).toBe("BANDGAP");
    const undone = applyAction(after, inverseOf(step));
    expect(undone.nets[0].name).toBe("net_7");
    expect(undone.floorplanRegions).toEqual([region]);
  });
});
