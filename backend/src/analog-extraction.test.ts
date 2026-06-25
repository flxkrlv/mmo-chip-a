/**
 * analog-extraction.test.ts — Tests for:
 *   - analogDevices.ts (device detection + geometry parameter computation)
 *   - spice.ts (SPICE/CDL/Spectre netlist generation)
 *
 * Run: node --import tsx --test backend/src/analog-extraction.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtractedShape, InferredDiffusion, Transistor } from "../../frontend/src/lib/extraction/cell.js";
import {
  detectAnalogDevices,
  computeMOSParams,
  computeBJTParams,
  computeResistorParams,
  computeCapacitorParams,
  computeDiodeParams,
  countFingers,
  computeSquares,
  shapeArea,
  shapePerimeter,
  bodyCenterline,
  bodyCenterlineLength,
  bodyAvgWidth,
} from "../../frontend/src/lib/extraction/analogDevices.js";
import { generateSpiceNetlist } from "../../frontend/src/lib/export/spice.js";
import type { AnalogDevice, SpiceConfig } from "../../shared/src/types.js";

// ═════════════════════════════════════════════════════════════════
// Geometry helpers
// ═════════════════════════════════════════════════════════════════

function rect(x: number, y: number, w: number, h: number): { x: number; y: number }[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

function shape(
  id: string,
  layer: string,
  pts: { x: number; y: number }[],
  netId = -1,
): ExtractedShape {
  return { id, layer: layer as ExtractedShape["layer"], polygon: pts, netId };
}

// ═════════════════════════════════════════════════════════════════
// R2: Device Detection Tests
// ═════════════════════════════════════════════════════════════════

test("computeMOSParams — vertical gate", () => {
  // Diffusion: 0-30 X, 0-10 Y. Gate poly: 12-16 X, -2-12 Y (vertical).
  const diff = rect(0, 0, 30, 10);
  const gate = rect(12, -2, 4, 14);
  const { W_um, L_um } = computeMOSParams(gate, diff, 1);
  // W = overlap height (10px), L = overlap width (4px)
  assert.equal(W_um, 10);
  assert.equal(L_um, 4);
});

test("computeMOSParams — horizontal gate", () => {
  // Diffusion: 0-10 X, 0-30 Y. Gate poly: -2-12 X, 12-16 Y (horizontal).
  const diff = rect(0, 0, 10, 30);
  const gate = rect(-2, 12, 14, 4);
  const { W_um, L_um } = computeMOSParams(gate, diff, 1);
  // W = overlap width (10px), L = overlap height (4px)
  assert.equal(W_um, 10);
  assert.equal(L_um, 4);
});

test("computeMOSParams — scaling factor", () => {
  const diff = rect(0, 0, 30, 10);
  const gate = rect(12, -2, 4, 14);
  const { W_um, L_um } = computeMOSParams(gate, diff, 0.5); // 0.5 μm/px
  assert.equal(W_um, 5); // 10px × 0.5
  assert.equal(L_um, 2); // 4px × 0.5
});

test("computeBJTParams — simple base-emitter overlap", () => {
  // Base: 10×10 square. Emitter: 4×4 square centered inside.
  const base = rect(0, 0, 10, 10);
  const emitter = rect(3, 3, 4, 4);
  const { AE_um2, PE_um } = computeBJTParams(base, emitter, 1);
  // AE = 4×4 = 16 μm², PE = 2×(4+4) = 16 μm
  assert.equal(AE_um2, 16);
  assert.equal(PE_um, 16);
});

test("computeResistorParams — straight poly resistor", () => {
  // Body: 40×4 stripe. Contacts at both ends.
  const body = rect(0, 4, 40, 4);
  const contacts = [
    shape("c1", "contact", rect(0, 3, 2, 6)),
    shape("c2", "contact", rect(38, 3, 2, 6)),
  ];
  const result = computeResistorParams(body, contacts, 1, 50);
  assert.equal(result.shape, "straight");
  assert.equal(result.L_um, 40);
  assert.equal(result.W_um, 4);
  assert.equal(result.squares, 10);
  assert.equal(result.resistance_ohms, 500); // 10 × 50
  assert.equal(result.fingers, 1);
});

test("computeResistorParams — scaling", () => {
  const body = rect(0, 4, 40, 4);
  const contacts = [
    shape("c1", "contact", rect(0, 3, 2, 6)),
    shape("c2", "contact", rect(38, 3, 2, 6)),
  ];
  // 0.25 μm/px → 40px = 10μm, 4px = 1μm, squares = 10
  const result = computeResistorParams(body, contacts, 0.25, 100);
  assert.equal(result.L_um, 10);
  assert.equal(result.W_um, 1);
  assert.equal(result.squares, 10);
  assert.equal(result.resistance_ohms, 1000);
});

test("computeCapacitorParams — overlapping plates", () => {
  // Bottom plate: 0-20 X, 0-20 Y. Top plate: 5-15 X, 5-15 Y.
  const bot = rect(0, 0, 20, 20);
  const top = rect(5, 5, 10, 10);
  const result = computeCapacitorParams(bot, top, 1, 1);
  assert.equal(result.area_um2, 100); // 10×10
  assert.equal(result.perimeter_um, 40); // 2×(10+10)
  assert.equal(result.capacitance_fF, 100); // 100 μm² × 1 fF/μm²
});

test("computeDiodeParams — single diffusion", () => {
  const junction = rect(0, 0, 5, 5);
  const result = computeDiodeParams(junction, 1);
  assert.equal(result.area_um2, 25);
  assert.equal(result.perimeter_um, 20);
});

test("shapeArea — rect polygon", () => {
  const p = rect(0, 0, 10, 20);
  assert.equal(shapeArea(p), 200);
});

test("shapePerimeter — rect polygon", () => {
  const p = rect(0, 0, 10, 20);
  assert.equal(shapePerimeter(p), 60);
});

test("countFingers — single poly", () => {
  const diff = rect(0, 0, 30, 10);
  const polys = [shape("p1", "polysilicon", rect(12, -2, 4, 14))];
  assert.equal(countFingers(diff, polys), 1);
});

test("countFingers — 3 fingers", () => {
  const diff = rect(0, 0, 50, 10);
  const polys = [
    shape("p1", "polysilicon", rect(5, -2, 3, 14)),
    shape("p2", "polysilicon", rect(20, -2, 3, 14)),
    shape("p3", "polysilicon", rect(35, -2, 3, 14)),
  ];
  assert.equal(countFingers(diff, polys), 3);
});

test("computeSquares", () => {
  assert.equal(computeSquares(40, 4), 10);
  assert.equal(computeSquares(10, 10), 1);
  assert.equal(computeSquares(100, 2), 50);
});

test("bodyCenterline — straight rect", () => {
  const body = rect(0, 4, 40, 4);
  const cl = bodyCenterline(body);
  assert.equal(cl.length, 2);
  // Centerline should run approximately along y=6 from x=0 to x=40
  assert.ok(Math.abs(cl[0].x - 0) < 5);
  assert.ok(Math.abs(cl[1].x - 40) < 5);
  assert.ok(cl[0].y > 4 && cl[0].y < 8);
  assert.ok(cl[1].y > 4 && cl[1].y < 8);
});

test("bodyCenterlineLength", () => {
  assert.equal(bodyCenterlineLength([{ x: 0, y: 0 }, { x: 40, y: 0 }]), 40);
  assert.equal(bodyCenterlineLength([{ x: 0, y: 0 }, { x: 30, y: 40 }]), 50);
});

test("bodyAvgWidth — 40×4 rect", () => {
  const body = rect(0, 4, 40, 4);
  const cl = bodyCenterline(body);
  const w = bodyAvgWidth(body, cl);
  // Centerline length ~40, area = 160, so width ~ 160/40 = 4
  assert.ok(Math.abs(w - 4) < 0.5);
});

// ═════════════════════════════════════════════════════════════════
// R2: Integration test — detectAnalogDevices
// ═════════════════════════════════════════════════════════════════

test("detectAnalogDevices — MOS transistors (from existing CMOS pipeline)", () => {
  const shapes: ExtractedShape[] = [
    shape("p1", "polysilicon", rect(12, -2, 4, 14)),
    shape("sd1", "diffusion", rect(0, 0, 30, 10)), // dummy sub-region shape
  ];
  const transistors: Transistor[] = [
    {
      id: "tx1", type: "nmos",
      gate: { shapeId: "p1", netId: 1 },
      source: { shapeId: "sd1", netId: 2 },
      drain: { shapeId: "sd1", netId: 3 },
      region: { x: 12, y: 0, width: 4, height: 10 },
    },
  ];
  const diffusions: InferredDiffusion[] = [
    { shapeId: "sd1", type: "n", subRegionIds: ["sd1#0"], forced: false },
  ];
  const nets: any[] = [];

  const devices = detectAnalogDevices(shapes, transistors, diffusions, nets, "test_cell", 1);
  const mosDevices = devices.filter((d) => d.kind === "mos");

  assert.ok(mosDevices.length >= 1);
  const m = mosDevices[0];
  assert.equal("mosType" in m.geometry && (m.geometry as any).mosType, "nmos");
  if ("W_um" in m.geometry) {
    assert.ok((m.geometry as any).W_um > 0);
    assert.ok((m.geometry as any).L_um > 0);
  }
});

test("detectAnalogDevices — resistors", () => {
  const shapes: ExtractedShape[] = [
    shape("body1", "polysilicon", rect(0, 4, 40, 4)),
    shape("c1", "contact", rect(0, 3, 2, 6)),
    shape("c2", "contact", rect(38, 3, 2, 6)),
  ];

  const devices = detectAnalogDevices(shapes, [], [], [], "test_cell", 1, {
    sheetR: { polysilicon: 50 },
  });
  const res = devices.filter((d) => d.kind === "resistor");

  assert.equal(res.length, 1);
  const r = res[0];
  if ("squares" in r.geometry) {
    assert.ok((r.geometry as any).squares >= 5);
    assert.equal(r.terminals.length, 2);
  }
});

test("detectAnalogDevices — capacitors", () => {
  const shapes: ExtractedShape[] = [
    shape("bot1", "metal1", rect(0, 0, 20, 20)),
    shape("top1", "metal2", rect(5, 5, 10, 10)),
  ];

  const devices = detectAnalogDevices(shapes, [], [], [], "test_cell", 1, {
    capDensity: { metal1_metal2: 1 },
  });
  const caps = devices.filter((d) => d.kind === "capacitor");

  assert.equal(caps.length, 1);
  if ("area_um2" in caps[0].geometry) {
    assert.ok((caps[0].geometry as any).area_um2 >= 100);
  }
});

test("detectAnalogDevices — diodes", () => {
  const shapes: ExtractedShape[] = [
    shape("d1", "diffusion", rect(0, 0, 5, 5)),
    shape("c1", "contact", rect(2, 2, 1, 1)),
  ];

  const devices = detectAnalogDevices(shapes, [], [], [], "test_cell", 1);
  const diodes = devices.filter((d) => d.kind === "diode");

  assert.equal(diodes.length, 1);
  if ("area_um2" in diodes[0].geometry) {
    assert.equal((diodes[0].geometry as any).area_um2, 25);
  }
});

test("detectAnalogDevices — BJT (layer-annotated)", () => {
  const shapes: ExtractedShape[] = [
    shape("nw1", "nwell", rect(0, 0, 20, 20)),
    shape("b1", "base", rect(3, 3, 14, 14)),
    shape("e1", "emitter", rect(6, 6, 8, 8)),
  ];

  const devices = detectAnalogDevices(shapes, [], [], [], "test_cell", 1);
  const bjts = devices.filter((d) => d.kind === "bjt_npn" || d.kind === "bjt_pnp");

  assert.equal(bjts.length, 1);
  assert.equal(bjts[0].kind, "bjt_npn"); // nwell → NPN
  if ("AE_um2" in bjts[0].geometry) {
    assert.ok((bjts[0].geometry as any).AE_um2 > 0);
  }
});

// ═════════════════════════════════════════════════════════════════
// R3: SPICE/CDL Export Tests
// ═════════════════════════════════════════════════════════════════

function makeDevice(overrides: Partial<AnalogDevice> & { kind: any }): AnalogDevice {
  return {
    id: "d1",
    instanceName: undefined,
    modelName: undefined,
    cellTypeId: "test",
    terminals: [],
    geometry: {} as any,
    ...overrides,
  } as AnalogDevice;
}

test("generateSpiceNetlist — MOS device", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "m1", kind: "mos",
      geometry: { L_um: 0.35, W_um: 10, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "nmos" },
      terminals: [
        { name: "D", netId: 1 }, { name: "G", netId: 2 },
        { name: "S", netId: 3 }, { name: "B", netId: 0 },
      ],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "cdl");
  assert.ok(result.text.includes("M1"));
  assert.ok(result.text.includes("W=10.000u"));
  assert.ok(result.text.includes("L=0.350u"));
  assert.ok(result.text.includes("M1"));
  assert.equal(result.totalDevices, 1);
});

test("generateSpiceNetlist — BJT device", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "q1", kind: "bjt_npn",
      geometry: { AE_um2: 4, PE_um: 8, multiplier: 2, totalAE_um2: 8, emitterFingers: 1, bjtType: "npn" },
      terminals: [
        { name: "C", netId: 1 }, { name: "B", netId: 2 }, { name: "E", netId: 3 },
      ],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "cdl");
  assert.ok(result.text.includes("Q1"));
  assert.equal(result.totalDevices, 1);
});

test("generateSpiceNetlist — resistor device", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "r1", kind: "resistor",
      geometry: { L_um: 40, W_um: 4, squares: 10, resistance_ohms: 500, fingers: 1, multiplier: 1, shape: "straight" },
      terminals: [
        { name: "PLUS", netId: 1 }, { name: "MINUS", netId: 2 },
      ],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "cdl");
  assert.ok(result.text.includes("R1"));
  assert.ok(result.text.includes("R="));
  assert.equal(result.totalDevices, 1);
});

test("generateSpiceNetlist — capacitor device", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "c1", kind: "capacitor",
      geometry: { area_um2: 100, perimeter_um: 40, capacitance_fF: 100, multiplier: 1, capType: "mim" },
      terminals: [
        { name: "PLUS", netId: 1 }, { name: "MINUS", netId: 2 },
      ],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "cdl");
  assert.ok(result.text.includes("C1"));
  assert.equal(result.totalDevices, 1);
});

test("generateSpiceNetlist — diode device", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "d1", kind: "diode",
      geometry: { area_um2: 25, perimeter_um: 20, multiplier: 1, diodeType: "pn" },
      terminals: [
        { name: "PLUS", netId: 1 }, { name: "MINUS", netId: 2 },
      ],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "cdl");
  assert.ok(result.text.includes("D1"));
  assert.equal(result.totalDevices, 1);
});

test("generateSpiceNetlist — multiple device types", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "m1", kind: "mos",
      geometry: { L_um: 0.35, W_um: 10, fingers: 4, multiplier: 2, totalW_um: 80, mosType: "nmos" },
      terminals: [{ name: "D", netId: 1 }, { name: "G", netId: 2 }, { name: "S", netId: 3 }, { name: "B", netId: 0 }],
    }),
    makeDevice({
      id: "q1", kind: "bjt_npn",
      geometry: { AE_um2: 4, PE_um: 8, multiplier: 1, totalAE_um2: 4, emitterFingers: 1, bjtType: "npn" },
      terminals: [{ name: "C", netId: 4 }, { name: "B", netId: 5 }, { name: "E", netId: 0 }],
    }),
    makeDevice({
      id: "r1", kind: "resistor",
      geometry: { L_um: 40, W_um: 4, squares: 10, resistance_ohms: 500, fingers: 1, multiplier: 1, shape: "straight" },
      terminals: [{ name: "PLUS", netId: 6 }, { name: "MINUS", netId: 0 }],
    }),
    makeDevice({
      id: "c1", kind: "capacitor",
      geometry: { area_um2: 100, perimeter_um: 40, capacitance_fF: 100, multiplier: 1, capType: "mim" },
      terminals: [{ name: "PLUS", netId: 7 }, { name: "MINUS", netId: 0 }],
    }),
  ];

  const result = generateSpiceNetlist(devices, "mixed", {}, "cdl");
  assert.ok(result.text.includes("M1"));
  assert.ok(result.text.includes("Q1"));
  assert.ok(result.text.includes("R1"));
  assert.ok(result.text.includes("C1"));
  assert.equal(result.totalDevices, 4);
  assert.ok(result.text.includes(".SUBCKT"));
  assert.ok(result.text.includes(".ENDS"));
});

test("generateSpiceNetlist — Spectre dialect", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "m1", kind: "mos",
      geometry: { L_um: 0.35, W_um: 10, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "nmos" },
      terminals: [{ name: "D", netId: 1 }, { name: "G", netId: 2 }, { name: "S", netId: 3 }, { name: "B", netId: 0 }],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "spectre");
  assert.ok(result.text.includes("M1"));
  assert.ok(result.text.includes("subckt"));
  assert.ok(result.text.includes("ends"));
});

test("generateSpiceNetlist — byKind counts", () => {
  const devices: AnalogDevice[] = [
    makeDevice({ id: "m1", kind: "mos", geometry: { L_um: 1, W_um: 10, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "nmos" }, terminals: [] }),
    makeDevice({ id: "m2", kind: "mos", geometry: { L_um: 1, W_um: 10, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "pmos" }, terminals: [] }),
    makeDevice({ id: "r1", kind: "resistor", geometry: { L_um: 40, W_um: 4, squares: 10, resistance_ohms: 500, fingers: 1, multiplier: 1, shape: "straight" }, terminals: [] }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "cdl");
  assert.equal(result.byKind["mos"], 2);
  assert.equal(result.byKind["resistor"], 1);
  assert.equal(result.totalDevices, 3);
});

test("generateSpiceNetlist — unconnected terminal warning", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "r1", kind: "resistor",
      geometry: { L_um: 10, W_um: 2, squares: 5, resistance_ohms: 250, fingers: 1, multiplier: 1, shape: "straight" },
      terminals: [{ name: "PLUS", netId: 1 }, { name: "MINUS", netId: -1 }],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "cdl");
  assert.ok(result.warnings.length >= 1);
  assert.ok(result.warnings[0].includes("unconnected"));
});

// ═════════════════════════════════════════════════════════════════
// detectMOSFromLayers — poly gate net grouping
// ═════════════════════════════════════════════════════════════════

import {
  detectMOSFromLayers,
  resetDummyNets,
} from "../../frontend/src/lib/extraction/simpleAnalog.js";
import { loadClipperWithBinary } from "../../frontend/src/lib/extraction/clipper.js";
import { readFileSync } from "node:fs";
import type { CellLayers, LayerRect } from "../../shared/src/types.js";

function rr(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): LayerRect {
  return { id, kind: "rect", x, y, width: w, height: h };
}

test("detectMOSFromLayers: same poly shape across two diffusions → shared gate net (no clipper)", () => {
  resetDummyNets();
  const layers: CellLayers = {
    nwell: [rr("nw1", 0, 0, 100, 50)],
    diffusion: [rr("d1", 10, 10, 30, 20), rr("d2", 60, 10, 30, 20)],
    polysilicon: [rr("p1", 38, 5, 4, 40)], // crosses both diffusions
  };
  const devices = detectMOSFromLayers(layers, "test_cell", 1);
  assert.equal(devices.length, 2, "expected 2 MOS devices (one per diffusion)");
  const gNets = devices.map((d) => d.terminals.find((t) => t.name === "G")!.netId);
  assert.equal(
    gNets[0],
    gNets[1],
    "same polysilicon shape → same gate netId across diffusions",
  );
  assert.ok(gNets[0] >= 1000, "gate netId should be positive internal net");
});

test("detectMOSFromLayers: overlapping poly shapes → shared gate net (with clipper)", async () => {
  const wasmPath = new URL(
    "../../node_modules/clipper2-wasm/dist/es/clipper2z.wasm",
    import.meta.url,
  );
  const buf = readFileSync(wasmPath);
  await loadClipperWithBinary(buf);

  resetDummyNets();
  // Two separate poly rects that overlap — should be grouped as one component
  const layers: CellLayers = {
    nwell: [rr("nw1", 0, 0, 120, 50)],
    diffusion: [rr("d1", 10, 10, 30, 20), rr("d2", 70, 10, 30, 20)],
    polysilicon: [
      rr("p1", 35, 5, 8, 40),  // crosses d1
      rr("p2", 40, 5, 8, 40),  // overlaps p1 — same connected component
    ],
  };
  const devices = detectMOSFromLayers(layers, "test_cell", 1);
  // d1 is crossed by both p1 and p2 → multi-finger (2 fingers)
  // d2 is crossed by p2 → single finger
  // Total: 2 + 1 = 3 devices (if clipper split works for d1)
  // If clipper fails: 2 single devices (one per diffusion)
  assert.ok(devices.length >= 2, "expected at least 2 devices");

  // All gate terminals should share the same netId (overlapping polys = one component)
  const gNets = devices.map((d) => d.terminals.find((t) => t.name === "G")!.netId);
  for (let i = 1; i < gNets.length; i++) {
    assert.equal(
      gNets[i],
      gNets[0],
      `device ${i} gate netId should match device 0`,
    );
  }
  assert.ok(gNets[0] >= 1000);
});

test("detectMOSFromLayers: separate poly shapes → different gate nets", async () => {
  // Clipper should already be loaded from previous test
  resetDummyNets();
  const layers: CellLayers = {
    nwell: [rr("nw1", 0, 0, 120, 50)],
    diffusion: [rr("d1", 10, 10, 30, 20), rr("d2", 70, 10, 30, 20)],
    polysilicon: [
      rr("p1", 35, 5, 4, 40),  // crosses d1 only
      rr("p2", 78, 5, 4, 40),  // crosses d2 only — NO overlap with p1
    ],
  };
  const devices = detectMOSFromLayers(layers, "test_cell", 1);
  assert.equal(devices.length, 2, "expected 2 MOS devices");
  const gNets = devices.map((d) => d.terminals.find((t) => t.name === "G")!.netId);
  // Separate polys that DON'T overlap should have DIFFERENT gate netIds
  assert.notEqual(
    gNets[0],
    gNets[1],
    "non-overlapping poly shapes → different gate netIds",
  );
});

test("detectMOSFromLayers: single-finger regression — unchanged behavior", () => {
  resetDummyNets();
  const layers: CellLayers = {
    nwell: [rr("nw1", 0, 0, 50, 50)],
    diffusion: [rr("d1", 10, 10, 30, 20)],
    polysilicon: [rr("p1", 20, 5, 4, 30)],
  };
  const devices = detectMOSFromLayers(layers, "test_cell", 1);
  assert.equal(devices.length, 1, "expected 1 MOS device");
  const gTerm = devices[0].terminals.find((t) => t.name === "G")!;
  assert.ok(gTerm.netId >= 1000, "gate netId positive");
  assert.equal(gTerm.shapeIds.length, 1, "one gate shape");
});

test("detectMOSFromLayers: same diffusion, two polys, clipper loads → multi-finger", async () => {
  resetDummyNets();
  // Standard multi-finger: one diffusion, two poly strips
  const layers: CellLayers = {
    nwell: [rr("nw1", 0, 0, 80, 50)],
    diffusion: [rr("d1", 10, 10, 60, 20)],
    polysilicon: [
      rr("p1", 20, 5, 4, 30),
      rr("p2", 40, 5, 4, 30),
    ],
  };
  const devices = detectMOSFromLayers(layers, "test_cell", 1);
  // Should produce 2 devices (one per finger) when clipper is loaded
  assert.equal(devices.length, 2, "expected 2 finger-devices");
  // Separate non-overlapping poly strips get different gate netIds.
  // The die-level pipeline handles connecting them if needed.
  const allGates = devices.map(
    (d) => d.terminals.find((t) => t.name === "G")!.netId,
  );
  for (const g of allGates) assert.ok(g >= 1000, `gate net ${g} should be >= 1000`);
});
