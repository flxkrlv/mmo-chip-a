import { describe, it, expect } from "vitest";
import {
  buildLayoutExchange,
  orientedOrigin,
  parseSvgPath,
  primitivesFromBody,
  type LayoutExchangeDocument,
  type LayoutExchangeNode,
} from "./layoutExchange";
import { parseSymbolSkin } from "./interactiveSymbols";
import {
  deviceKey,
  gridFallback,
  powerDevices,
  transformPin,
  type DeviceOrientationLike,
} from "./interactiveAnalogLayout";
import type { AnalogDevice } from "shared";

const table = parseSymbolSkin();

function mos(
  name: string,
  mosType: "nmos" | "pmos",
  terminals: Array<[string, number]>,
): AnalogDevice {
  return {
    id: name,
    kind: "mos",
    instanceName: name,
    layer: "poly",
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    geometry: { mosType, W_um: 1, L_um: 0.5 },
    terminals: terminals.map(([t, netId]) => ({ name: t, netId })),
  } as unknown as AnalogDevice;
}

function res(name: string, terminals: Array<[string, number]>): AnalogDevice {
  return {
    id: name,
    kind: "resistor",
    instanceName: name,
    layer: "poly",
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    geometry: { resistance_ohms: 1000, squares: 10, resistorType: "poly" },
    terminals: terminals.map(([t, netId]) => ({ name: t, netId })),
  } as unknown as AnalogDevice;
}

function nodeFor(device: AnalogDevice): LayoutExchangeNode {
  const template = table.byKey.get(
    device.kind === "mos"
      ? (device.geometry as { mosType?: string }).mosType === "pmos"
        ? "pmos_v"
        : "nmos_v"
      : "r_v",
  )!;
  return {
    key: deviceKey(device),
    kind: "device",
    template,
    size: { w: template.width, h: template.height },
    device,
  };
}

describe("parseSvgPath", () => {
  it("parses a closed polygon", () => {
    expect(parseSvgPath("M0,0 H20 L10,15 Z")).toEqual([
      {
        points: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 10, y: 15 },
        ],
        closed: true,
      },
    ]);
  });

  it("expands implicit lineto pairs after moveto", () => {
    expect(parseSvgPath("M0 0 10 0 10 10")).toEqual([
      {
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        closed: false,
      },
    ]);
  });

  it("handles relative commands and multiple subpaths", () => {
    expect(parseSvgPath("m12,10 11,-8 M0,0 v5")).toEqual([
      {
        points: [
          { x: 12, y: 10 },
          { x: 23, y: 2 },
        ],
        closed: false,
      },
      {
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 5 },
        ],
        closed: false,
      },
    ]);
  });

  it("returns null for unsupported commands (fallback path)", () => {
    expect(parseSvgPath("M0,0 C1,1 2,2 3,3")).toBeNull();
    expect(parseSvgPath("M0,0 A5,5 0 0 1 10,10")).toBeNull();
  });
});

describe("primitivesFromBody", () => {
  it("turns a filled closed path into a polygon", () => {
    const body =
      '<path d="M27,30 L25,28 L25,32 Z" stroke="#ffffff" fill="#ffffff" class="detail"/>';
    expect(primitivesFromBody(body, () => {})).toEqual([
      {
        kind: "polygon",
        points: [
          { x: 27, y: 30 },
          { x: 25, y: 28 },
          { x: 25, y: 32 },
        ],
      },
    ]);
  });

  it("treats a skin-baked white fill as filled art (BJT arrows)", () => {
    // `CUSTOM_ANALOG_SKIN` writes `style="fill:#000000"` for the arrow head;
    // the parser bakes it into `fill="#ffffff"`, leaving no class at all.
    const body =
      '<path d="m23,29 -6,-1 3,-5 z" stroke="#ffffff" fill="#ffffff"/>';
    expect(primitivesFromBody(body, () => {})).toEqual([
      {
        kind: "polygon",
        points: [
          { x: 23, y: 29 },
          { x: 17, y: 28 },
          { x: 20, y: 23 },
        ],
      },
    ]);
  });

  it("keeps stroke-only art as an open polyline and closes symbol outlines", () => {
    const body =
      '<path d="M0,10 V40 H10 V10 Z" class="symbol"/><path d="M5,0 V10" class="connect"/>';
    expect(primitivesFromBody(body, () => {})).toEqual([
      {
        kind: "polyline",
        points: [
          { x: 0, y: 10 },
          { x: 0, y: 40 },
          { x: 10, y: 40 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
      },
      {
        kind: "polyline",
        points: [
          { x: 5, y: 0 },
          { x: 5, y: 10 },
        ],
      },
    ]);
  });

  it("converts circles and rectangles", () => {
    const body =
      '<circle r="16" cx="16" cy="16" class="symbol"/><rect width="30" height="40" x="0" y="0" rx="6"/>';
    expect(primitivesFromBody(body, () => {})).toEqual([
      { kind: "circle", cx: 16, cy: 16, r: 16, filled: false },
      { kind: "rect", x: 0, y: 0, w: 30, h: 40, rx: 6, filled: false },
    ]);
  });
});

describe("orientedOrigin", () => {
  // NMOS_v: box 42×36, pins D(30,0) G(0,18) S(30,36) B(36,18).
  const size = { w: 42, h: 36 };
  const pins = {
    D: { dx: 30, dy: 0 },
    G: { dx: 0, dy: 18 },
    S: { dx: 30, dy: 36 },
    B: { dx: 36, dy: 18 },
  };
  const pos = { x: 100, y: 200 };
  /** Target editor: `translate(origin) scale(mirror) rotate(deg)` — rotate
   *  and mirror are about the symbol origin (0,0), not the box centre. */
  const targetPin = (
    p: { dx: number; dy: number },
    orient: DeviceOrientationLike,
  ) => {
    let x = p.dx;
    let y = p.dy;
    if (orient.rot === 90) [x, y] = [-y, x];
    if (orient.rot === 180) [x, y] = [-x, -y];
    if (orient.rot === 270) [x, y] = [y, -x];
    if (orient.flip === "h") x = -x;
    if (orient.flip === "v") y = -y;
    return { x, y };
  };
  const origins: Array<[DeviceOrientationLike, string]> = [
    [{ rot: 0, flip: "none" }, "identity"],
    [{ rot: 90, flip: "none" }, "90°"],
    [{ rot: 270, flip: "none" }, "270°"],
    [{ rot: 180, flip: "none" }, "180°"],
    [{ rot: 0, flip: "h" }, "mirror h"],
    [{ rot: 90, flip: "v" }, "90° + mirror v"],
  ];

  for (const [orient, label] of origins) {
    it(`reproduces mmo's pin transform for ${label}`, () => {
      const origin = orientedOrigin(pos, size, orient);
      // Target editor: world = origin + R(pin) (mirror applied after rotate).
      for (const pin of Object.values(pins)) {
        const expected = transformPin(pin, size.w, size.h, orient);
        const got = targetPin(pin, orient);
        expect({
          x: origin.x + got.x,
          y: origin.y + got.y,
        }).toEqual({
          x: pos.x + expected.dx,
          y: pos.y + expected.dy,
        });
      }
    });
  }
});

describe("buildLayoutExchange", () => {
  const devices = [
    mos("M_1", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
    mos("M_2", "pmos", [["D", 1], ["G", 2], ["S", 4], ["B", 4]]),
    res("R_1", [["PLUS", 1], ["MINUS", 2]]),
    // A genuine two-terminal net so a single route can be expressed.
    res("R_2", [["PLUS", 5], ["MINUS", 6]]),
    res("R_3", [["PLUS", 5], ["MINUS", 7]]),
  ];
  const namedNets = new Map([
    [1, "OUT"],
    [2, "IN"],
    [3, "VDD"],
    [4, "GND"],
    [5, "BIAS"],
    [6, "REF_A"],
    [7, "REF_B"],
  ]);
  const opts = { vdd: "VDD", gnd: "GND" };
  const result = gridFallback(devices, namedNets, table, opts);
  const powers = powerDevices(devices, namedNets, opts);
  const nodes: LayoutExchangeNode[] = [
    ...devices.map(nodeFor),
    ...powers.map((p) => ({
      key: deviceKey(p),
      kind: "power" as const,
      template: table.byKey.get(
        deviceKey(p).startsWith("GND") ? "gnd" : "vcc",
      ),
      size: result.sizes[deviceKey(p)] ?? { w: 20, h: 30 },
      device: p,
    })),
  ];

  const doc = buildLayoutExchange({
    scopeKey: "root",
    title: "test",
    table,
    nodes,
    positions: result.positions,
    orientations: {
      M_2: { rot: 90, flip: "none" },
      R_1: { rot: 0, flip: "h" },
    },
    wires: result.wires,
    namedNets,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  it("emits one symbol per skin template with mmo pin geometry", () => {
    const ids = doc.symbols.map((s) => s.id).sort();
    expect(ids).toEqual(
      ["mmo:transistor_nmos", "mmo:transistor_pmos", "mmo:resistor_v", "mmo:vcc", "mmo:gnd"].sort(),
    );
    const nmos = doc.symbols.find((s) => s.id === "mmo:transistor_nmos")!;
    expect(nmos.pins.map((p) => p.name).sort()).toEqual(["B", "D", "G", "S"]);
    const d = nmos.pins.find((p) => p.name === "D")!;
    expect({ x: d.x, y: d.y, direction: d.direction }).toEqual({
      x: 30,
      y: 0,
      direction: "north",
    });
    const r = doc.symbols.find((s) => s.id === "mmo:resistor_v")!;
    expect(r.pins.map((p) => p.name).sort()).toEqual(["MINUS", "PLUS"]);
    expect(r.primitives.length).toBeGreaterThan(0);
  });

  it("places every node with its orientation", () => {
    expect(doc.instances).toHaveLength(nodes.length);
    const m2 = doc.instances.find((i) => i.sourceKey === "M_2")!;
    expect(m2.rotation).toBe(90);
    expect(m2.symbolId).toBe("mmo:transistor_pmos");
    const r1 = doc.instances.find((i) => i.sourceKey === "R_1")!;
    expect(r1.mirror).toBe("horizontal");
    // Node keys are sanitised into unique ids.
    const ids = doc.instances.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("describes what each node is and what the netlist needs", () => {
    const r2 = doc.instances.find((i) => i.sourceKey === "R_2")!;
    expect(r2.kind).toBe("device");
    expect(r2.deviceKind).toBe("resistor");
    // 10 squares × the canvas's own sheet-resistance default.
    expect(Number(r2.value)).toBeGreaterThan(0);
    const m1 = doc.instances.find((i) => i.sourceKey === "M_1")!;
    expect(m1.parameters).toMatchObject({ w: "1u", l: "0.5u" });
    const vdd = doc.instances.find((i) => i.sourceKey.startsWith("VDD"))!;
    expect(vdd.kind).toBe("power");
    expect(vdd.powerKind).toBe("vcc");
    const gnd = doc.instances.find((i) => i.sourceKey.startsWith("GND"))!;
    expect(gnd.powerKind).toBe("gnd");
  });

  it("uses the canvas's sheet resistance for resistor values", () => {
    const withValues = buildLayoutExchange({
      scopeKey: "root",
      table,
      nodes,
      positions: result.positions,
      orientations: {},
      wires: result.wires,
      namedNets,
      values: { sheetR: { poly: 100 } },
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const r2 = withValues.instances.find((i) => i.sourceKey === "R_2")!;
    expect(r2.value).toBe("1000");
  });

  it("keeps net membership for every device terminal", () => {
    const out = doc.nets.find((n) => n.name === "OUT")!;
    expect(out.id).toBe("net-1");
    expect(out.terminals).toEqual(
      expect.arrayContaining([
        { instance: "M_1", pin: "D" },
        { instance: "M_2", pin: "D" },
        { instance: "R_1", pin: "PLUS" },
      ]),
    );
    const vdd = doc.nets.find((n) => n.name === "VDD")!;
    expect(vdd.terminals).toEqual(
      expect.arrayContaining([
        { instance: "M_1", pin: "S" },
        { instance: "M_1", pin: "B" },
        { instance: "VDD_3", pin: "PLUS" },
      ]),
    );
  });

  it("emits routes whose endpoints belong to the routed net", () => {
    expect(doc.routes.length).toBeGreaterThan(0);
    const byId = new Map(doc.nets.map((n) => [n.id, n]));
    for (const route of doc.routes) {
      const net = byId.get(route.netId);
      expect(net, route.netId).toBeDefined();
      expect(net!.terminals).toEqual(
        expect.arrayContaining([route.from, route.to]),
      );
      for (const bend of route.bends) {
        expect(Number.isFinite(bend.x) && Number.isFinite(bend.y)).toBe(true);
      }
    }
  });

  it("is JSON-serialisable and self-describing", () => {
    const json = JSON.parse(JSON.stringify(doc));
    expect(json.format).toBe("mmo.schematic-layout");
    expect(json.version).toBe(1);
    expect(json.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(json.grid).toBe(10);
    expect(json.scale).toBe(1);
    expect(json.warnings).toEqual([]);
  });

  it("can export topology only", () => {
    const bare = buildLayoutExchange({
      scopeKey: "root",
      table,
      nodes,
      positions: result.positions,
      orientations: {},
      wires: result.wires,
      namedNets,
      includeRoutes: false,
    });
    expect(bare.routes).toEqual([]);
    expect(bare.nets.length).toBe(doc.nets.length);
  });
});

describe("buildLayoutExchange — io pins and hierarchy blocks", () => {
  const ioNode: LayoutExchangeNode = {
    key: "io:9",
    kind: "io",
    template: table.byKey.get("inputExt"),
    size: { w: 30, h: 20 },
    label: "INP",
  };
  const bpNode: LayoutExchangeNode = {
    key: "bp:11",
    kind: "io",
    template: table.byKey.get("outputExt"),
    size: { w: 30, h: 20 },
    label: "OUT",
  };
  const blockNode: LayoutExchangeNode = {
    key: "blk:core",
    kind: "block",
    size: { w: 90, h: 72 },
    label: "core",
    terminals: [
      { name: "in_INP", netId: 9 },
      { name: "out_OUT", netId: 10 },
    ],
    blockPorts: [
      { terminal: "in_INP", netName: "INP", dx: 0, dy: 22, isInput: true },
      { terminal: "out_OUT", netName: "OUT", dx: 90, dy: 22, isInput: false },
    ],
  };
  // The block shares net 9 with the io pin, so the net has two terminals.
  const nodes = [ioNode, bpNode, blockNode];
  const positions = {
    "io:9": { x: 0, y: 0 },
    "bp:11": { x: 200, y: 0 },
    "blk:core": { x: 100, y: 100 },
  };
  const doc = buildLayoutExchange({
    scopeKey: "core",
    table,
    nodes,
    positions,
    orientations: {},
    wires: new Map(),
    namedNets: new Map([
      [9, "INP"],
      [10, "OUT"],
      [11, "OUT"],
    ]),
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  it("turns an io pin into a one-pin symbol", () => {
    const io = doc.instances.find((i) => i.sourceKey === "io:9")!;
    expect(io.symbolId).toBe("mmo:inputExt");
    expect(io.reference).toBe("INP");
    const symbol = doc.symbols.find((s) => s.id === "mmo:inputExt")!;
    expect(symbol.pins).toHaveLength(1);
    expect(symbol.pins[0]).toMatchObject({ name: "Y", x: 30, y: 10, direction: "east" });
  });

  it("gives a hierarchy block its own rectangular symbol with port pins", () => {
    const block = doc.instances.find((i) => i.sourceKey === "blk:core")!;
    expect(block.symbolId).toBe("mmo:block:core");
    expect(block.reference).toBe("core");
    const symbol = doc.symbols.find((s) => s.id === "mmo:block:core")!;
    expect(symbol.pins).toEqual([
      { name: "in_INP", x: 0, y: 22, direction: "west", role: "input" },
      { name: "out_OUT", x: 90, y: 22, direction: "east", role: "output" },
    ]);
    expect(symbol.primitives).toEqual([
      { kind: "rect", x: 0, y: 0, w: 90, h: 72 },
    ]);
  });

  it("wires block pins and io pins into the same net", () => {
    const inp = doc.nets.find((n) => n.id === "net-9")!;
    expect(inp.name).toBe("INP");
    expect(inp.terminals).toEqual(
      expect.arrayContaining([
        { instance: "io_9", pin: "Y" },
        { instance: "blk_core", pin: "in_INP" },
      ]),
    );
    const out = doc.nets.find((n) => n.id === "net-10")!;
    expect(out.terminals).toEqual(
      expect.arrayContaining([{ instance: "blk_core", pin: "out_OUT" }]),
    );
    // A block-boundary pin carries its own net id from the key.
    const bp = doc.nets.find((n) => n.id === "net-11")!;
    expect(bp.terminals).toEqual([{ instance: "bp_11", pin: "A" }]);
  });

  it("carries a block's child Cell and names it on the block instance", () => {
    const child: LayoutExchangeDocument = {
      ...doc,
      cells: undefined,
      source: { tool: "mmo-chip", scope: "region:core", title: "core" },
    };
    const linked = buildLayoutExchange({
      scopeKey: "core",
      table,
      nodes: [
        {
          ...blockNode,
          cellId: "core-cell",
          terminals: [{ name: "in_INP", netId: 9 }],
          blockPorts: [
            { terminal: "in_INP", netName: "INP", dx: 0, dy: 22, isInput: true },
          ],
        },
      ],
      positions: { "blk:core": { x: 100, y: 100 } },
      orientations: {},
      wires: new Map(),
      namedNets: new Map([[9, "INP"]]),
      cells: [
        {
          id: "core-cell",
          name: "core",
          netlistName: "core",
          document: child,
        },
      ],
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(linked.cells).toHaveLength(1);
    expect(linked.cells![0]!.document.source.scope).toBe("region:core");
    expect(linked.instances[0]!.cellId).toBe("core-cell");
  });

  it("keeps an explicit io direction over the template's art", () => {
    // A boundary input is drawn with outputExt art (arrow into the block).
    const explicit = buildLayoutExchange({
      scopeKey: "core",
      table,
      nodes: [{ ...bpNode, ioDirection: "input" }],
      positions: { "bp:11": { x: 200, y: 0 } },
      orientations: {},
      wires: new Map(),
      namedNets: new Map([[11, "OUT"]]),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(explicit.instances[0]!.ioDirection).toBe("input");
  });
});
