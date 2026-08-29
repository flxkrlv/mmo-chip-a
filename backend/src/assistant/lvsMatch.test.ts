import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantCircuitDeviceInput } from "shared";
import { emitSubcircuitSpice } from "./subcircuitExtract.js";
import { normalizeForVyges } from "../lib/normalizeNetlist.js";
import { buildLibraryFromRows, netlistJsonToSpice, type LibraryRow } from "./lvsLibrary.js";
import { matchSubcircuit } from "./lvsMatch.js";

function mos(uuid: string, instanceName: string, d: number, g: number, s: number, b: number): AssistantCircuitDeviceInput {
  return {
    uuid,
    instanceName,
    kind: "mos",
    modelName: "nmos",
    geometry: { W_um: 10, L_um: 1, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "nmos" },
    terminals: [
      { name: "D", netId: d },
      { name: "G", netId: g },
      { name: "S", netId: s },
      { name: "B", netId: b },
    ],
  };
}

function resistor(uuid: string, instanceName: string, p: number, n: number): AssistantCircuitDeviceInput {
  return {
    uuid,
    instanceName,
    kind: "resistor",
    geometry: { L_um: 1, W_um: 1, squares: 1, fingers: 1, multiplier: 1 },
    terminals: [
      { name: "P", netId: p },
      { name: "N", netId: n },
    ],
  };
}

function bjt(uuid: string, instanceName: string, c: number, b: number, e: number): AssistantCircuitDeviceInput {
  return {
    uuid,
    instanceName,
    kind: "bjt_npn",
    modelName: "npn",
    geometry: { AE_um2: 1, PE_um: 8, multiplier: 1, totalAE_um2: 1, emitterFingers: 1, bjtType: "npn" },
    terminals: [
      { name: "C", netId: c },
      { name: "B", netId: b },
      { name: "E", netId: e },
    ],
  };
}

// Reference cell: a 2-transistor MOS current mirror (same topology as the candidate).
const MIRROR_JSON = JSON.stringify({
  nets: [
    { name: "n1" },
    { name: "n2" },
    { name: "n3" },
    { name: "GND", role: "supply_neg" },
  ],
  devices: [
    { name: "M1", type: "nmos", pins: [{ role: "D", net: "n1" }, { role: "G", net: "n2" }, { role: "S", net: "GND" }, { role: "B", net: "GND" }] },
    { name: "M2", type: "nmos", pins: [{ role: "D", net: "n3" }, { role: "G", net: "n2" }, { role: "S", net: "GND" }, { role: "B", net: "GND" }] },
  ],
});

// Reference cell: a BJT differential pair.
const DIFFPAIR_JSON = JSON.stringify({
  nets: [
    { name: "tail" },
    { name: "out1" },
    { name: "out2" },
    { name: "VSS", role: "supply_neg" },
  ],
  devices: [
    { name: "Q1", type: "npn", pins: [{ role: "C", net: "out1" }, { role: "B", net: "in1" }, { role: "E", net: "tail" }] },
    { name: "Q2", type: "npn", pins: [{ role: "C", net: "out2" }, { role: "B", net: "in2" }, { role: "E", net: "tail" }] },
  ],
});

const rows: LibraryRow[] = [
  { circuit_id: "mirror_ref", topology: "current_mirror", netlist_json: MIRROR_JSON },
  { circuit_id: "diffpair_ref", topology: "differential_pair", netlist_json: DIFFPAIR_JSON },
];

const namedNets = [
  { id: 0, name: "GND" },
  { id: 1, name: "n1" },
  { id: 2, name: "n2" },
  { id: 3, name: "n3" },
  { id: 4, name: "out1" },
  { id: 5, name: "out2" },
  { id: 6, name: "tail" },
  { id: 7, name: "VSS" },
];

test("normalizer output is well-formed CDL (no parentheses, wrapped subckt)", () => {
  const candidate = emitSubcircuitSpice(
    [mos("u1", "M1", 1, 2, 0, 0), mos("u2", "M2", 3, 2, 0, 0)],
    namedNets,
    ["u1", "u2"],
  );
  const norm = normalizeForVyges(candidate, "top");
  assert.ok(norm.includes(".SUBCKT top"), "missing .SUBCKT wrap");
  assert.ok(norm.includes(".ENDS top"), "missing .ENDS wrap");
  assert.ok(!norm.includes("("), "parentheses should be stripped by normalizer");
  assert.ok(norm.includes("GND"), "global net should survive");
});

test("candidate matches identical reference cell via LVS", async () => {
  const library = buildLibraryFromRows("test", rows);
  const candidate = emitSubcircuitSpice(
    [mos("u1", "M1", 1, 2, 0, 0), mos("u2", "M2", 3, 2, 0, 0)],
    namedNets,
    ["u1", "u2"],
  );
  const summary = await matchSubcircuit(candidate, library, { tolerance: 3, budget: 50 });
  assert.equal(summary.engineAvailable, true, "vyges-lvs should be available");
  assert.ok(summary.matches.length >= 1, "should check at least the mirror cell");
  const best = summary.best;
  assert.ok(best, "expected a best match");
  assert.equal(best!.cellId, "mirror_ref", "should match the current-mirror cell");
  assert.equal(best!.matched, true, "topologically identical cell must MATCH");
  assert.equal(best!.topology, "current_mirror");
});

test("extra resistor is reported as a near-miss with the extra device listed", async () => {
  const library = buildLibraryFromRows("test", rows);
  const candidate = emitSubcircuitSpice(
    [mos("u1", "M1", 1, 2, 0, 0), mos("u2", "M2", 3, 2, 0, 0), resistor("u3", "R1", 1, 3)],
    namedNets,
    ["u1", "u2", "u3"],
  );
  const summary = await matchSubcircuit(candidate, library, { tolerance: 3, budget: 50 });
  assert.ok(summary.matches.length >= 1);
  const mirror = summary.matches.find((m) => m.cellId === "mirror_ref")!;
  assert.equal(mirror.matched, false, "extra resistor must break the exact match");
  assert.ok(mirror.extraDevices?.includes("R1"), `should report R1 as extra, got ${mirror.extraDevices}`);
});

test("BJT differential-pair candidate matches its reference cell", async () => {
  const library = buildLibraryFromRows("test", rows);
  const candidate = emitSubcircuitSpice(
    [bjt("u1", "Q1", 4, 10, 6), bjt("u2", "Q2", 5, 11, 6)],
    namedNets,
    ["u1", "u2"],
  );
  const summary = await matchSubcircuit(candidate, library, { tolerance: 3, budget: 50 });
  const best = summary.best;
  assert.ok(best, "expected a best match");
  assert.equal(best!.cellId, "diffpair_ref");
  assert.equal(best!.matched, true);
});

test("far-from-library candidate yields no checked cells (distance exceeds tolerance)", async () => {
  const library = buildLibraryFromRows("test", rows);
  // 6 MOS devices: distance to the 2-MOS mirror is 4 > tolerance 2.
  const devices = Array.from({ length: 6 }, (_, i) => mos(`u${i}`, `M${i}`, 1 + i, 2, 0, 0));
  const candidate = emitSubcircuitSpice(devices, namedNets, devices.map((d) => d.uuid));
  const summary = await matchSubcircuit(candidate, library, { tolerance: 2, budget: 50 });
  assert.equal(summary.checkedCount, 0, "no candidate should pass the prefilter");
  assert.equal(summary.best, null);
});

test("reference netlist_json converts to valid Spectre through the same normalizer", () => {
  const spice = netlistJsonToSpice(MIRROR_JSON);
  const norm = normalizeForVyges(spice, "top");
  assert.ok(norm.includes(".SUBCKT top"));
  assert.ok(!norm.includes("("), "reference conversion must be normalizer-clean");
});
