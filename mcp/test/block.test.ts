import test from "node:test";
import assert from "node:assert/strict";
import { buildBlockSubcircuit, parseCdlDevices, selectedModels } from "../src/block.js";

const CDL = `
* sample
.SUBCKT top a b c out gnd
R1 a b resistor r=1000
Q1 b c gnd npn m=2
R2 c out resistor r=500
D1 a out diode
.ENDS top
`;

test("parseCdlDevices keeps nets, models and parameters", () => {
  const devices = parseCdlDevices(CDL);
  assert.deepEqual(devices.map((d) => d.name), ["R1", "Q1", "R2", "D1"]);
  assert.deepEqual(devices[0].nets, ["a", "b"]);
  assert.equal(devices[0].params.r, "1000");
  assert.deepEqual(devices[1].nets, ["b", "c", "gnd"]);
  assert.equal(devices[1].model, "npn");
  assert.equal(devices[1].params.m, "2");
});

test("block ports are exactly nets that cross the selection boundary", () => {
  const devices = parseCdlDevices(CDL);
  const block = buildBlockSubcircuit(devices, ["R1", "Q1"], "agent_block");
  assert.deepEqual(block.ports, ["a", "c"]);
  assert.deepEqual(block.internalNets, ["b", "gnd"]);
  assert.equal(block.deviceCount, 2);
  assert.match(block.subckt, /^\.SUBCKT agent_block a c$/m);
  assert.match(block.subckt, /^  R1 a b 1000$/m);
  assert.match(block.subckt, /^  Q1 b c gnd npn m=2$/m);
  assert.match(block.subckt, /^\.ENDS agent_block$/m);
  assert.deepEqual(selectedModels(devices, block.selectedNames), ["npn"]);
});

test("missing device names are reported, not silently dropped", () => {
  const devices = parseCdlDevices(CDL);
  const block = buildBlockSubcircuit(devices, ["R1", "NOPE"], "agent_block");
  assert.deepEqual(block.selectedNames, ["R1"]);
  assert.deepEqual(block.missingNames, ["NOPE"]);
});

test("a net touched only by the selection is internal even if it is named GND", () => {
  const devices = parseCdlDevices(CDL);
  const block = buildBlockSubcircuit(devices, ["Q1"], "agent_block");
  assert.deepEqual(block.ports, ["b", "c"]);
  assert.deepEqual(block.internalNets, ["gnd"]);
});
