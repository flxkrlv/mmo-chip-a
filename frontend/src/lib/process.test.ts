import { describe, expect, it } from "vitest";
import { effectiveLayerStack, processPreset, type DieAnnotations, type MetalStack } from "shared";
import { applyAction } from "../api/actions";
import { buildFlipAction, toggleGroupLink } from "./process";

const stack: MetalStack = {
  metals: [
    { id: "ME1", layer: "metal1", z: 1, name: "Metal 1", color: "#000" },
    { id: "ME2", layer: "metal2", z: 2, name: "Metal 2", color: "#111" }
  ],
  vias: [{ id: "VIA12", from: "ME1", to: "ME2", layer: "via1", color: "#222" }],
  defaultMetalId: "ME1",
  defaultViaId: "VIA12"
};

function die(): DieAnnotations {
  return {
    version: 2,
    rev: 1,
    cellTypes: [],
    cells: [],
    grids: [],
    process: processPreset("cmos", "p"),
    nets: [
      {
        id: "n",
        name: "VDD",
        nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 10, y: 0 }, { id: "c", x: 20, y: 0 }],
        edges: [
          { id: "w", from: "a", to: "b", layer: "nwell" },
          { id: "d", from: "b", to: "c", layer: "pdiff" },
          { id: "m", from: "a", to: "c", layer: "metal1" }
        ]
      }
    ],
    annotations: [
      { id: "ct", class: "point_via", geometry: { kind: "point", x: 1, y: 1 }, layer: "CT_PDIFF" },
      { id: "v", class: "point_via", geometry: { kind: "point", x: 2, y: 2 }, layer: "VIA12" }
    ],
    floorplanRegions: [
      {
        id: "f",
        name: "",
        kind: "rect",
        geometry: [{ x: 0, y: 0 }, { x: 5, y: 5 }],
        color: "#fff",
        createdBy: null,
        createdByName: null,
        createdAt: null,
        reservedBy: null,
        reservedByName: null,
        reservedAt: null,
        layerTag: "nwell"
      }
    ]
  };
}

describe("process layer stack", () => {
  it("adds silicon layers after the metals, with contacts and well taps", () => {
    const eff = effectiveLayerStack(stack, processPreset("cmos", "p"));
    expect(eff.metals.map((m) => m.id)).toEqual(["ME1", "ME2", "NWELL", "NDIFF", "PDIFF", "POLY"]);
    expect(eff.vias.map((v) => v.id)).toEqual(["VIA12", "TAP_NWELL", "CT_NDIFF", "CT_PDIFF", "CT_POLY"]);
    expect(eff.vias.find((v) => v.id === "TAP_NWELL")).toMatchObject({ from: "NWELL", to: "NDIFF" });
    expect(effectiveLayerStack(stack, undefined)).toBe(stack);
  });

  it("bipolar preset is an NPN on P-substrate", () => {
    expect(processPreset("bipolar", "p").layers).toEqual(["nbl", "nepi", "pbase", "ndiff", "piso"]);
  });
});

describe("flip toggle", () => {
  it("relabels linked layers, vias and floorplan tags in one undoable batch", () => {
    const before = die();
    const action = buildFlipAction(before)!;
    const after = applyAction(before, action);
    expect(after.process?.substrate).toBe("n");
    expect(after.process?.layers).toEqual(["pwell", "pdiff", "ndiff", "poly"]);
    expect(after.nets[0].edges.map((e) => e.layer)).toEqual(["pwell", "ndiff", "metal1"]);
    expect(after.annotations?.map((a) => a.layer)).toEqual(["CT_NDIFF", "VIA12"]);
    expect(after.floorplanRegions?.[0].layerTag).toBe("pwell");
  });

  it("leaves an unlinked group exactly as drawn", () => {
    const before = die();
    before.process = toggleGroupLink(before.process!, "diff");
    const after = applyAction(before, buildFlipAction(before)!);
    expect(after.process?.substrate).toBe("n");
    expect(after.nets[0].edges.map((e) => e.layer)).toEqual(["pwell", "pdiff", "metal1"]);
    expect(after.annotations?.[0].layer).toBe("CT_PDIFF");
    expect(after.process?.unlinked).toEqual(["diff"]);
  });
});
