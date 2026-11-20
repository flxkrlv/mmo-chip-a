import test from "node:test";
import assert from "node:assert/strict";

import { convert } from "./convert.mjs";

/**
 * A small neutral document with one of each family the converter maps onto a
 * stock analog-canvas symbol, plus a rail marker and a Cell pin.
 */
const layout = {
  format: "mmo.schematic-layout",
  version: 1,
  generatedAt: "2026-11-20T00:00:00.000Z",
  source: { tool: "mmo-chip", scope: "ota", title: "OTA" },
  grid: 10,
  scale: 1,
  symbols: [
    {
      id: "mmo:resistor_v",
      name: "resistor_v",
      width: 10,
      height: 50,
      pins: [
        { name: "PLUS", x: 5, y: 0, direction: "north", role: "passive" },
        { name: "MINUS", x: 5, y: 50, direction: "south", role: "passive" },
      ],
      primitives: [],
    },
    {
      id: "mmo:transistor_nmos",
      name: "transistor_nmos",
      width: 42,
      height: 36,
      pins: [
        { name: "D", x: 30, y: 0, direction: "north", role: "drain" },
        { name: "G", x: 0, y: 18, direction: "west", role: "gate" },
        { name: "S", x: 30, y: 36, direction: "south", role: "source" },
        { name: "B", x: 36, y: 18, direction: "east", role: "bulk" },
      ],
      primitives: [],
    },
    {
      id: "mmo:transistor_npn",
      name: "transistor_npn",
      width: 32,
      height: 32,
      pins: [
        { name: "C", x: 22, y: 2, direction: "north", role: "collector" },
        { name: "B", x: 0, y: 16, direction: "west", role: "base" },
        { name: "E", x: 23, y: 29, direction: "south", role: "emitter" },
      ],
      primitives: [],
    },
    {
      id: "mmo:diode_v",
      name: "diode_v",
      width: 20,
      height: 50,
      pins: [
        { name: "PLUS", x: 10, y: 0, direction: "north", role: "passive" },
        { name: "MINUS", x: 10, y: 50, direction: "south", role: "passive" },
      ],
      primitives: [],
    },
    {
      id: "mmo:vcc",
      name: "vcc",
      width: 20,
      height: 30,
      pins: [{ name: "PLUS", x: 10, y: 30, direction: "south", role: "passive" }],
      primitives: [],
    },
    {
      id: "mmo:gnd",
      name: "gnd",
      width: 20,
      height: 30,
      pins: [{ name: "PLUS", x: 10, y: -15, direction: "north", role: "passive" }],
      primitives: [],
    },
    {
      id: "mmo:inputExt",
      name: "inputExt",
      width: 30,
      height: 20,
      pins: [{ name: "Y", x: 30, y: 10, direction: "east", role: "passive" }],
      primitives: [],
    },
  ],
  instances: [
    {
      id: "R1",
      reference: "R1",
      symbolId: "mmo:resistor_v",
      kind: "device",
      deviceKind: "resistor",
      value: "2200",
      position: { x: 10, y: 20 },
      rotation: 0,
      mirror: "none",
      sourceKey: "R1",
    },
    {
      id: "R2",
      reference: "R2",
      symbolId: "mmo:resistor_v",
      kind: "device",
      deviceKind: "resistor",
      position: { x: 33, y: 47 },
      rotation: 0,
      mirror: "none",
      sourceKey: "R2",
    },
    {
      id: "M1",
      reference: "M1",
      symbolId: "mmo:transistor_nmos",
      kind: "device",
      deviceKind: "mos",
      model: "nch",
      parameters: { w: "2u", l: "180n", m: "2" },
      position: { x: 100, y: 100 },
      rotation: 180,
      mirror: "none",
      sourceKey: "M1",
    },
    {
      id: "Q1",
      reference: "Q1",
      symbolId: "mmo:transistor_npn",
      kind: "device",
      deviceKind: "bjt_npn",
      position: { x: 200, y: 100 },
      rotation: 0,
      mirror: "none",
      sourceKey: "Q1",
    },
    {
      id: "D1",
      reference: "D1",
      symbolId: "mmo:diode_v",
      kind: "device",
      deviceKind: "diode",
      position: { x: 300, y: 100 },
      rotation: 0,
      mirror: "none",
      sourceKey: "D1",
    },
    {
      id: "VCC_1",
      reference: "VCC:1",
      symbolId: "mmo:vcc",
      kind: "power",
      powerKind: "vcc",
      position: { x: 0, y: 0 },
      rotation: 0,
      mirror: "none",
      sourceKey: "VCC:1",
    },
    {
      id: "GND_1",
      reference: "GND:1",
      symbolId: "mmo:gnd",
      kind: "power",
      powerKind: "gnd",
      position: { x: 0, y: 200 },
      rotation: 0,
      mirror: "none",
      sourceKey: "GND:1",
    },
    {
      id: "io_9",
      reference: "INP",
      symbolId: "mmo:inputExt",
      kind: "io",
      ioDirection: "input",
      position: { x: -100, y: 100 },
      rotation: 0,
      mirror: "none",
      sourceKey: "io:9",
    },
  ],
  nets: [
    {
      id: "net-1",
      name: "INP",
      terminals: [
        { instance: "io_9", pin: "Y" },
        { instance: "R1", pin: "PLUS" },
      ],
    },
    {
      id: "net-2",
      name: "VCC",
      terminals: [
        { instance: "VCC_1", pin: "PLUS" },
        { instance: "M1", pin: "S" },
        { instance: "M1", pin: "B" },
      ],
    },
    {
      id: "net-3",
      name: "GND",
      terminals: [
        { instance: "GND_1", pin: "PLUS" },
        { instance: "R1", pin: "MINUS" },
        { instance: "R2", pin: "MINUS" },
        { instance: "Q1", pin: "E" },
        { instance: "D1", pin: "MINUS" },
      ],
    },
    {
      id: "net-4",
      terminals: [
        { instance: "R2", pin: "PLUS" },
        { instance: "M1", pin: "D" },
        { instance: "Q1", pin: "C" },
        { instance: "D1", pin: "PLUS" },
      ],
    },
    {
      id: "net-5",
      terminals: [{ instance: "M1", pin: "G" }],
    },
    {
      id: "net-6",
      terminals: [{ instance: "Q1", pin: "B" }],
    },
  ],
  routes: [
    {
      netId: "net-1",
      from: { instance: "io_9", pin: "Y" },
      to: { instance: "R1", pin: "PLUS" },
      bends: [{ x: 6, y: 19 }],
    },
  ],
  warnings: [],
};

const options = { routes: true, grid: null, scale: null, name: null };

test("emits a loadable schema-58 project skeleton", () => {
  const { project } = convert(structuredClone(layout), options);
  assert.equal(project.schemaVersion, 58);
  assert.equal(project.topDocumentId, "document-main");
  assert.equal(project.documents.length, 1);
  assert.equal(project.componentDefinitions, undefined);
  assert.deepEqual(project.source, {
    dialect: "none",
    entry: null,
    files: [],
    sourcePolicy: "copy",
  });
  const doc = project.documents[0];
  assert.equal(doc.id, "document-main");
  assert.equal(doc.netlist.name, "OTA");
  assert.equal(doc.presentation.grid, 10);
  for (const key of [
    "instances",
    "routes",
    "nets",
    "junctions",
    "annotations",
    "constraints",
    "layoutGroups",
    "noConnects",
    "connectivityEvidence",
    "drafting",
  ]) {
    assert.ok(key in doc, `document is missing ${key}`);
  }
  assert.equal(doc.sourceStatus, "in-sync");
  assert.equal(doc.revision, 0);
});

test("every instance names a reviewed stock symbol", () => {
  const { project } = convert(structuredClone(layout), options);
  const ids = new Set(project.documents[0].instances.map((i) => i.symbolId));
  assert.deepEqual([...ids].sort(), [
    "diode",
    "ground",
    "nmos",
    "npn",
    "port",
    "resistor",
    "vdd-port",
  ]);
  for (const id of ids) {
    assert.ok(!id.startsWith("mmo:"), `${id} is a private symbol`);
  }
});

test("resistor pins become the library's numbered terminals", () => {
  const { project } = convert(structuredClone(layout), options);
  const doc = project.documents[0];
  const net1 = doc.nets.find((net) => net.id === "net-1");
  assert.deepEqual(net1.terminals, [
    { instanceId: "io_9", pinName: "P" },
    { instanceId: "R1", pinName: "1" },
  ]);
  // Diode + and − map to A and K; a BJT keeps C/B/E.
  const gnd = doc.nets.find((net) => net.id === "net-3");
  assert.deepEqual(
    gnd.terminals.map((t) => `${t.instanceId}.${t.pinName}`),
    ["GND_1.0", "R1.2", "R2.2", "Q1.E", "D1.K"],
  );
});

test("device values and models survive as netlist parameters", () => {
  const { project } = convert(structuredClone(layout), options);
  const byId = new Map(
    project.documents[0].instances.map((instance) => [instance.id, instance]),
  );
  assert.deepEqual(byId.get("R1").netlist.parameters, { value: "2200" });
  assert.deepEqual(byId.get("M1").netlist, {
    binding: { kind: "model", deviceClass: "mos", name: "nch" },
    parameters: { w: "2u", l: "180n", m: "2" },
  });
  assert.deepEqual(byId.get("Q1").netlist, {
    binding: { kind: "model", deviceClass: "bjt", name: "NPN" },
    parameters: {},
  });
  assert.deepEqual(byId.get("D1").netlist, {
    binding: { kind: "model", deviceClass: "diode", name: "D" },
    parameters: {},
  });
  assert.equal(byId.get("VCC_1").netlist, undefined);
});

test("pins land on the document grid after placement", () => {
  const { project } = convert(structuredClone(layout), options);
  const doc = project.documents[0];
  const pins = {
    resistor: [{ x: 0, y: -20 }, { x: 0, y: 20 }],
    npn: [{ x: 0, y: -20 }, { x: -30, y: 0 }, { x: 0, y: 20 }],
    diode: [{ x: -20, y: 0 }, { x: 20, y: 0 }],
    ground: [{ x: 0, y: -10 }],
    "vdd-port": [{ x: 0, y: 20 }],
    port: [{ x: 0, y: 0 }],
  };
  for (const instance of doc.instances) {
    const origin = instance.placement.position;
    assert.equal(Math.abs(origin.x % 10), 0, `${instance.id} x`);
    assert.equal(Math.abs(origin.y % 10), 0, `${instance.id} y`);
    for (const pin of pins[instance.symbolId] ?? []) {
      assert.equal(Math.abs((origin.x + pin.x) % 10), 0, `${instance.id} pin x`);
      assert.equal(Math.abs((origin.y + pin.y) % 10), 0, `${instance.id} pin y`);
    }
  }
});

test("power markers declare the rail name and domain", () => {
  const { project } = convert(structuredClone(layout), options);
  const doc = project.documents[0];
  const claims = doc.connectivityEvidence.filter((e) => e.kind === "name-claim");
  assert.deepEqual(
    claims.map((c) => [c.name, c.scope, c.powerDomain, c.owner.objectId]).sort(),
    [
      ["0", "global", "ground", "GND_1"],
      ["VCC", "global", "vdd", "VCC_1"],
    ],
  );
  assert.ok(
    doc.connectivityEvidence.some(
      (e) => e.kind === "net-name-hint" && e.netId === "net-1",
    ),
  );
});

test("io pins become Cell terminals with a port symbol", () => {
  const { project } = convert(structuredClone(layout), options);
  const doc = project.documents[0];
  assert.deepEqual(doc.netlist.terminals, [
    {
      id: "terminal-io_9",
      name: "INP",
      netId: "net-1",
      direction: "input",
      interfaceInstanceIds: ["io_9"],
    },
  ]);
  assert.equal(
    doc.instances.find((instance) => instance.id === "io_9").symbolId,
    "port",
  );
});

test("routes are orthogonal and anchored on stock pins", () => {
  const { project } = convert(structuredClone(layout), options);
  const doc = project.documents[0];
  assert.ok(doc.routes.length >= 1);
  const route = doc.routes[0];
  assert.deepEqual(route.start, {
    kind: "terminal",
    instanceId: "io_9",
    pinName: "P",
  });
  const ids = new Set();
  for (const leg of route.legs) {
    assert.ok(!ids.has(leg.id));
    ids.add(leg.id);
    if (leg.to.kind === "bend") {
      assert.ok(!ids.has(leg.to.bendId));
      ids.add(leg.to.bendId);
    }
  }

  const PINS = {
    resistor: { "1": { x: 0, y: -20 }, "2": { x: 0, y: 20 } },
    nmos: {
      D: { x: 10, y: -20 },
      G: { x: -20, y: 0 },
      S: { x: 10, y: 20 },
      B: { x: 20, y: 0 },
    },
    npn: { C: { x: 0, y: -20 }, B: { x: -30, y: 0 }, E: { x: 0, y: 20 } },
    diode: { A: { x: -20, y: 0 }, K: { x: 20, y: 0 } },
    ground: { "0": { x: 0, y: -10 } },
    "vdd-port": { P: { x: 0, y: 20 } },
    port: { P: { x: 0, y: 0 } },
  };
  const orient = (p, rotation, mirror) => {
    let { x, y } = p;
    if (rotation === 90) [x, y] = [-y, x];
    else if (rotation === 180) [x, y] = [-x, -y];
    else if (rotation === 270) [x, y] = [y, -x];
    if (mirror === "horizontal" || mirror === "both") x = -x;
    if (mirror === "vertical" || mirror === "both") y = -y;
    return { x, y };
  };
  const pinAt = (instanceId, pinName) => {
    const instance = doc.instances.find((i) => i.id === instanceId);
    const local = PINS[instance.symbolId][pinName];
    const offset = orient(
      local,
      instance.placement.rotation,
      instance.placement.mirror,
    );
    return {
      x: instance.placement.position.x + offset.x,
      y: instance.placement.position.y + offset.y,
    };
  };
  for (const route of doc.routes) {
    const points = [pinAt(route.start.instanceId, route.start.pinName)];
    for (const leg of route.legs)
      if (leg.to.kind === "bend") {
        // The editor validates bends on gcd(grid, SYMBOL_CONNECTION_GRID) = 2.
        assert.equal(Math.abs(leg.to.position.x % 2), 0, `${route.id} bend x`);
        assert.equal(Math.abs(leg.to.position.y % 2), 0, `${route.id} bend y`);
        points.push(leg.to.position);
      }
    const end = route.legs.at(-1).to.endpoint;
    points.push(pinAt(end.instanceId, end.pinName));
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      assert.ok(
        a.x === b.x || a.y === b.y,
        `${route.id} has a diagonal ${JSON.stringify([a, b])}`,
      );
    }
  }
});

test("odd mmo bend coordinates snap to the editor's 2-unit lattice", () => {
  const odd = structuredClone(layout);
  // Live ELK output is not quantised: bends may sit on odd units.
  for (const route of odd.routes) {
    route.bends = route.bends.map((bend, index) => ({
      x: bend.x + (index % 2 === 0 ? 1 : 3),
      y: bend.y + 1,
    }));
  }
  const { project } = convert(odd, options);
  for (const route of project.documents[0].routes) {
    for (const leg of route.legs) {
      if (leg.to.kind !== "bend") continue;
      assert.equal(leg.to.position.x % 2, 0, `${route.id} x`);
      assert.equal(leg.to.position.y % 2, 0, `${route.id} y`);
    }
  }
});

test("every instance gets a bound reference label", () => {
  const { project } = convert(structuredClone(layout), options);
  const doc = project.documents[0];
  const devices = doc.instances.filter(
    (instance) => instance.netlist !== undefined || instance.symbolId === "diode",
  );
  assert.equal(doc.annotations.length, devices.length);
  for (const annotation of doc.annotations) {
    assert.equal(annotation.kind, "instance-label");
    assert.equal(annotation.binding.kind, "instance-reference");
    assert.equal(annotation.anchor.kind, "object");
    assert.equal(annotation.anchor.objectId, annotation.binding.instanceId);
  }
});

test("topology-only export drops wire geometry", () => {
  const { project } = convert(structuredClone(layout), {
    ...options,
    routes: false,
  });
  assert.deepEqual(project.documents[0].routes, []);
  assert.equal(project.documents[0].nets.length, 6);
});

test("a hierarchy block is reported instead of inventing a symbol", () => {
  const withBlock = structuredClone(layout);
  withBlock.symbols.push({
    id: "mmo:block:cell_a",
    name: "cell_a",
    width: 80,
    height: 60,
    pins: [{ name: "in_a", x: 0, y: 20, direction: "west", role: "input" }],
    primitives: [],
  });
  withBlock.instances.push({
    id: "blk_cell_a",
    reference: "cell_a",
    symbolId: "mmo:block:cell_a",
    kind: "block",
    position: { x: 500, y: 500 },
    rotation: 0,
    mirror: "none",
    sourceKey: "blk:cell_a",
  });
  const { project, warnings, stats } = convert(withBlock, options);
  assert.equal(stats.instances, 8);
  assert.ok(warnings.some((w) => w.includes("cell_a")));
  assert.ok(
    project.documents[0].instances.every((i) => i.symbolId !== "mmo:block:cell_a"),
  );
});

/** A parent with one block whose child Cell has two resistors and two ports. */
function hierarchicalLayout() {
  const parent = structuredClone(layout);
  parent.symbols.push({
    id: "mmo:block:cell_a",
    name: "cell_a",
    width: 120,
    height: 80,
    pins: [
      { name: "in_VIN", x: 0, y: 30, direction: "west", role: "input" },
      { name: "out_VOUT", x: 120, y: 30, direction: "east", role: "output" },
    ],
    primitives: [],
  });
  parent.instances.push({
    id: "blk_cell_a",
    reference: "cell_a",
    symbolId: "mmo:block:cell_a",
    kind: "block",
    cellId: "cell_a",
    position: { x: 500, y: 500 },
    rotation: 0,
    mirror: "none",
    sourceKey: "blk:cell_a",
  });
  // The block's pins live on the same mmo Nets as the child's ports.
  parent.nets.find((net) => net.id === "net-4").terminals.push({
    instance: "blk_cell_a",
    pin: "in_VIN",
  });
  parent.nets
    .find((net) => net.id === "net-1")
    .terminals.push({ instance: "blk_cell_a", pin: "out_VOUT" });

  parent.cells = [
    {
      id: "cell_a",
      name: "Amplifier",
      netlistName: "amp",
      document: {
        format: "mmo.schematic-layout",
        version: 1,
        generatedAt: "2026-11-20T00:00:00.000Z",
        source: { tool: "mmo-chip", scope: "region:A", title: "Amplifier" },
        grid: 10,
        scale: 1,
        symbols: [
          {
            id: "mmo:resistor_v",
            name: "resistor_v",
            width: 10,
            height: 50,
            pins: [
              { name: "PLUS", x: 5, y: 0, direction: "north", role: "passive" },
              { name: "MINUS", x: 5, y: 50, direction: "south", role: "passive" },
            ],
            primitives: [],
          },
          {
            id: "mmo:inputExt",
            name: "inputExt",
            width: 30,
            height: 20,
            pins: [{ name: "Y", x: 30, y: 10, direction: "east", role: "passive" }],
            primitives: [],
          },
          {
            id: "mmo:outputExt",
            name: "outputExt",
            width: 30,
            height: 20,
            pins: [{ name: "Y", x: 30, y: 10, direction: "east", role: "passive" }],
            primitives: [],
          },
        ],
        instances: [
          {
            id: "R10",
            reference: "R10",
            symbolId: "mmo:resistor_v",
            kind: "device",
            deviceKind: "resistor",
            value: "1000",
            position: { x: 100, y: 100 },
            rotation: 0,
            mirror: "none",
            sourceKey: "R10",
          },
          {
            id: "R11",
            reference: "R11",
            symbolId: "mmo:resistor_v",
            kind: "device",
            deviceKind: "resistor",
            value: "2000",
            position: { x: 200, y: 100 },
            rotation: 0,
            mirror: "none",
            sourceKey: "R11",
          },
          {
            id: "io_VIN",
            reference: "VIN",
            symbolId: "mmo:inputExt",
            kind: "io",
            ioDirection: "input",
            position: { x: 0, y: 100 },
            rotation: 0,
            mirror: "none",
            sourceKey: "bp:4",
          },
          {
            id: "io_VOUT",
            reference: "VOUT",
            symbolId: "mmo:outputExt",
            kind: "io",
            ioDirection: "output",
            position: { x: 300, y: 100 },
            rotation: 0,
            mirror: "none",
            sourceKey: "bp:1",
          },
        ],
        nets: [
          {
            id: "net-4",
            name: "VIN",
            terminals: [
              { instance: "io_VIN", pin: "Y" },
              { instance: "R10", pin: "PLUS" },
            ],
          },
          {
            id: "net-105",
            name: "MID",
            terminals: [
              { instance: "R10", pin: "MINUS" },
              { instance: "R11", pin: "PLUS" },
            ],
          },
          {
            id: "net-1",
            name: "VOUT",
            terminals: [
              { instance: "R11", pin: "MINUS" },
              { instance: "io_VOUT", pin: "Y" },
            ],
          },
        ],
        routes: [],
        warnings: [],
      },
    },
  ];
  return parent;
}

test("a hierarchy block becomes a child Cell with real ports", () => {
  const { project, warnings, stats } = convert(hierarchicalLayout(), options);
  assert.equal(stats.cells, 1);
  assert.equal(stats.documents, 2);
  assert.equal(project.documents.length, 2);
  assert.equal(project.topDocumentId, "document-main");

  const [top, child] = project.documents;
  assert.equal(child.id, "document-cell-1");
  assert.equal(child.name, "Amplifier");
  assert.equal(child.netlist.name, "amp");
  assert.deepEqual(
    child.netlist.terminals.map((t) => [t.name, t.direction, t.netId]),
    [
      ["VIN", "input", "net-4"],
      ["VOUT", "output", "net-1"],
    ],
  );
  assert.equal(child.instances.find((i) => i.id === "io_VIN").symbolId, "port");
  assert.ok(
    project.documents.every((doc) =>
      doc.instances.every((instance) => !instance.symbolId.startsWith("mmo:")),
    ),
  );
  assert.ok(
    warnings.every((message) => !message.includes("is not drawn")),
    warnings.join("\n"),
  );

  const block = top.instances.find((i) => i.id === "blk_cell_a");
  assert.match(block.symbolId, /^hierarchical-symbol-[0-9a-f]{16}$/);
  assert.deepEqual(block.netlist.binding, {
    kind: "subcircuit",
    childDocumentId: "document-cell-1",
  });
  assert.match(block.reference, /^X/);

  // The block's pins are the child Cell's terminals, on the same mmo Nets.
  const vin = top.nets.find((net) => net.id === "net-4");
  const vout = top.nets.find((net) => net.id === "net-1");
  assert.ok(
    vin.terminals.some(
      (t) => t.instanceId === "blk_cell_a" && t.pinName === "VIN",
    ),
  );
  assert.ok(
    vout.terminals.some(
      (t) => t.instanceId === "blk_cell_a" && t.pinName === "VOUT",
    ),
  );
});

test("child Cell geometry matches the parent block's pins", () => {
  const { project } = convert(hierarchicalLayout(), options);
  const child = project.documents[1];
  const { minimumBodySize, pinPlacements } = child.presentation.cellSymbol;
  assert.equal(minimumBodySize.width % 20, 0);
  assert.equal(minimumBodySize.height % 20, 0);
  assert.deepEqual(
    pinPlacements.map((p) => [p.side, p.offset]),
    [
      ["west", 0],
      ["east", 0],
    ],
  );
  // Pins sit one lead outside the body and stay on the 10-unit grid.
  const block = project.documents[0].instances.find(
    (i) => i.id === "blk_cell_a",
  );
  const origin = block.placement.position;
  assert.equal(
    Math.abs((origin.x - minimumBodySize.width / 2 - 10) % 10),
    0,
  );
  assert.equal(Math.abs((origin.y + 0) % 10), 0);

  const vin = project.documents[0].nets.find((net) => net.id === "net-4");
  const route = project.documents[0].routes.find(
    (r) =>
      r.start.instanceId === "blk_cell_a" ||
      r.legs.at(-1).to.endpoint.instanceId === "blk_cell_a",
  );
  assert.ok(route, "no wire reaches the block");
  assert.ok(
    vin.terminals.some((t) => t.instanceId === "blk_cell_a"),
  );
});

test("a child Cell links every Net member so none vanishes on re-save", () => {
  const { project } = convert(hierarchicalLayout(), options);
  const child = project.documents[1];
  const mid = child.nets.find((net) => net.id === "net-105");
  assert.ok(mid);
  const covered = new Set();
  for (const route of child.routes) {
    covered.add(`${route.start.instanceId}|${route.start.pinName}`);
    const end = route.legs.at(-1).to.endpoint;
    covered.add(`${end.instanceId}|${end.pinName}`);
  }
  for (const terminal of mid.terminals)
    assert.ok(
      covered.has(`${terminal.instanceId}|${terminal.pinName}`),
      `${terminal.instanceId}.${terminal.pinName} has no wire`,
    );
});

test("an explicit ioDirection survives the template inversion", () => {
  const explicit = structuredClone(layout);
  // A boundary input is drawn with outputExt art but is still an input pin.
  explicit.instances.find((i) => i.id === "io_9").symbolId = "mmo:outputExt";
  explicit.instances.find((i) => i.id === "io_9").ioDirection = "input";
  explicit.symbols.push({
    id: "mmo:outputExt",
    name: "outputExt",
    width: 30,
    height: 20,
    pins: [{ name: "Y", x: 30, y: 10, direction: "east", role: "passive" }],
    primitives: [],
  });
  const { project } = convert(explicit, options);
  assert.equal(project.documents[0].netlist.terminals[0].direction, "input");
});

test("a block without its Cell stays a warning, not a dangling binding", () => {
  const withBlock = hierarchicalLayout();
  delete withBlock.cells;
  const { project, stats } = convert(withBlock, options);
  assert.equal(project.documents.length, 1);
  assert.equal(stats.cells, 0);
  assert.ok(
    project.documents[0].instances.every((i) => i.id !== "blk_cell_a"),
  );
});

test("old neutral documents without `kind` still convert", () => {
  const legacy = structuredClone(layout);
  for (const instance of legacy.instances) {
    delete instance.kind;
    delete instance.powerKind;
    delete instance.ioDirection;
  }
  const { project } = convert(legacy, options);
  const doc = project.documents[0];
  assert.equal(
    doc.instances.find((i) => i.id === "VCC_1").symbolId,
    "vdd-port",
  );
  assert.equal(doc.netlist.terminals.length, 1);
  assert.equal(doc.connectivityEvidence.filter((e) => e.kind === "name-claim").length, 2);
});

test("rejects a foreign document", () => {
  assert.throws(
    () => convert({ format: "something-else", version: 1 }, options),
    /not an mmo\.schematic-layout document/,
  );
});

test("rejects a newer document version", () => {
  assert.throws(
    () => convert({ ...structuredClone(layout), version: 99 }, options),
    /newer than this converter supports/,
  );
});
