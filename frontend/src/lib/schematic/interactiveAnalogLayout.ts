/**
 * interactiveAnalogLayout.ts — Layout + routing engine for the
 * interactive analog schematic.
 *
 * Initial layout mirrors the STATIC netlist2svg pipeline (quality
 * parity): each device becomes an ELK node with PORTS at the skin's
 * pin anchors (`portConstraints: FIXED_POS`, same trick as
 * netlist.tsx), hyperedges split into binary driver→consumer edges,
 * ELK layered runs with ORTHOGONAL routing and direction DOWN — and we
 * keep the layout DATA (positions + edge polylines) instead of
 * rendering an SVG string.
 *
 * Drag-time re-routing is LOCAL and synchronous: only the nets
 * touched by the moved device are re-routed, through a scored L/Z
 * candidate router (picks the candidate with least device-bbox
 * overlap). ELK is never run per-frame.
 *
 * Locked devices: elkjs 0.11.1 cannot pin individual nodes (verified
 * empirically — `fixed` keeps coords but never routes edges; layered
 * re-layers everything), so locked devices are EXCLUDED from the ELK
 * graph and their wires are re-routed locally.
 */

import ELK from "elkjs/lib/elk.bundled.js";
import type { AnalogDevice } from "shared";
import {
  templateForDevice,
  pinForTerminal,
  mosType,
  type SymbolTable,
} from "./interactiveSymbols";
import { computeJunctions, type PlacedEdge } from "./netlist";
import type { LayoutStrategy, LayoutDirection, CompactionLevel } from "./netlist2svgSkin";

// ── Public types ─────────────────────────────────────────────────

export type Point = { x: number; y: number };

export interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WireData {
  polylines: Point[][];
  junctions: Point[];
}

export interface InteractiveLayoutResult {
  /** Top-left position per node key (devices + VDD/GND + io pins). */
  positions: Record<string, Point>;
  sizes: Record<string, { w: number; h: number }>;
  /** Per-net routed wires (ELK ortho routes on initial layout). */
  wires: Map<number, WireData>;
  bbox: { width: number; height: number };
  /** True when ELK failed and grid fallback was used. */
  usedFallback: boolean;
  /** ELK settings actually applied — same as requested unless ELK kept
   *  failing and the auto-degrade stepped them down. */
  applied?: { strategy: LayoutStrategy; direction: LayoutDirection; compaction: CompactionLevel };
}

export interface AnalogLayoutOptions {
  vdd?: string;
  gnd?: string;
  /** Emit inputExt io-pin nodes for die-level named nets. */
  showIo?: boolean;
  /** Explicit io net ids (from collectDieWideAnalogDevices). */
  ioNetIds?: Set<number>;
  /** Node keys excluded from ELK placement (locked devices — elkjs
   *  cannot pin individual nodes). Their terminals still count as net
   *  members, so wires re-route locally to their stored anchors. */
  excludeKeys?: Set<string>;
  /** ELK layered node placement strategy (default BRANDES_KOEPF). */
  strategy?: LayoutStrategy;
  /** Layout flow direction (default DOWN — VDD top, GND bottom). */
  direction?: LayoutDirection;
  /** Post-compaction level 0-4 (0=off, 1=LUT, 2=scanline,
   *  3=scanline+sweep, 4=pocket). Default 2, matching the static view. */
  compaction?: CompactionLevel;
}

// ── ELK singleton (same pattern as netlist.tsx) ──────────────────

type ElkLike = { layout: (graph: unknown) => Promise<any> };
const elk: ElkLike = new (ELK as unknown as { new (): ElkLike })();

// ── Device → node helpers ────────────────────────────────────────

export function deviceKey(d: AnalogDevice): string {
  return d.instanceName ?? d.id;
}

interface NodePortSpec {
  pid: string;
  x: number;
  y: number;
  side: string;
  netId: number;
}

/** All wired terminals of a device as ELK port specs (skin anchors). */
function devicePorts(d: AnalogDevice, table: SymbolTable): NodePortSpec[] {
  const template = templateForDevice(table, d);
  if (!template) return [];
  const sideOf = (pos: string): string =>
    pos === "top" ? "NORTH" : pos === "bottom" ? "SOUTH" : pos === "left" ? "WEST" : "EAST";
  const out: NodePortSpec[] = [];
  for (const term of d.terminals) {
    if (term.netId < 0) continue;
    const pin = pinForTerminal(d, term.name, template);
    if (!pin) continue;
    out.push({
      pid: pin.pid,
      x: pin.dx,
      y: pin.dy,
      side: sideOf(pin.position),
      netId: term.netId,
    });
  }
  return out;
}

/** Synthesized power devices: one VCC + one GND symbol (matches the
 *  static view, which always adds global VDD/GND cells). */
export function powerDevices(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  opts: AnalogLayoutOptions,
): AnalogDevice[] {
  const vdd = opts.vdd ?? "VDD";
  const gnd = opts.gnd ?? "GND";
  const used = new Set<number>();
  for (const d of devices) for (const t of d.terminals) if (t.netId >= 0) used.add(t.netId);
  const out: AnalogDevice[] = [];
  for (const [netId, name] of namedNets) {
    if (!used.has(netId)) continue;
    if (name === vdd || name === gnd) {
      out.push({
        id: name,
        kind: "power",
        instanceName: name,
        layer: "metal1",
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        terminals: [{ name: "PLUS", netId }],
      } as unknown as AnalogDevice);
    }
  }
  return out;
}

/** Nets that are die-level io (named, not power). */
export function ioNetList(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  opts: AnalogLayoutOptions,
): Array<{ netId: number; name: string }> {
  if (!opts.showIo) return [];
  const vdd = opts.vdd ?? "VDD";
  const gnd = opts.gnd ?? "GND";
  const used = new Set<number>();
  for (const d of devices) for (const t of d.terminals) if (t.netId >= 0) used.add(t.netId);
  const out: Array<{ netId: number; name: string }> = [];
  for (const [netId, name] of namedNets) {
    if (!used.has(netId)) continue;
    if (name === vdd || name === gnd) continue;
    if (opts.ioNetIds && !opts.ioNetIds.has(netId)) continue;
    out.push({ netId, name });
  }
  return out;
}

/** Terminal→net membership index used by drag re-routing. */
export function buildNetIndex(
  devices: AnalogDevice[],
  opts: AnalogLayoutOptions,
  extraDevices: AnalogDevice[] = [],
): Map<number, Array<{ deviceKey: string; terminal: string }>> {
  const index = new Map<number, Array<{ deviceKey: string; terminal: string }>>();
  const all = [...devices, ...extraDevices];
  for (const d of all) {
    const key = deviceKey(d);
    for (const term of d.terminals) {
      if (term.netId < 0) continue;
      let list = index.get(term.netId);
      if (!list) index.set(term.netId, (list = []));
      list.push({ deviceKey: key, terminal: term.name });
    }
  }
  return index;
}

/** Driver terminal of a net: prefer a port-directions "output" pin
 *  (NMOS S, PMOS D, BJT E), else the first terminal. Mirrors the
 *  port_directions netlist2svgFormat assigns for the static view. */
function driverOf(netTerminals: Array<{ deviceKey: string; device: AnalogDevice; terminal: string }>): string {
  for (const t of netTerminals) {
    const kind = t.device.kind;
    if (kind === "mos") {
      const isP = mosType(t.device) === "pmos";
      if (t.terminal === (isP ? "D" : "S")) return t.deviceKey;
    } else if (kind === "bjt_npn" || kind === "bjt_pnp") {
      if (t.terminal === "E") return t.deviceKey;
    } else if (kind === "jfet_n" || kind === "jfet_p") {
      if (t.terminal === "S") return t.deviceKey;
    }
  }
  return netTerminals[0]?.deviceKey ?? "";
}

// ── ELK graph build + run ────────────────────────────────────────

const POWER_TEMPLATE_SIZE = { vcc: { w: 20, h: 30 }, gnd: { w: 20, h: 30 }, io: { w: 30, h: 20 } };

/** Run the full ELK-with-ports layout (async).
 *
 * Settings degradation: ELK layered with BRANDES_KOEPF + heavy
 * post-compaction is known to throw on some large graphs (same as the
 * static view). Instead of dropping straight to grid we step the
 * requested settings down — compaction requested→0, then strategy
 * BRANDES_KOEPF→INTERACTIVE→SIMPLE — and only fall back to grid if
 * everything fails. The settings actually applied are reported in
 * `result.applied` so the UI can show the degradation. */
export async function runInteractiveLayout(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  table: SymbolTable,
  opts: AnalogLayoutOptions = {},
): Promise<InteractiveLayoutResult> {
  const strategy = opts.strategy ?? "BRANDES_KOEPF";
  const direction = opts.direction ?? "DOWN";
  const requestedCompaction = opts.compaction ?? 2;
  const strategyOrder: LayoutStrategy[] =
    strategy === "BRANDES_KOEPF" ? ["BRANDES_KOEPF", "INTERACTIVE", "SIMPLE"]
    : strategy === "INTERACTIVE" ? ["INTERACTIVE", "SIMPLE"]
    : ["SIMPLE"];

  for (let si = 0; si < strategyOrder.length; si++) {
    const s = strategyOrder[si];
    // Later (fallback) strategies start from a moderate compaction so a
    // catastrophic graph doesn't burn through every level again.
    const startCompaction = si === 0 ? requestedCompaction : Math.min(requestedCompaction, 2);
    for (let c = startCompaction; c >= 0; c--) {
      try {
        const res = await elkInteractiveLayout(devices, namedNets, table, {
          ...opts,
          strategy: s,
          direction,
          compaction: c as CompactionLevel,
        });
        res.applied = { strategy: s, direction, compaction: c as CompactionLevel };
        return res;
      } catch (err) {
        console.warn(
          `[interactiveAnalogLayout] ELK failed (strategy=${s}, compaction=${c}, direction=${direction}), degrading:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  console.warn("[interactiveAnalogLayout] all ELK settings failed — grid fallback");
  return gridFallback(devices, namedNets, table, opts);
}

async function elkInteractiveLayout(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  table: SymbolTable,
  opts: AnalogLayoutOptions,
): Promise<InteractiveLayoutResult> {
  const powers = powerDevices(devices, namedNets, opts);
  const ioNets = ioNetList(devices, namedNets, opts);
  const all = [...devices, ...powers];

  // Terminal membership: netId → [{deviceKey, terminal}]
  const netMembers = new Map<number, Array<{ deviceKey: string; device: AnalogDevice; terminal: string }>>();
  const portsByKey = new Map<string, NodePortSpec[]>();
  const sizes: Record<string, { w: number; h: number }> = {};

  for (const d of all) {
    const key = deviceKey(d);
    const template = templateForDevice(table, d);
    const isGnd = d.instanceName === (opts.gnd ?? "GND");
    const size =
      (d.kind as string) === "power"
        ? isGnd ? POWER_TEMPLATE_SIZE.gnd : POWER_TEMPLATE_SIZE.vcc
        : template
          ? { w: template.width, h: template.height }
          : { w: 30, h: 40 };
    sizes[key] = size;

    const ports: NodePortSpec[] = [];
    if ((d.kind as string) === "power") {
      for (const term of d.terminals) {
        if (term.netId < 0) continue;
        // vcc pin A at (10,30) bottom; gnd pin A at (10,-15) top of body.
        ports.push({
          pid: "A",
          x: 10,
          y: isGnd ? -15 : 30,
          side: isGnd ? "NORTH" : "SOUTH",
          netId: term.netId,
        });
      }
    } else {
      ports.push(...devicePorts(d, table));
    }
    portsByKey.set(key, ports);
    for (const term of d.terminals) {
      if (term.netId < 0) continue;
      let list = netMembers.get(term.netId);
      if (!list) netMembers.set(term.netId, (list = []));
      list.push({ deviceKey: key, device: d, terminal: term.name });
    }
  }

  // IO driver nodes (inputExt, one port EAST)
  for (const io of ioNets) {
    const key = `io:${io.netId}`;
    sizes[key] = POWER_TEMPLATE_SIZE.io;
    portsByKey.set(key, [{ pid: "Y", x: 30, y: 10, side: "EAST", netId: io.netId }]);
    netMembers.set(io.netId, [
      ...(netMembers.get(io.netId) ?? []),
      { deviceKey: key, device: { kind: "__io" } as unknown as AnalogDevice, terminal: "Y" },
    ]);
  }

  // ELK children — locked devices (excludeKeys) are NOT laid out by
  // ELK (elkjs cannot pin individual nodes); they stay at stored
  // positions and their nets re-route locally.
  type ElkPort = { id: string; x: number; y: number; width: number; height: number; layoutOptions: Record<string, string> };
  type ElkNode = { id: string; width: number; height: number; ports: ElkPort[]; layoutOptions: Record<string, string> };
  const children: ElkNode[] = [];
  for (const d of all) {
    const key = deviceKey(d);
    if (opts.excludeKeys?.has(key)) continue;
    const size = sizes[key];
    children.push({
      id: key,
      width: size.w,
      height: size.h,
      ports: (portsByKey.get(key) ?? []).map((p, i) => ({
        id: `${key}:${p.pid}:${i}`,
        x: p.x,
        y: p.y,
        width: 0,
        height: 0,
        layoutOptions: { "port.side": p.side },
      })),
      layoutOptions: { portConstraints: "FIXED_POS" },
    });
  }
  for (const io of ioNets) {
    const key = `io:${io.netId}`;
    children.push({
      id: key,
      width: sizes[key].w,
      height: sizes[key].h,
      ports: [{
        id: `${key}:Y:0`,
        x: 30,
        y: 10,
        width: 0,
        height: 0,
        layoutOptions: { "port.side": "EAST" },
      }],
      layoutOptions: {
        portConstraints: "FIXED_POS",
        "layered.layering.layerConstraint": "FIRST",
      },
    });
  }

  // Binary edges per (driver, consumer) — hyperedge split (netlist.tsx
  // convention; ELK layered+ORTHOGONAL rejects multi-source/multi-target).
  type ElkEdge = { id: string; sources: string[]; targets: string[] };
  const edges: ElkEdge[] = [];
  const edgeNetId = new Map<string, number>();
  let edgeCounter = 0;
  for (const [netId, members] of netMembers) {
    const portOf = (deviceKey: string, netId: number): string | undefined => {
      const spec = (portsByKey.get(deviceKey) ?? []).find((p) => p.netId === netId);
      return spec ? `${deviceKey}:${spec.pid}:${(portsByKey.get(deviceKey) ?? []).indexOf(spec)}` : undefined;
    };
    const isIoNet = ioNets.some((io) => io.netId === netId);
    const powerDev = powers.find((p) =>
      (p.terminals ?? []).some((t) => t.netId === netId),
    );
    let driverKey: string | undefined;
    if (powerDev) driverKey = deviceKey(powerDev);
    else if (isIoNet) driverKey = `io:${netId}`;
    else driverKey = driverOf(members) || undefined;
    // Driver locked (excluded from ELK) or portless (skin has no anchor
    // for that terminal) — fall back to another member that CAN hold an
    // edge. Dropping the driver used to silently drop the WHOLE net's
    // wires until the user dragged one of its devices.
    if (!driverKey || opts.excludeKeys?.has(driverKey) || !portOf(driverKey, netId)) {
      const alt = members.find((m) =>
        m.deviceKey !== driverKey &&
        !opts.excludeKeys?.has(m.deviceKey) &&
        !!portOf(m.deviceKey, netId),
      );
      driverKey = alt ? alt.deviceKey : undefined;
    }
    if (!driverKey) continue; // nothing routable in the ELK graph
    const srcPort = portOf(driverKey, netId);
    if (!srcPort) continue;
    for (const m of members) {
      if (m.deviceKey === driverKey) continue;
      if (opts.excludeKeys?.has(m.deviceKey)) continue; // locked: no ELK edges
      const dstPort = portOf(m.deviceKey, netId);
      if (!dstPort) continue;
      const id = `e${edgeCounter++}`;
      edges.push({ id, sources: [srcPort], targets: [dstPort] });
      edgeNetId.set(id, netId);
    }
  }

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      // Same three user-facing settings the static netlist2svg path
      // exposes (see netlist2svgSkin.buildSkin): placement strategy,
      // direction, post-compaction. Digit compaction values are what
      // the static skin passes; verified accepted by elkjs 0.11.1.
      "elk.direction": opts.direction ?? "DOWN",
      "elk.layered.nodePlacement.strategy": opts.strategy ?? "BRANDES_KOEPF",
      "elk.layered.compaction.postCompaction.strategy": String(opts.compaction ?? 2),
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "36",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.edgeNode": "12",
      "elk.spacing.edgeEdge": "10",
      "elk.padding": "[top=16,left=16,bottom=40,right=16]",
    },
    children,
    edges,
  };

  const result = await elk.layout(graph);

  const positions: Record<string, Point> = {};
  for (const child of result.children ?? []) {
    positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
  }

  // Group routed sections per net → polylines → junctions.
  const byNet = new Map<number, PlacedEdge[]>();
  for (const e of result.edges ?? []) {
    const netId = edgeNetId.get(e.id);
    if (netId == null) continue;
    const polylines = (e.sections ?? []).map((sec: any) => {
      const pts: Point[] = [{ x: sec.startPoint.x, y: sec.startPoint.y }];
      for (const b of sec.bendPoints ?? []) pts.push({ x: b.x, y: b.y });
      pts.push({ x: sec.endPoint.x, y: sec.endPoint.y });
      return pts;
    });
    let list = byNet.get(netId);
    if (!list) byNet.set(netId, (list = []));
    list.push({ id: e.id, polylines, netId });
  }
  const wires = new Map<number, WireData>();
  for (const [netId, placed] of byNet) {
    wires.set(netId, {
      polylines: placed.flatMap((p) => p.polylines),
      junctions: computeJunctions(placed).map((j) => ({ x: j.x, y: j.y })),
    });
  }

  return {
    positions,
    sizes,
    wires,
    bbox: { width: result.width ?? 0, height: result.height ?? 0 },
    usedFallback: false,
  };
}

// ── Grid fallback ────────────────────────────────────────────────

/** Deterministic grid placement — used when ELK fails. Wires are then
 *  routed locally (motion keeps working). */
export function gridFallback(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  table: SymbolTable,
  opts: AnalogLayoutOptions = {},
): InteractiveLayoutResult {
  const powers = powerDevices(devices, namedNets, opts);
  const all = [...powers, ...devices];
  const positions: Record<string, Point> = {};
  const sizes: Record<string, { w: number; h: number }> = {};
  let maxW = 40;
  let maxH = 60;
  for (const d of all) {
    const t = templateForDevice(table, d);
    if (t) {
      maxW = Math.max(maxW, t.width);
      maxH = Math.max(maxH, t.height);
    }
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(all.length)));
  const cw = maxW + 48;
  const ch = maxH + 56;
  all.forEach((d, i) => {
    positions[deviceKey(d)] = {
      x: 16 + (i % cols) * cw,
      y: 16 + Math.floor(i / cols) * ch,
    };
    const t = templateForDevice(table, d);
    sizes[deviceKey(d)] = (d.kind as string) === "power"
      ? (d.instanceName === (opts.gnd ?? "GND") ? POWER_TEMPLATE_SIZE.gnd : POWER_TEMPLATE_SIZE.vcc)
      : t ? { w: t.width, h: t.height } : { w: 30, h: 40 };
  });

  // Local routing for all nets.
  const wires = new Map<number, WireData>();
  const netIndex = buildNetIndex(devices, opts, powers);
  const obstacles: Obstacle[] = Object.entries(positions).map(([key, p]) => ({
    x: p.x, y: p.y, w: sizes[key]?.w ?? 30, h: sizes[key]?.h ?? 40,
  }));
  const keySet = new Set(Object.keys(positions));
  const lookups = new Map<string, SymbolPinLookup | undefined>();
  for (const d of all) lookups.set(deviceKey(d), portsForDeviceStatic(devices, powers, table, opts, deviceKey(d)));
  for (const [netId, members] of netIndex) {
    if (!members.some((m) => keySet.has(m.deviceKey))) continue;
    const anchors = members
      .filter((m) => keySet.has(m.deviceKey))
      .map((m) => anchorWorld(m.deviceKey, positions, lookups.get(m.deviceKey), m.terminal))
      .filter((p): p is Point => !!p);
    if (anchors.length === 0) continue;
    wires.set(netId, routeNetLocal(anchors, obstacles));
  }

  // bbox
  let maxX = 0, maxY = 0;
  for (const [key, p] of Object.entries(positions)) {
    maxX = Math.max(maxX, p.x + (sizes[key]?.w ?? 30));
    maxY = Math.max(maxY, p.y + (sizes[key]?.h ?? 40));
  }
  return { positions, sizes, wires, bbox: { width: maxX + 16, height: maxY + 16 }, usedFallback: true };
}

/** Skin pin lookup by terminal name for any (real/power) device key. */
function portsForDeviceStatic(
  devices: AnalogDevice[],
  powers: AnalogDevice[],
  table: SymbolTable,
  opts: AnalogLayoutOptions,
  key: string,
): SymbolPinLookup | undefined {
  return terminalPinLookup(devices, powers, table, opts).get(key);
}

type SymbolPinLookup = (terminal: string) => { dx: number; dy: number } | undefined;

/** Per-device-key pin lookup table for anchor math in the canvas
 *  (drag-time re-routing). Power symbols use hardcoded anchors. */
export function terminalPinLookup(
  devices: AnalogDevice[],
  powers: AnalogDevice[],
  table: SymbolTable,
  opts: AnalogLayoutOptions,
): Map<string, SymbolPinLookup | undefined> {
  const map = new Map<string, SymbolPinLookup | undefined>();
  for (const d of devices) {
    const template = templateForDevice(table, d);
    map.set(deviceKey(d), template
      ? (terminal: string) => pinForTerminal(d, terminal, template)
      : undefined);
  }
  for (const p of powers) {
    const isGnd = p.instanceName === (opts.gnd ?? "GND");
    map.set(deviceKey(p), (terminal: string) =>
      terminal === "PLUS" ? { dx: 10, dy: isGnd ? -15 : 30 } : undefined);
  }
  return map;
}

/** World-space anchor of a terminal pin given device positions. */
export function anchorWorld(
  deviceKey: string,
  positions: Record<string, Point>,
  lookup: SymbolPinLookup | undefined,
  terminal: string,
): Point | undefined {
  const pos = positions[deviceKey];
  const pin = lookup?.(terminal);
  if (!pos || !pin) return undefined;
  return { x: pos.x + pin.dx, y: pos.y + pin.dy };
}

// ── Local drag-time router ───────────────────────────────────────

const OBSTACLE_MARGIN = 4;
const OVERLAP_PENALTY = 60;
const BEND_PENALTY = 2;

/** Segment length inside an expanded rect (0 if no overlap). */
function segmentRectOverlap(a: Point, b: Point, r: Obstacle): number {
  const rx0 = r.x - OBSTACLE_MARGIN, ry0 = r.y - OBSTACLE_MARGIN;
  const rx1 = r.x + r.w + OBSTACLE_MARGIN, ry1 = r.y + r.h + OBSTACLE_MARGIN;
  if (Math.abs(a.y - b.y) < 0.001) {
    // horizontal
    if (a.y <= ry0 || a.y >= ry1) return 0;
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    return Math.max(0, Math.min(hi, rx1) - Math.max(lo, rx0));
  }
  if (Math.abs(a.x - b.x) < 0.001) {
    // vertical
    if (a.x <= rx0 || a.x >= rx1) return 0;
    const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
    return Math.max(0, Math.min(hi, ry1) - Math.max(lo, ry0));
  }
  return 0;
}

function scorePath(path: Point[], obstacles: Obstacle[]): number {
  let score = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    score += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    for (const o of obstacles) score += OVERLAP_PENALTY * segmentRectOverlap(a, b, o);
  }
  score += BEND_PENALTY * Math.max(0, path.length - 2);
  return score;
}

/** Orthogonal candidate paths between two anchors: L-shapes and
 *  Z-shapes with a few deterministic midline offsets. */
function candidatePaths(a: Point, b: Point): Point[][] {
  const cands: Point[][] = [
    [a, { x: b.x, y: a.y }, b], // H-first L
    [a, { x: a.x, y: b.y }, b], // V-first L
  ];
  const midX = (a.x + b.x) / 2;
  const spanX = Math.abs(b.x - a.x);
  for (const off of [0, spanX * 0.25, -spanX * 0.25]) {
    const mx = midX + off;
    cands.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]);
  }
  const midY = (a.y + b.y) / 2;
  const spanY = Math.abs(b.y - a.y);
  for (const off of [0, spanY * 0.25, -spanY * 0.25]) {
    const my = midY + off;
    cands.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
  }
  return cands;
}

function bestPath(a: Point, b: Point, obstacles: Obstacle[]): Point[] {
  const cands = candidatePaths(a, b);
  // Obstacle-aware detour rails: when the plain L/Z candidates all cut
  // through a nearby device, offer above/below/left/right corridors.
  // Corridor filter keeps the candidate count bounded during drag.
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  let detours = 0;
  for (const o of obstacles) {
    if (detours >= 8) break;
    if (o.x > x1 + 24 || o.x + o.w < x0 - 24 || o.y > y1 + 24 || o.y + o.h < y0 - 24) continue;
    const m = OBSTACLE_MARGIN + 4;
    cands.push([a, { x: a.x, y: o.y - m }, { x: b.x, y: o.y - m }, b]);
    cands.push([a, { x: a.x, y: o.y + o.h + m }, { x: b.x, y: o.y + o.h + m }, b]);
    cands.push([a, { x: o.x - m, y: a.y }, { x: o.x - m, y: b.y }, b]);
    cands.push([a, { x: o.x + o.w + m, y: a.y }, { x: o.x + o.w + m, y: b.y }, b]);
    detours++;
  }
  let best = cands[0];
  let bestScore = Infinity;
  for (const c of cands) {
    const s = scorePath(c, obstacles);
    if (s < bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

function median(values: number[]): number {
  const v = [...values].sort((x, y) => x - y);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Re-route ONE net locally (drag-time). Two terminals → best L/Z
 * candidate; N terminals → median hub + L/Z spokes, junction at hub.
 * Deterministic; never runs ELK.
 */
export function routeNetLocal(anchors: Point[], obstacles: Obstacle[]): WireData {
  const pts = anchors.filter(
    (p, i, arr) => arr.findIndex((q) => Math.abs(q.x - p.x) < 0.5 && Math.abs(q.y - p.y) < 0.5) === i,
  );
  if (pts.length === 0) return { polylines: [], junctions: [] };
  if (pts.length === 1) return { polylines: [], junctions: [] };
  if (pts.length === 2) {
    return { polylines: [bestPath(pts[0], pts[1], obstacles)], junctions: [] };
  }
  const hub = { x: median(pts.map((p) => p.x)), y: median(pts.map((p) => p.y)) };
  const polylines = pts.map((p) => bestPath(p, hub, obstacles));
  return { polylines, junctions: [hub] };
}
