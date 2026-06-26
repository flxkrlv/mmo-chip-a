/**
 * analog-extraction.test.ts — Tests for the current analog pipeline:
 *   - simpleAnalog.ts  (marker-based + well-based extraction)
 *   - dieWideAnalog.ts (cell-type extraction)
 *   - spice.ts         (SPICE/CDL/Spectre netlist generation)
 *
 * Run: node --import tsx --test backend/src/analog-extraction.test.ts
 *
 * NOTE: Tests requiring Clipper2 WASM load it from node_modules.
 * If WASM fails to load, those tests are skipped with a warning.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { AnalogDevice, CellLayers, LayerRect } from "../../shared/src/types.js";
import {
  extractMarkedDevices,
  detectMOSFromLayers,
  resetDummyNets,
} from "../../frontend/src/lib/extraction/simpleAnalog.js";
import { generateSpiceNetlist } from "../../frontend/src/lib/export/spice.js";
import {
  isClipperLoaded,
  loadClipperWithBinary,
} from "../../frontend/src/lib/extraction/clipper.js";

// ── Clipper2 bootstrap ─────────────────────────────────────────

let clipperReady = false;
test.before(async () => {
  try {
    const wasmPath = new URL(
      "../../node_modules/clipper2-wasm/dist/umd/clipper2z.wasm",
      import.meta.url,
    );
    const buf = readFileSync(wasmPath);
    await loadClipperWithBinary(buf);
    clipperReady = isClipperLoaded();
  } catch {
    console.warn("⚠ Skipping Clipper2-dependent tests (WASM not loaded)");
  }
});

// ── Helpers ──────────────────────────────────────────────────────

function rect(
  id: string,
  x: number, y: number, w: number, h: number,
): LayerRect {
  return { id, kind: "rect", x, y, width: w, height: h };
}

function layers(entries: [string, LayerRect[]][]): CellLayers {
  const obj: Record<string, LayerRect[]> = {};
  for (const [k, v] of entries) obj[k] = v;
  return obj as CellLayers;
}

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

// ═════════════════════════════════════════════════════════════════
// 1. simpleAnalog.ts — extractMarkedDevices()
// ═════════════════════════════════════════════════════════════════

test("extractMarkedDevices — NPN BJT", () => {
  resetDummyNets();
  const ls = layers([
    ["npn_id", [rect("m1", 0, 0, 20, 20)]],
    ["collector", [rect("c1", 0, 0, 20, 20)]],
    ["base", [rect("b1", 3, 3, 14, 14)]],
    ["emitter", [rect("e1", 6, 6, 8, 8)]],
  ]);
  const devices = extractMarkedDevices(ls, "test_cell", 1);
  const npn = devices.filter((d) => d.kind === "bjt_npn");
  assert.equal(npn.length, 1, "should detect 1 NPN");
  const d = npn[0];
  assert.ok(typeof d.geometry === "object" && d.geometry !== null, "has geometry");
  assert.ok(d.terminals.length === 3, "C/B/E = 3 terminals");
  assert.ok(d.instanceName?.startsWith("Q"), "prefix Q");
});

test("extractMarkedDevices — PNP BJT", () => {
  resetDummyNets();
  const ls = layers([
    ["pnp_id", [rect("m1", 0, 0, 20, 20)]],
    ["collector", [rect("c1", 0, 0, 20, 20)]],
    ["base", [rect("b1", 3, 3, 14, 14)]],
    ["emitter", [rect("e1", 6, 6, 8, 8)]],
  ]);
  const devices = extractMarkedDevices(ls, "test_cell", 1);
  const pnp = devices.filter((d) => d.kind === "bjt_pnp");
  assert.equal(pnp.length, 1, "should detect 1 PNP");
});

test("extractMarkedDevices — Diode from BJT without collector", () => {
  resetDummyNets();
  const ls = layers([
    ["npn_id", [rect("m1", 0, 0, 20, 20)]],
    ["base", [rect("b1", 3, 3, 14, 14)]],
    ["emitter", [rect("e1", 6, 6, 8, 8)]],
  ]);
  const devices = extractMarkedDevices(ls, "test_cell", 1);
  const diodes = devices.filter((d) => d.kind === "diode");
  assert.equal(diodes.length, 1, "BJT without collector → diode");
  assert.equal(diodes[0].terminals.length, 2, "PLUS/MINUS = 2 terminals");
  const tNames = diodes[0].terminals.map((t) => t.name).sort();
  assert.deepEqual(tNames, ["MINUS", "PLUS"]);
});

test("extractMarkedDevices — Resistor (geometric: body → ME1 → contact)", { skip: !clipperReady }, () => {
  resetDummyNets();
  // Geometric resistor detection requires Clipper2 (polygonsIntersect).
  // Pattern: body poly INTERACTs ME1, ME1 INTERACTs contact. No res_id needed.
  const ls = layers([
    ["polysilicon", [rect("body", 0, 4, 40, 4)]],
    ["metal1", [
      rect("m1a", -1, 3, 4, 6),
      rect("m1b", 37, 3, 4, 6),
    ]],
    ["contact", [
      rect("c1", 0, 3, 2, 6),
      rect("c2", 38, 3, 2, 6),
    ]],
  ]);
  const devices = extractMarkedDevices(ls, "test_cell", 1);
  const res = devices.filter((d) => d.kind === "resistor");
  assert.equal(res.length, 1, "should detect 1 resistor (geometric)");
  const d = res[0];
  assert.ok(d.instanceName?.startsWith("R"), "prefix R");
  assert.equal(d.terminals.length, 2, "PLUS/MINUS");
  const g = d.geometry as any;
  assert.ok(g.L_um !== undefined && g.L_um > 0, "L_um > 0");
  assert.ok(g.W_um !== undefined && g.W_um > 0, "W_um > 0");
  assert.ok(g.squares !== undefined && g.squares > 0, "squares > 0");
});

test("extractMarkedDevices — Capacitor", () => {
  resetDummyNets();
  const ls = layers([
    ["cap_id", [rect("m1", 0, 0, 20, 20)]],
    ["metal1", [rect("bot", 0, 0, 20, 20)]],
    ["metal2", [rect("top", 5, 5, 10, 10)]],
  ]);
  const devices = extractMarkedDevices(ls, "test_cell", 1);
  const caps = devices.filter((d) => d.kind === "capacitor");
  assert.equal(caps.length, 1, "should detect 1 capacitor");
  const d = caps[0];
  assert.ok(d.instanceName?.startsWith("C"), "prefix C");
  const g = d.geometry as any;
  assert.ok(g.area_um2 !== undefined && g.area_um2 > 0, "area > 0");
});

test("extractMarkedDevices — Diode (diode_id marker)", () => {
  resetDummyNets();
  const ls = layers([
    ["diode_id", [rect("m1", 0, 0, 10, 10)]],
    ["diffusion", [rect("j", 0, 0, 10, 10)]],
  ]);
  const devices = extractMarkedDevices(ls, "test_cell", 1);
  const diodes = devices.filter((d) => d.kind === "diode");
  assert.equal(diodes.length, 1, "should detect 1 diode");
  assert.equal(diodes[0].terminals.length, 2, "PLUS/MINUS");
});

test("extractMarkedDevices — empty layers object → no devices", () => {
  resetDummyNets();
  const devices = extractMarkedDevices({} as any, "empty", 1);
  assert.equal(devices.length, 0, "empty layers → no devices");
});

test("extractMarkedDevices — multiple devices (NPN + geometric resistor)", { skip: !clipperReady }, () => {
  resetDummyNets();
  const ls = layers([
    // NPN marker-based
    ["npn_id", [rect("m1", 0, 0, 20, 20)]],
    ["collector", [rect("c1", 0, 0, 20, 20)]],
    ["base", [rect("b1", 3, 3, 14, 14)]],
    ["emitter", [rect("e1", 6, 6, 8, 8)]],
    // Geometric resistor (polysilicon + ME1 + contact)
    ["polysilicon", [rect("body", 30, 4, 40, 4)]],
    ["metal1", [
      rect("m1a", 29, 3, 4, 6),
      rect("m1b", 67, 3, 4, 6),
    ]],
    ["contact", [
      rect("c1", 30, 3, 2, 6),
      rect("c2", 68, 3, 2, 6),
    ]],
  ]);
  const devices = extractMarkedDevices(ls, "test_cell", 1);
  const npn = devices.filter((d) => d.kind === "bjt_npn");
  const res = devices.filter((d) => d.kind === "resistor");
  assert.equal(npn.length, 1, "1 NPN");
  assert.equal(res.length, 1, "1 resistor (geometric)");
  assert.equal(devices.length, 2, "total 2 devices");
});

// ═════════════════════════════════════════════════════════════════
// 2. simpleAnalog.ts — detectMOSFromLayers()
// ═════════════════════════════════════════════════════════════════

test("detectMOSFromLayers — single-finger NMOS in nwell", { skip: !clipperReady }, () => {
  resetDummyNets();
  const ls = layers([
    ["nwell", [rect("nw", 0, 0, 50, 50)]],
    ["diffusion", [rect("d1", 10, 10, 30, 20)]],
    ["polysilicon", [rect("p1", 20, 5, 4, 30)]],
  ]);
  const devices = detectMOSFromLayers(ls, "test_cell", 1);
  const mos = devices.filter((d) => d.kind === "mos");
  assert.equal(mos.length, 1, "1 MOS expected");
  const d = mos[0];
  assert.ok(d.instanceName?.startsWith("M"), "prefix M");
  assert.equal(d.terminals.length, 4, "D/G/S/B");
  const gTerm = d.terminals.find((t) => t.name === "G");
  assert.ok(gTerm, "gate terminal exists");
  assert.ok(gTerm!.netId >= 1000, "gate netId >= 1000");
  const g = d.geometry as any;
  assert.ok(g.W_um > 0, "W > 0");
  assert.ok(g.L_um > 0, "L > 0");
});

test("detectMOSFromLayers — single-finger PMOS in pwell", { skip: !clipperReady }, () => {
  resetDummyNets();
  const ls = layers([
    ["pwell", [rect("pw", 0, 0, 50, 50)]],
    ["diffusion", [rect("d1", 10, 10, 30, 20)]],
    ["polysilicon", [rect("p1", 20, 5, 4, 30)]],
  ]);
  const devices = detectMOSFromLayers(ls, "test_cell", 1);
  const pmos = devices.filter(
    (d) => d.kind === "mos"
      && typeof d.geometry === "object"
      && d.geometry !== null
      && "mosType" in d.geometry
      && (d.geometry as any).mosType === "pmos",
  );
  assert.equal(pmos.length, 1, "1 PMOS expected");
});

test("detectMOSFromLayers — no well → no MOS", () => {
  resetDummyNets();
  const ls = layers([
    ["diffusion", [rect("d1", 10, 10, 30, 20)]],
    ["polysilicon", [rect("p1", 20, 5, 4, 30)]],
  ]);
  const devices = detectMOSFromLayers(ls, "test_cell", 1);
  assert.equal(devices.length, 0, "no well → no MOS");
});

test("detectMOSFromLayers — no diffusion → no MOS", () => {
  resetDummyNets();
  const ls = layers([
    ["nwell", [rect("nw", 0, 0, 50, 50)]],
    ["polysilicon", [rect("p1", 20, 5, 4, 30)]],
  ]);
  const devices = detectMOSFromLayers(ls, "test_cell", 1);
  assert.equal(devices.length, 0, "no diffusion → no MOS");
});

test("detectMOSFromLayers — no polysilicon over diffusion → no MOS", () => {
  resetDummyNets();
  const ls = layers([
    ["nwell", [rect("nw", 0, 0, 50, 50)]],
    ["diffusion", [rect("d1", 10, 10, 20, 20)]],
    ["polysilicon", [rect("p1", 0, 0, 5, 5)]], // far away, not crossing diffusion
  ]);
  const devices = detectMOSFromLayers(ls, "test_cell", 1);
  const mos = devices.filter((d) => d.kind === "mos");
  assert.equal(mos.length, 0, "no poly crossing diffusion → no MOS");
});

// ═════════════════════════════════════════════════════════════════
// 3. spice.ts — generateSpiceNetlist()
// ═════════════════════════════════════════════════════════════════

test("generateSpiceNetlist — MOS (CDL)", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "m1", kind: "mos",
      geometry: { L_um: 0.35, W_um: 10, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "nmos" },
      instanceName: "M1",
      terminals: [
        { name: "D", netId: 1, shapeIds: [] },
        { name: "G", netId: 2, shapeIds: [] },
        { name: "S", netId: 3, shapeIds: [] },
        { name: "B", netId: 0, shapeIds: [] },
      ],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test_die", {}, "cdl");
  assert.ok(result.text.includes("M1"), "has M1");
  assert.ok(result.text.includes("W=10.000u"), "W param");
  assert.ok(result.text.includes("L=0.350u"), "L param");
  assert.ok(result.text.includes(".SUBCKT"), "SUBCKT header");
  assert.ok(result.text.includes(".ENDS"), "ENDS footer");
  assert.equal(result.totalDevices, 1);
});

test("generateSpiceNetlist — BJT (CDL)", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "q1", kind: "bjt_npn",
      geometry: { AE_um2: 4, PE_um: 8, multiplier: 2, totalAE_um2: 8, emitterFingers: 1, bjtType: "npn" },
      instanceName: "Q1",
      terminals: [
        { name: "C", netId: 1, shapeIds: [] },
        { name: "B", netId: 2, shapeIds: [] },
        { name: "E", netId: 3, shapeIds: [] },
      ],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "cdl");
  assert.ok(result.text.includes("Q1"), "has Q1");
  assert.equal(result.totalDevices, 1);
});

test("generateSpiceNetlist — Resistor (CDL)", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "r1", kind: "resistor",
      geometry: { L_um: 40, W_um: 4, squares: 10, resistance_ohms: 500, fingers: 1, multiplier: 1, shape: "straight" },
      instanceName: "R1",
      terminals: [
        { name: "PLUS", netId: 1, shapeIds: [] },
        { name: "MINUS", netId: 2, shapeIds: [] },
      ],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "cdl");
  assert.ok(result.text.includes("R1"), "has R1");
  // SPICE uses r=<ohms> format, e.g. r=250
  assert.ok(result.text.includes("r="), "r= format");
  assert.equal(result.totalDevices, 1);
});

test("generateSpiceNetlist — Capacitor (CDL)", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "c1", kind: "capacitor",
      geometry: { area_um2: 100, perimeter_um: 40, capacitance_fF: 100, multiplier: 1, capType: "mim" },
      instanceName: "C1",
      terminals: [
        { name: "PLUS", netId: 1, shapeIds: [] },
        { name: "MINUS", netId: 2, shapeIds: [] },
      ],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "cdl");
  assert.ok(result.text.includes("C1"), "has C1");
  assert.equal(result.totalDevices, 1);
});

test("generateSpiceNetlist — Diode (CDL)", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "d1", kind: "diode",
      geometry: { area_um2: 25, perimeter_um: 20, multiplier: 1, diodeType: "pn" },
      instanceName: "D1",
      terminals: [
        { name: "PLUS", netId: 1, shapeIds: [] },
        { name: "MINUS", netId: 2, shapeIds: [] },
      ],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "cdl");
  assert.ok(result.text.includes("D1"), "has D1");
  assert.equal(result.totalDevices, 1);
});

test("generateSpiceNetlist — Spectre dialect", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "m1", kind: "mos",
      geometry: { L_um: 0.35, W_um: 10, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "nmos" },
      instanceName: "M1",
      terminals: [
        { name: "D", netId: 1, shapeIds: [] },
        { name: "G", netId: 2, shapeIds: [] },
        { name: "S", netId: 3, shapeIds: [] },
        { name: "B", netId: 0, shapeIds: [] },
      ],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "spectre");
  assert.ok(result.text.includes("M1"), "has M1");
  assert.ok(result.text.includes("subckt"), "subckt header");
  assert.ok(result.text.includes("ends"), "ends footer");
});

test("generateSpiceNetlist — mixed devices + byKind counts", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "m1", kind: "mos",
      geometry: { L_um: 1, W_um: 10, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "nmos" },
      instanceName: "M1",
      terminals: [],
    }),
    makeDevice({
      id: "r1", kind: "resistor",
      geometry: { L_um: 10, W_um: 2, squares: 5, resistance_ohms: 250, fingers: 1, multiplier: 1, shape: "straight" },
      instanceName: "R1",
      terminals: [],
    }),
  ];
  const result = generateSpiceNetlist(devices, "mixed", {}, "cdl");
  assert.equal(result.byKind["mos"], 1);
  assert.equal(result.byKind["resistor"], 1);
  assert.equal(result.totalDevices, 2);
});

test("generateSpiceNetlist — unconnected terminal warning", () => {
  const devices: AnalogDevice[] = [
    makeDevice({
      id: "r1", kind: "resistor",
      geometry: { L_um: 10, W_um: 2, squares: 5, resistance_ohms: 250, fingers: 1, multiplier: 1, shape: "straight" },
      instanceName: "R1",
      terminals: [
        { name: "PLUS", netId: 1, shapeIds: [] },
        { name: "MINUS", netId: -1, shapeIds: [] },
      ],
    }),
  ];
  const result = generateSpiceNetlist(devices, "test", {}, "cdl");
  assert.ok(result.warnings.length >= 1, "should warn about unconnected terminal");
});

test("generateSpiceNetlist — empty device list", () => {
  const result = generateSpiceNetlist([], "empty", {}, "cdl");
  assert.ok(result.text.includes("SUBCKT"), "should still produce SUBCKT");
  assert.equal(result.totalDevices, 0);
  assert.equal(Object.keys(result.byKind).length, 0, "byKind should be empty");
});
