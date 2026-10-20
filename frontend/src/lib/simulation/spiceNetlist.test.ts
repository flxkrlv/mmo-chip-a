import { expect, test } from "vitest";
import {
  autoInstantiateDut,
  autoTestbench,
  dedupeDeviceLines,
  renameGroundNets,
  wrapFlatDut,
} from "shared/spiceNetlist";
import {
  SPICE_DEVICE_TYPES,
  SPICE_MODEL_LIBRARY,
  applyModelCards,
  cardsForOptionIds,
  composeSimulationNetlist,
  extractModelCards,
  optionById,
  optionsFor,
} from "shared/spiceModels";
import { detectDutName, parseTestbenchNetlist } from "../../lib/schematic/testbench";
import { parseDcOperatingPoint } from "./spiceService";

test("renameGroundNets turns the ground rail into node 0", () => {
  const { netlist, renamed } = renameGroundNets(`X1 OUT VCC GND ref bandgap
R1 VCC GND 1k
.subckt bandgap OUT VCC GND ref
.ends bandgap`);
  expect(renamed).toContain("GND");
  expect(netlist).toMatch(/X1 OUT VCC 0 ref bandgap/);
  expect(netlist).toMatch(/R1 VCC 0 1k/);
  expect(netlist).toMatch(/\.subckt bandgap OUT VCC 0 ref/);
});

test("autoTestbench ties the ground rail and adds a supply", () => {
  const { netlist, notes, added } = autoTestbench(`.subckt dut OUT VCC GND ref
R1 VCC ref 1k
.ends dut
X1 OUT VCC GND ref dut
.op`);
  expect(added).toContain("VDD_VCC");
  expect(netlist).toMatch(/VDD_VCC VCC 0 DC 5/);
  expect(netlist).toMatch(/X1 OUT VCC 0 ref dut/);
  expect(notes.some((n) => /renamed GND/.test(n))).toBe(true);
  expect(notes.some((n) => /no supply/.test(n))).toBe(true);
});

test("autoTestbench keeps a supply the model already wrote", () => {
  const { netlist, added } = autoTestbench(`.subckt dut OUT VCC GND ref
.ends dut
X1 OUT VCC GND ref dut
VDD VCC 0 DC 1.8
.op`);
  expect(added).toHaveLength(0);
  expect(netlist).toMatch(/VDD VCC 0 DC 1\.8/);
  expect(netlist).not.toMatch(/VDD_VCC/);
});

test("autoInstantiateDut instantiates a forgotten subcircuit", () => {
  const { netlist, notes, added } = autoInstantiateDut(`.subckt bandgap OUT VCC GND ref
R1 VCC ref 1k
.ends bandgap
VDD VCC 0 DC 5
.op`);
  expect(added).toBe("X1 OUT VCC GND ref bandgap");
  expect(netlist).toMatch(/X1 OUT VCC GND ref bandgap/);
  expect(notes.length).toBe(1);
});

test("autoInstantiateDut leaves an existing instance alone", () => {
  const netlist = `.subckt bandgap OUT VCC GND ref
.ends bandgap
X1 out vcc 0 ref bandgap
.op`;
  const { added } = autoInstantiateDut(netlist);
  expect(added).toBeNull();
});

test("dedupeDeviceLines removes a repeated instance", () => {
  const { netlist, dropped } = dedupeDeviceLines(`VDD VCC 0 DC 5
RLOAD OUT 0 10k
VDD VCC 0 DC 5
.op`);
  expect(dropped).toEqual(["VDD"]);
  expect(netlist.match(/VDD VCC/g)).toHaveLength(1);
});

test("the library offers a choice per device type, not per family", () => {
  // Every device type has its own options, so choosing one never selects the
  // other polarity or the other family.
  for (const deviceType of SPICE_DEVICE_TYPES) {
    expect(optionsFor(deviceType).length).toBeGreaterThan(0);
    for (const option of SPICE_MODEL_LIBRARY[deviceType]) {
      expect(option.deviceType).toBe(deviceType);
    }
  }
  expect(optionById("nmos-level1")?.deviceType).toBe("nmos");
  expect(optionById("npn-gp")?.deviceType).toBe("npn");
  expect(optionById("npn-gp")?.card).toMatch(/NPN/);
  expect(optionById("pnp-gp")?.card).toMatch(/PNP/);
  expect(optionById("diode-generic")?.card).toMatch(/\.MODEL diode D/);
});

test("applyModelCards emits each model name exactly once", () => {
  const netlist = `.MODEL npn NPN (BF=200 IS=1e-16)
.MODEL pnp PNP (BF=100 IS=1e-16)
Q1 c b e 0 npn
.op`;
  const { cards } = cardsForOptionIds(["npn-gp"]);
  const { netlist: out, overridden } = applyModelCards(netlist, cards);

  expect(out.match(/\.MODEL npn/gi)).toHaveLength(1);
  expect(out.match(/\.MODEL pnp/gi)).toHaveLength(1);
  // The chosen card replaced the netlist's own one.
  expect(out).toMatch(/BF=200 NF=1/);
  expect(overridden).toContain("npn");
});

test("applyModelCards lets the user's own card win", () => {
  const netlist = `.MODEL npn NPN (BF=200)\nQ1 c b e 0 npn\n.op`;
  const { cards } = cardsForOptionIds(["npn-gp"]);
  const { netlist: out } = applyModelCards(netlist, cards, ".MODEL npn NPN (BF=500)");

  expect(out.match(/\.MODEL npn/gi)).toHaveLength(1);
  expect(out).toMatch(/BF=500/);
  expect(out).not.toMatch(/BF=200/);
});

test("composeSimulationNetlist merges DUT, models and directives once", () => {
  const dut = `.MODEL npn NPN (BF=200 IS=1e-16)
.MODEL pnp PNP (BF=100 IS=1e-16)
.subckt bandgap OUT VCC 0 ref
Q1 c b e 0 npn
.ends bandgap`;
  const composed = composeSimulationNetlist({
    dutNetlist: dut,
    directives: "VDD VCC 0 DC 5\n.op",
    selection: { npn: "npn-gp" },
    customModels: ".MODEL pnp PNP (BF=100 IS=1e-16)",
    dutLabel: "DUT: bandgap",
  });

  // One card per model name, the chosen one for npn.
  expect(composed.match(/\.MODEL npn/gi)).toHaveLength(1);
  expect(composed).toMatch(/BF=200 NF=1/);
  expect(composed.match(/\.MODEL pnp/gi)).toHaveLength(1);
  // The DUT and the directives appear exactly once.
  expect(composed.match(/\.subckt bandgap/gi)).toHaveLength(1);
  expect(composed.match(/^\.op$/gmi)).toHaveLength(1);
  expect(extractModelCards(composed).npn).toMatch(/BF=200 NF=1/);
});

test("cardsForOptionIds reports unknown ids", () => {
  const { cards, applied, unknown } = cardsForOptionIds(["npn-gp", "nope"]);
  expect(Object.keys(cards)).toEqual(["npn"]);
  expect(applied).toHaveLength(1);
  expect(unknown).toEqual(["nope"]);
});

test("parseTestbenchNetlist reads the DUT block, the sources and the loads", () => {
  const tb = parseTestbenchNetlist(`.MODEL npn NPN (BF=200)
.subckt bandgap OUT VCC GND ref
R1 VCC ref 1k
.ends bandgap
VDD VCC 0 DC 5
RLOAD OUT 0 10k
X1 OUT VCC GND ref bandgap
.op`);

  expect(tb.ok).toBe(true);
  expect(tb.dutName).toBe("bandgap");
  expect(tb.dutPorts).toEqual(["OUT", "VCC", "GND", "ref"]);
  expect(tb.blocks).toHaveLength(1);
  expect(tb.blocks[0].name).toBe("X1 · bandgap");
  // The supply net is an input, the output net an output.
  const vcc = tb.blocks[0].nets.find((n) => n.name === "VCC");
  const out = tb.blocks[0].nets.find((n) => n.name === "OUT");
  expect(vcc?.direction).toBe("input");
  expect(out?.direction).toBe("output");
  // Top-level testbench elements: the source and the load.
  expect(tb.devices.map((d) => d.instanceName)).toEqual(["VDD", "RLOAD"]);
  expect(tb.devices[0].kind).toBe("voltage_source");
  expect(tb.devices[1].kind).toBe("resistor");
});

test("parseTestbenchNetlist reports a subcircuit that is never instantiated", () => {
  const tb = parseTestbenchNetlist(`.subckt bandgap OUT VCC GND ref\nR1 VCC ref 1k\n.ends bandgap`);
  expect(tb.ok).toBe(false);
  expect(tb.message).toMatch(/never instantiated/);
});

test("parseTestbenchNetlist draws a flat netlist without blocks", () => {
  const tb = parseTestbenchNetlist(`VDD VCC 0 DC 5\nR1 VCC out 1k\nR2 out 0 1k\n.op`);
  expect(tb.ok).toBe(true);
  expect(tb.blocks).toHaveLength(0);
  expect(tb.devices.map((d) => d.instanceName)).toEqual(["VDD", "R1", "R2"]);
});

test("wrapFlatDut turns a flat DUT into a subcircuit with the testbench's nets as pins", () => {
  const { wrapped, ports, netlist } = wrapFlatDut(
    `Q1 out in 0 npn
RC vcc out 1k
RB vcc in 10k`,
    "VDD vcc 0 DC 5\nRLOAD out 0 10k\n.op",
    "bandgap",
  );

  expect(wrapped).toBe(true);
  // Every net the testbench touches inside the DUT is a pin; ground is not.
  expect(ports).toEqual(["vcc", "out"]);
  expect(netlist).toMatch(/^\.subckt bandgap vcc out$/m);
  expect(netlist).toMatch(/^Xbandgap vcc out bandgap$/m);
  expect(netlist).toMatch(/^\.ends bandgap$/m);
  // The devices moved inside the block.
  expect(netlist).toMatch(/^\s+Q1 out in 0 npn$/m);
});

test("wrapFlatDut leaves a hierarchical DUT and a testbench-only net alone", () => {
  const hierarchical = `.subckt bandgap out vcc\nR1 vcc out 1k\n.ends bandgap`;
  expect(wrapFlatDut(hierarchical, "VDD vcc 0 DC 5", "chip").wrapped).toBe(false);

  // "mid" lives between the two testbench sources — it is not a DUT pin.
  const { ports } = wrapFlatDut(
    "R1 vcc out 1k",
    "VDD mid 0 DC 5\nR2 mid vcc 1k\nRLOAD out 0 10k",
    "dut",
  );
  expect(ports).toEqual(["vcc", "out"]);
});

test("a flat DUT is wrapped by the composition, so the testbench has a block", () => {
  const composed = composeSimulationNetlist({
    dutNetlist: `Q1 out in 0 npn\nRC vcc out 1k\nRB vcc in 10k`,
    directives: "VDD vcc 0 DC 5\nRLOAD out 0 10k\n.op",
    selection: { npn: "npn-gp" },
    dutName: "bandgap",
  });

  expect(composed).toMatch(/^\.subckt bandgap /m);
  expect(composed).toMatch(/^Xbandgap /m);
  expect(composed.match(/\.MODEL npn/gi)).toHaveLength(1);

  // The testbench view now has a rectangle to connect the sources to.
  const tb = parseTestbenchNetlist(composed, { vdd: "vcc", gnd: "0" });
  expect(tb.ok).toBe(true);
  expect(tb.dutName).toBe("bandgap");
  expect(tb.blocks).toHaveLength(1);
  expect(tb.blocks[0].nets.map((n) => n.name).sort()).toEqual(["out", "vcc"]);
  expect(tb.devices.map((d) => d.instanceName).sort()).toEqual(["RLOAD", "VDD"]);
});

test("detectDutName finds the subcircuit a testbench instantiates", () => {
  expect(detectDutName(`.subckt bandgap out vcc 0\nR1 vcc out 1k\n.ends bandgap\nXbandgap vcc out bandgap\n.op`)).toBe("bandgap");
  expect(detectDutName(`.subckt only out vcc\n.ends only\n.op`)).toBe("only");
  expect(detectDutName("VDD vcc 0 DC 5\nR1 vcc out 1k\n.op")).toBeNull();
});

test("parseDcOperatingPoint reports the numbers of a single-point run", () => {
  const dcOp = parseDcOperatingPoint({
    header: "", numVariables: 2, variableNames: ["v(ref)", "v(out)"],
    numPoints: 1, dataType: "real" as const,
    data: [
      { name: "v(ref)", type: "voltage" as const, values: [1.0285] },
      { name: "v(out)", type: "voltage" as const, values: [0.038] },
    ],
  });
  expect(dcOp).toEqual({ "v(ref)": 1.0285, "v(out)": 0.038 });

  // A sweep has no operating point — the waveform is the result.
  expect(parseDcOperatingPoint({
    header: "", numVariables: 2, variableNames: ["v(ref)", "v(out)"],
    numPoints: 3, dataType: "real" as const,
    data: [
      { name: "v(ref)", type: "voltage" as const, values: [1, 1, 1] },
      { name: "v(out)", type: "voltage" as const, values: [0, 1, 2] },
    ],
  })).toBeUndefined();
});
