import { expect, test } from "vitest";
import {
  autoInstantiateDut,
  autoTestbench,
  buildTestbenchViewNetlist,
  dedupeDeviceLines,
  renameGroundNets,
  requestedSignalKeys,
  requestedSignals,
  splitAtSectionMarker,
  splitSimulationSections,
  stripRunScaffolding,
  vectorKeys,
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
  optionForCard,
  optionsFor,
  restoreModelSelection,
} from "shared/spiceModels";
import { handoffSections } from "../../state/spiceHandoff";
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

// ── the testbench view never draws the DUT's body ────────────────

test("splitSimulationSections cuts at the assistant tool's Testbench marker", () => {
  const { dut, testbench } = splitSimulationSections(`.subckt bandgap OUT VCC ref
R1 VCC ref 1k
.ends bandgap
* ── Testbench ──
VDD VCC 0 DC 5
X1 OUT VCC ref bandgap
.op`);

  expect(dut).toMatch(/^\.subckt bandgap OUT VCC ref$/m);
  expect(dut).not.toMatch(/VDD VCC 0/);
  expect(testbench).toMatch(/^VDD VCC 0 DC 5$/m);
  expect(testbench).not.toMatch(/R1 VCC ref/);
});

test("splitSimulationSections also cuts at the ASCII marker of a testdata file", () => {
  const { dut, testbench } = splitSimulationSections(`.subckt bandgap OUT VCC ref
R1 VCC ref 1k
.ends bandgap
* -- Testbench --
VDD VCC 0 DC 5
X1 OUT VCC ref bandgap
.op`);

  expect(dut).toMatch(/^\.subckt bandgap OUT VCC ref$/m);
  expect(testbench).toMatch(/^VDD VCC 0 DC 5$/m);
});

test("splitSimulationSections cuts at the composed netlist's Directives marker", () => {
  const composed = composeSimulationNetlist({
    dutNetlist: `Q1 out in 0 npn\nRB vcc in 10k`,
    directives: "VDD vcc 0 DC 5\n.op",
    dutName: "bandgap",
  });

  // The marker wins over the structural fallback: everything after it is the
  // testbench, whatever shape the DUT happens to have.
  const { dut, testbench } = splitSimulationSections(composed, { dut: "", testbench: "" });
  expect(dut).toMatch(/^\.subckt bandgap /m);
  expect(testbench).toMatch(/^VDD vcc 0 DC 5$/m);
  expect(testbench).not.toMatch(/Q1 out in 0 npn/);
});

test("splitSimulationSections falls back to structure, then to what the caller knows", () => {
  const structural = splitSimulationSections(
    `.subckt bandgap OUT VCC ref\nR1 VCC ref 1k\n.ends bandgap\nVDD VCC 0 DC 5\n.op`,
    { dut: "", testbench: "" },
  );
  expect(structural.dut).toMatch(/^\.subckt bandgap/m);
  expect(structural.testbench).toMatch(/^VDD VCC 0 DC 5$/m);

  const fallback = splitSimulationSections("VDD VCC 0 DC 5", {
    dut: "Q1 out in 0 npn",
    testbench: "RLOAD out 0 10k",
  });
  expect(fallback.dut).toBe("Q1 out in 0 npn");
  expect(fallback.testbench).toBe("RLOAD out 0 10k");
});

test("buildTestbenchViewNetlist never lets the DUT's body into the view", () => {
  const view = buildTestbenchViewNetlist({
    dutNetlist: `.subckt bandgap OUT VCC GND ref\nR1 VCC ref 1k\nQ1 OUT ref GND npn\n.ends bandgap`,
    directives: `VDD VCC 0 DC 5\nRLOAD OUT 0 10k\n.op\n.print op v(ref)`,
    dutName: "bandgap",
  });

  expect(view.ok).toBe(true);
  expect(view.dutName).toBe("bandgap");
  expect(view.ports).toEqual(["OUT", "VCC", "GND", "ref"]);
  expect(view.netlist).toMatch(/^\.subckt bandgap OUT VCC GND ref$/m);
  // An EMPTY body: the pins survive, the devices do not.
  expect(view.netlist).toMatch(/^\.subckt bandgap[^\n]*\n\.ends bandgap$/m);
  expect(view.netlist).not.toMatch(/Q1 OUT ref GND npn/);

  const tb = parseTestbenchNetlist(view.netlist);
  expect(tb.ok).toBe(true);
  expect(tb.blocks).toHaveLength(1);
  expect(tb.devices.map((d) => d.instanceName).sort()).toEqual(["RLOAD", "VDD"]);
});

test("buildTestbenchViewNetlist wraps a flat DUT instead of drawing it", () => {
  const view = buildTestbenchViewNetlist({
    dutNetlist: `Q1 out in 0 npn\nRC vcc out 1k\nRB vcc in 10k`,
    directives: `VDD vcc 0 DC 5\nRLOAD out 0 10k\n.op`,
    dutName: "bandgap",
  });

  expect(view.ok).toBe(true);
  expect(view.dutName).toBe("bandgap");
  expect(view.netlist).toMatch(/^\.subckt bandgap vcc out$/m);
  expect(view.netlist).not.toMatch(/Q1 out in 0 npn/);
  expect(view.netlist).toMatch(/^X\w+ vcc out bandgap$/m);

  // The view has the DUT as ONE block, and nothing else but the testbench.
  const tb = parseTestbenchNetlist(view.netlist, { vdd: "vcc", gnd: "0" });
  expect(tb.ok).toBe(true);
  expect(tb.blocks).toHaveLength(1);
  expect(tb.devices.map((d) => d.instanceName).sort()).toEqual(["RLOAD", "VDD"]);
});

test("buildTestbenchViewNetlist reuses the DUT's own instance and adds no second one", () => {
  const view = buildTestbenchViewNetlist({
    dutNetlist: `.subckt bandgap OUT VCC GND ref\nR1 VCC ref 1k\n.ends bandgap\nXbandgap OUT VCC GND ref bandgap`,
    directives: `VDD VCC 0 DC 5\n.op`,
    dutName: "bandgap",
  });

  expect(view.ok).toBe(true);
  // The instance lives in the DUT section, so the view reuses it verbatim.
  expect(view.netlist.match(/^X\w+ /gm)).toHaveLength(1);

  const tb = parseTestbenchNetlist(view.netlist);
  expect(tb.blocks).toHaveLength(1);
});

test("buildTestbenchViewNetlist says why it cannot draw a block", () => {
  const view = buildTestbenchViewNetlist({
    dutNetlist: "",
    directives: `VDD vcc 0 DC 5\nRLOAD out 0 10k\n.op`,
    dutName: "bandgap",
  });

  expect(view.ok).toBe(false);
  expect(view.dutName).toBeNull();
  expect(view.ports).toEqual([]);
  // The testbench itself is still drawable — it just has no block.
  expect(view.netlist).toMatch(/^VDD vcc 0 DC 5$/m);
  const tb = parseTestbenchNetlist(view.netlist);
  expect(tb.ok).toBe(true);
  expect(tb.blocks).toHaveLength(0);
});

// ── only what the testbench asked to see ─────────────────────────

test("requestedSignals reads .print, .save, .plot and .measure", () => {
  expect(requestedSignals(`.op\n.print op v(ref) v(ref_1) v(out) v(vcc)`))
    .toEqual(["v(ref)", "v(ref_1)", "v(out)", "v(vcc)"]);
  expect(requestedSignals(".tran 1u 100u\n.save v(out)")).toEqual(["v(out)"]);
  expect(requestedSignals(".dc VDD 0 5 1\n.plot dc v(ref)")).toEqual(["v(ref)"]);
  // A `.measure` needs its vector saved, so it is a request too.
  expect(requestedSignals(".dc VDD 0 5 1\n.measure dc vref find v(ref) at=5"))
    .toEqual(["v(ref)"]);
  expect(requestedSignals(".tran 1u 100u\n.measure tran tp trig v(in) val='1' rise=1 targ v(out) val='1' rise=1"))
    .toEqual(["v(in)", "v(out)"]);
});

test("requestedSignals reads a .control block before it is flattened away", () => {
  expect(requestedSignals(`.control
save v(ref) v(out)
run
set filetype=ascii
write sim.raw
quit
.endc`)).toEqual(["v(ref)", "v(out)"]);
});

test("requestedSignals treats keywords and an open-ended save as 'show everything'", () => {
  expect(requestedSignals(".op\n.save all")).toEqual([]);
  expect(requestedSignals(".op")).toEqual([]);
  // An unknown vector is ignored by ngspice, so a stray word must not become a
  // signal that filters every trace away.
  expect(requestedSignals(".op\n.print op v(ref)")).toEqual(["v(ref)"]);
});

test("requestedSignalKeys matches a request however it is spelled", () => {
  // `.print (vref)` — a model spelling the node loosely — still finds v(ref).
  const loose = new Set(requestedSignals(".op\n.print op (vref)").flatMap(requestedSignalKeys));
  expect(loose.size).toBeGreaterThan(0);
  expect(vectorKeys("v(ref)").some((k) => loose.has(k))).toBe(true);

  // `v(ref)` is exact: it does not pull in the supply current.
  const exact = new Set(requestedSignalKeys("i(vdd)"));
  expect(vectorKeys("v(vdd)").some((k) => exact.has(k))).toBe(false);
  expect(vectorKeys("i(vdd)").some((k) => exact.has(k))).toBe(true);

  // A bare name is loose: `.save ref` means v(ref) to a reader.
  const bare = new Set(requestedSignalKeys("ref"));
  expect(vectorKeys("v(ref)").some((k) => bare.has(k))).toBe(true);
});

test("stripRunScaffolding drops the runner's plumbing but keeps the testbench", () => {
  const tb = [
    ".dc VDD 0 5 1",
    ".print dc v(ref)",
    ".measure dc vout find v(out) at=5",
    ".control",
    "save v(ref)",
    "run",
    "set filetype=ascii",
    "write sim.raw",
    "quit",
    ".endc",
    ".end",
  ].join("\n");
  expect(stripRunScaffolding(tb)).toBe(".dc VDD 0 5 1\n.print dc v(ref)\n.measure dc vout find v(out) at=5");
});

test("stripRunScaffolding keeps a .save the testbench asked for", () => {
  // The runner's own save lives inside `.control`; one written at top level is
  // the testbench speaking, and it is what decides what the viewer draws.
  expect(stripRunScaffolding(".op\n.save v(out)\n.end")).toBe(".op\n.save v(out)");
  // A `.measure` and a stray blank line survive too.
  expect(stripRunScaffolding(".tran 1u 10u\n\n.measure tran tp v(out)\n.end"))
    .toBe(".tran 1u 10u\n\n.measure tran tp v(out)");
});

test("splitAtSectionMarker splits on either marker and refuses to guess", () => {
  const backend = [
    "* a title",
    ".subckt dut a b",
    ".ends dut",
    "* ── Testbench ──",
    "X1 a b dut",
    ".dc VDD 0 5 1",
  ].join("\n");
  const split = splitAtSectionMarker(backend);
  expect(split.dut).toContain(".subckt dut a b");
  expect(split.dut).not.toContain("X1 a b dut");
  expect(split.testbench).toContain("X1 a b dut");

  // The composed netlist marks the same place with a different word…
  expect(splitAtSectionMarker("dut\n* ── Directives ──\n.op").dut).toBe("dut");
  // …and ASCII box drawing reads the same.
  expect(splitAtSectionMarker("dut\n* -- Directives --\n.op").dut).toBe("dut");

  // No marker: the split cannot be trusted, so it is refused, not guessed —
  // guessing would duplicate the testbench the moment it is recomposed.
  expect(splitAtSectionMarker("X1 a b dut\n.dc VDD 0 5 1").dut).toBeNull();
});

test("handoffSections turns a simulated netlist back into editable page state", () => {
  const run = [
    "* ── Models ──",
    ".MODEL LM2937 CAP (C=10p)",
    "* ── DUT: LM2937 ──",
    ".subckt LM2937 IN OUT GND",
    "C1 OUT GND 10p",
    ".ends LM2937",
    "* ── Testbench ──",
    "X1 OUT VDD 0 LM2937",
    "VDD VDD 0 5",
    "RLOAD OUT 0 1k",
    ".dc VDD 0 5 1",
    ".print dc v(out)",
    ".control",
    "save v(out)",
    "run",
    "set filetype=ascii",
    "write sim.raw",
    "quit",
    ".endc",
    ".end",
  ].join("\n");

  const sections = handoffSections(run);
  // The DUT keeps its own card and subcircuit, and none of the testbench.
  expect(sections.dut).toContain(".subckt LM2937 IN OUT GND");
  expect(sections.dut).not.toContain("RLOAD OUT 0 1k");
  // The testbench is everything after the marker, minus the plumbing.
  expect(sections.directives).toContain("X1 OUT VDD 0 LM2937");
  expect(sections.directives).toContain(".print dc v(out)");
  expect(sections.directives).not.toMatch(/\.control|\.endc|write sim\.raw|^\.end$/im);

  // Recomposed through the page's own path, the netlist carries every piece
  // the agent ran, with the cards exactly once — so Run reproduces the run.
  const recomposed = composeSimulationNetlist({
    dutNetlist: sections.dut!,
    directives: sections.directives,
    selection: sections.modelSelection,
    customModels: sections.customModels,
    dutName: "LM2937",
  });
  expect(recomposed).toContain(".subckt LM2937 IN OUT GND");
  expect(recomposed).toContain("RLOAD OUT 0 1k");
  expect(recomposed).toContain(".print dc v(out)");
  expect(extractModelCards(recomposed)).toEqual(sections.modelCards);
  // One "Models" label, not one per pass through the composer.
  expect(recomposed.split("── Models ──")).toHaveLength(2);
});

test("optionForCard recognises a library card however it is spelled", () => {
  const option = SPICE_MODEL_LIBRARY.nmos[0];
  expect(optionForCard(option.card)?.id).toBe(option.id);
  expect(optionForCard(option.card.toLowerCase())?.id).toBe(option.id);
  expect(optionForCard(option.card.replace(/\s+/g, "   "))?.id).toBe(option.id);
  expect(optionForCard(".MODEL myCap CAP (C=1p)")).toBeUndefined();
  expect(optionForCard("")).toBeUndefined();
});

test("restoreModelSelection separates the library's cards from the user's own", () => {
  const nmos = SPICE_MODEL_LIBRARY.nmos[0];
  const own = ".MODEL LM2937 CAP (C=10p)";
  const { selection, customModels } = restoreModelSelection({ nmos: nmos.card, lm2937: own });

  expect(selection.nmos).toBe(nmos.id);
  // One device type never touches another.
  expect(selection.pmos).toBeUndefined();
  // The card the library owns stays out of the user's own cards.
  expect(extractModelCards(customModels)).toEqual({ lm2937: own });
});
