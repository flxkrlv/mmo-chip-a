/**
 * spiceSimTool.test.ts — regression tests for the agent's SPICE tool.
 *
 * The unit tests cover the netlist normalisation (no ngspice needed). The
 * integration tests need a real ngspice; they are skipped when none is found.
 *
 * These cases are the exact failure modes that made the agent "unable to
 * launch a testbench":
 *   - a netlist without an analysis directive returned ngspice's built-in
 *     constants (boltz, e, planck) instead of circuit results;
 *   - an agent-written .control block containing `quit` killed the run before
 *     the raw file was written, and the tool still reported success;
 *   - Spectre-style node lists and "16.8*250" values made ngspice reject the
 *     netlist ("could not find a valid modelname", "unknown parameter (*)");
 *   - `.measure` results were never returned to the model.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  convertNetlistToNgspice,
  ensureAnalysis,
  evaluateNumericExpression,
  findAnalysisDirectives,
  flattenControlBlocks,
  parseNgspiceMeasurements,
} from "shared/spiceNetlist";
import { executeSpiceSimTool } from "./spiceSimTool.js";

// ── helpers ─────────────────────────────────────────────────────

/** Locate an ngspice binary, or null when none is installed. */
function findNgspice(): string | null {
  const candidates = [
    process.env.NGSPICE_BIN,
    "C:\\Program Files\\Spice64\\bin\\ngspice_con.exe",
    "C:\\Program Files\\Spice64\\bin\\ngspice.exe",
    "/usr/bin/ngspice",
    "/usr/local/bin/ngspice",
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    // bare name — assume it is on PATH
    return candidate;
  }
  return null;
}

const NGSPICE = findNgspice();
const skipWithoutNgspice = NGSPICE ? false : "ngspice is not installed";

// ── unit: netlist normalisation ─────────────────────────────────

test("evaluateNumericExpression handles plain arithmetic", () => {
  assert.equal(evaluateNumericExpression("16.8*250"), 4200);
  assert.equal(evaluateNumericExpression("1.3*10"), 13);
  assert.equal(evaluateNumericExpression("2.5*3.4/2"), 4.25);
  assert.equal(evaluateNumericExpression("(1+2)*3"), 9);
  assert.equal(evaluateNumericExpression("10*Rpoly"), null);
  assert.equal(evaluateNumericExpression("abc"), null);
});

test("convertNetlistToNgspice converts Spectre node lists and values", () => {
  const { netlist, notes } = convertNetlistToNgspice(`* LM2937 extract
.subckt LM2937 OUT VCC GND ref
R1 (Net_5 Net_6) 16.8*250
R2 Net_7 Net_8 4200
Q10 (Net_35 Net_35 GND 0) npn m=3.47
D1 (Net_94 Net_95) diode
.ends LM2937`);

  assert.match(netlist, /R1 Net_5 Net_6 4200/);
  assert.match(netlist, /Q10 Net_35 Net_35 GND 0 npn m=3\.47/);
  assert.match(netlist, /D1 Net_94 Net_95 diode/);
  assert.match(netlist, /\.subckt LM2937 OUT VCC GND ref/);
  // generic model cards for the referenced models
  assert.match(netlist, /\.MODEL npn NPN/);
  assert.match(netlist, /\.MODEL diode D/);
  assert.ok(notes.length > 0);
});

test("convertNetlistToNgspice keeps a leading directive out of the title slot", () => {
  const { netlist } = convertNetlistToNgspice(".model npn NPN (BF=200)\nV1 in 0 DC 5\nR1 in out 1k\n.op\n.end");
  const lines = netlist.split(/\r?\n/).filter((l) => l.trim());
  // The first non-comment line must not be a directive: SPICE eats line 1.
  assert.ok(!lines[0].trim().startsWith("."), `first line is a directive: ${lines[0]}`);
  assert.match(netlist, /\.model npn NPN/i);
});

test("ensureAnalysis adds .op when the netlist asks for no analysis", () => {
  const { netlist, added } = ensureAnalysis("V1 in 0 DC 5\nR1 in out 1k\nR2 out 0 1k\n.end");
  assert.equal(added, ".op");
  assert.deepEqual(findAnalysisDirectives(netlist), [".op"]);

  const already = "V1 in 0 DC 5\n.dc V1 0 5 1\n.end";
  assert.equal(ensureAnalysis(already).added, null);
});

test("flattenControlBlocks lifts analyses out and drops the rest", () => {
  const { netlist, hoisted, dropped } = flattenControlBlocks(`V1 in 0 DC 5
R1 in out 1k
.control
run
tran 1n 100n
print v(out)
quit
.endc
.end`);
  assert.deepEqual(hoisted, ["tran 1n 100n"]);
  assert.deepEqual(dropped, ["run", "print v(out)", "quit"]);
  assert.match(netlist, /^tran 1n 100n$/m);
  assert.ok(!netlist.includes("quit"));
});

test("parseNgspiceMeasurements reads the measurement block", () => {
  const stdout = `
  Measurements for DC Analysis

vout_max            =  5.00000e+00 at=  1.00000e+01
vout_avg            =  2.50000e+00 from=  -1.00000e+99 to=  1.00000e+01
`;
  assert.deepEqual(parseNgspiceMeasurements(stdout), { vout_max: 5, vout_avg: 2.5 });
});

// ── integration: the real tool ──────────────────────────────────

test("tool runs a netlist without an analysis directive", { skip: skipWithoutNgspice }, async () => {
  const { text, result } = await executeSpiceSimTool({
    netlist: `* divider
V1 in 0 DC 5
R1 in out 1k
R2 out 0 1k
.end`,
    binPath: NGSPICE ?? undefined,
  });

  assert.equal(result.success, true, result.error);
  const parsed = JSON.parse(text);
  assert.ok(!parsed.variables.includes("boltz"), "must not return ngspice's constants");
  assert.ok(parsed.variables.includes("v(out)"));
  assert.equal(parsed.sampleData["v(out)"].last, 2.5);
  assert.ok(parsed.notes.some((n: string) => n.includes(".op")));
});

test("tool survives an agent-written .control block with quit", { skip: skipWithoutNgspice }, async () => {
  const { text, result } = await executeSpiceSimTool({
    netlist: `* divider
V1 in 0 DC 5
R1 in out 1k
R2 out 0 1k
.op
.control
run
print v(out)
quit
.endc
.end`,
    binPath: NGSPICE ?? undefined,
  });

  assert.equal(result.success, true, result.error);
  const parsed = JSON.parse(text);
  assert.equal(parsed.sampleData["v(out)"].last, 2.5);
  assert.ok(parsed.notes.some((n: string) => n.includes("quit")));
});

test("tool returns .measure results", { skip: skipWithoutNgspice }, async () => {
  const { text, result } = await executeSpiceSimTool({
    netlist: `* divider
V1 in 0 DC 5
R1 in out 1k
R2 out 0 1k
.dc V1 0 10 1
.measure dc vout_max MAX v(out)
.end`,
    binPath: NGSPICE ?? undefined,
  });

  assert.equal(result.success, true, result.error);
  const parsed = JSON.parse(text);
  assert.equal(parsed.measurements.vout_max, 5);
});

test("tool evaluates .measure op itself (ngspice has no op measurement type)", { skip: skipWithoutNgspice }, async () => {
  const { text, result } = await executeSpiceSimTool({
    netlist: `* divider
V1 in 0 DC 5
R1 in out 1k
R2 out 0 1k
.op
.measure op vout_op FIND v(out)
.end`,
    binPath: NGSPICE ?? undefined,
  });

  assert.equal(result.success, true, result.error);
  const parsed = JSON.parse(text);
  assert.equal(parsed.measurements.vout_op, 2.5);
});

test("tool converts a Spectre netlist and runs it", { skip: skipWithoutNgspice }, async () => {
  const { text, result } = await executeSpiceSimTool({
    netlist: `* spectre-style bandgap
.subckt bandgap OUT VCC GND ref
R1 (VCC b1) 16.8*250
R2 (b1 b1) 16.8*250
Q1 (b1 b1 GND 0) npn m=3.47
.ends bandgap
VDD VCC 0 DC 5
RLOAD ref 0 10k
X1 OUT VCC GND ref bandgap
.op
.end`,
    binPath: NGSPICE ?? undefined,
  });

  assert.equal(result.success, true, result.error);
  const parsed = JSON.parse(text);
  assert.ok(parsed.variables.includes("v(ref)"));
  assert.ok(parsed.numPoints > 0);
});

test("tool reports a broken netlist as a failure", { skip: skipWithoutNgspice }, async () => {
  const { text, result } = await executeSpiceSimTool({
    netlist: `* broken
V1 in 0 DC 5
X9 out 0 nonexistent_subckt
.op
.end`,
    binPath: NGSPICE ?? undefined,
  });

  assert.equal(result.success, false);
  assert.ok(result.error);
  assert.equal(JSON.parse(text).success, false);
});

test("tool completes a testbench that forgot the supply", { skip: skipWithoutNgspice }, async () => {
  const { text, result } = await executeSpiceSimTool({
    netlist: `* DUT with an unconnected supply
.subckt dut VCC out
R1 VCC out 1k
.ends dut
X1 VCC out dut
.op
.end`,
    binPath: NGSPICE ?? undefined,
  });

  assert.equal(result.success, true, result.error);
  const parsed = JSON.parse(text);
  // The tool adds the supply itself and says so.
  assert.ok(
    parsed.notes.some((n: string) => /no supply was connected/i.test(n)),
    `expected a note about the added supply, got: ${JSON.stringify(parsed.notes)}`,
  );
  // The circuit is no longer floating.
  assert.ok(!parsed.warning, `unexpected warning: ${parsed.warning}`);
  assert.ok(parsed.sampleData["v(vcc)"].last > 1,
    `v(vcc) should be the supply voltage, got ${parsed.sampleData["v(vcc)"].last}`);
});

test("tool rejects an empty netlist", async () => {
  const { result } = await executeSpiceSimTool({ netlist: "   " });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Empty netlist/);
});

test("tool runs a testbench against a DUT netlist it supplies itself", { skip: skipWithoutNgspice }, async () => {
  const { text, result } = await executeSpiceSimTool({
    dutNetlist: `.subckt dut VCC out
R1 VCC out 1k
.ends dut`,
    testbench: `X1 VCC out dut
VDD VCC 0 DC 5
.op`,
    binPath: NGSPICE ?? undefined,
  });

  assert.equal(result.success, true, result.error);
  const parsed = JSON.parse(text);
  assert.equal(parsed.sampleData["v(vcc)"].last, 5);
  assert.ok(parsed.variables.includes("v(out)"));
});

test("tool instantiates a DUT the testbench forgot", { skip: skipWithoutNgspice }, async () => {
  const { text, result } = await executeSpiceSimTool({
    dutNetlist: `.subckt dut VCC out
R1 VCC out 1k
.ends dut`,
    testbench: `VDD VCC 0 DC 5
.op`,
    binPath: NGSPICE ?? undefined,
  });

  assert.equal(result.success, true, result.error);
  const parsed = JSON.parse(text);
  assert.ok(
    parsed.notes.some((n: string) => /never instantiated/.test(n)),
    `expected an instantiation note, got ${JSON.stringify(parsed.notes)}`,
  );
  assert.ok(parsed.variables.includes("v(out)"), "the DUT must be simulated");
});

test("tool drops a repeated device line", { skip: skipWithoutNgspice }, async () => {
  const { text, result } = await executeSpiceSimTool({
    dutNetlist: `.subckt dut VCC out
R1 VCC out 1k
.ends dut`,
    // The model wrote the same testbench twice.
    testbench: `X1 VCC out dut
VDD VCC 0 DC 5
.op
X1 VCC out dut
VDD VCC 0 DC 5
.op`,
    binPath: NGSPICE ?? undefined,
  });

  assert.equal(result.success, true, result.error);
  const parsed = JSON.parse(text);
  assert.ok(
    parsed.notes.some((n: string) => /repeated device line/.test(n)),
    `expected a dedupe note, got ${JSON.stringify(parsed.notes)}`,
  );
});

test("tool applies the requested standard model", { skip: skipWithoutNgspice }, async () => {
  const { text, result } = await executeSpiceSimTool({
    dutNetlist: `.subckt dut VCC out
Q1 out out 0 0 npn
.ends dut`,
    testbench: `X1 VCC out dut
VDD VCC 0 DC 5
.op`,
    models: ["npn-gp", "pnp-gp"],
    binPath: NGSPICE ?? undefined,
  });

  assert.equal(result.success, true, result.error);
  const parsed = JSON.parse(text);
  assert.ok(
    parsed.notes.some((n: string) => /standard model/.test(n)),
    `expected a model note, got ${JSON.stringify(parsed.notes)}`,
  );
});
