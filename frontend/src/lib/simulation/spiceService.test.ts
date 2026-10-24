import { expect, test } from "vitest";
import { spectreToNgspice } from "./spectreToNgspice";
import { extractModelCards } from "shared/spiceModels";
import { sanitizeNetlistForRun } from "./spiceService";

test("spectreToNgspice converts node lists, values and model cards", () => {
  const spectre = `* LM2937 extract
.subckt LM2937 OUT VCC GND ref
R1 (Net_5 Net_6) 16.8*250
Q10 (Net_35 Net_35 GND 0) npn m=3.47
D1 (Net_94 Net_95) diode
.ends LM2937`;

  const ngspice = spectreToNgspice(spectre);

  expect(ngspice).toMatch(/R1 Net_5 Net_6 4200/);
  expect(ngspice).toMatch(/Q10 Net_35 Net_35 GND 0 npn m=3\.47/);
  expect(ngspice).toMatch(/D1 Net_94 Net_95 diode/);
  expect(ngspice).toMatch(/\.subckt LM2937 OUT VCC GND ref/);
  expect(Object.keys(extractModelCards(ngspice)).length).toBeGreaterThan(0);
});

test("spectreToNgspice keeps a directive out of the SPICE title slot", () => {
  const ngspice = spectreToNgspice(".model npn NPN (BF=200)\nV1 in 0 DC 5\nR1 in out 1k\n.op");
  // SPICE swallows line 1 as the title, so line 1 must not be a directive.
  const first = ngspice.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  expect(first?.startsWith(".")).toBe(false);
});

test("sanitizeNetlistForRun removes plotting commands from a control block", () => {
  const { netlist, notes } = sanitizeNetlistForRun(`* divider
V1 in 0 DC 5
R1 in out 1k
R2 out 0 1k
.op
.control
run
plot v(out)
.endc
.end`);

  expect(netlist).not.toMatch(/plot v\(out\)/);
  expect(netlist).toMatch(/run/);
  expect(notes.some((n) => n.includes("plot"))).toBe(true);
});

test("sanitizeNetlistForRun adds .op when no analysis is requested", () => {
  const { netlist, notes } = sanitizeNetlistForRun(`* divider
V1 in 0 DC 5
R1 in out 1k
R2 out 0 1k
.end`);

  expect(netlist).toMatch(/^\.op$/m);
  expect(notes.some((n) => n.includes(".op"))).toBe(true);
});

test("sanitizeNetlistForRun keeps an existing analysis untouched", () => {
  const { netlist, notes } = sanitizeNetlistForRun(`* divider
.tran 1u 10u
.end`);
  expect(netlist).toMatch(/^\.tran 1u 10u$/m);
  expect(netlist).not.toMatch(/^\.op$/m);
  expect(notes).toHaveLength(0);
});
