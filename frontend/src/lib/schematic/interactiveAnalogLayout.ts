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
  /** Gap between adjacent devices (elk.spacing.nodeNode). Static default 35. */
  nodeNode?: number;
  /** Gap between device layers (elk.layered.spacing.nodeNodeBetweenLayers).
   *  Static default 5. */
  betweenLayers?: number;
  /** Gap between wire and wire (elk.spacing.edgeEdge). Undefined → ELK default. */
  edgeEdge?: number;
  /** Gap between wire and device (elk.spacing.edgeNode). Undefined → ELK default. */
  edgeNode?: number;
  /** Merge parallel edges into a single routed wire (rail/bus look). */
  mergeEdges?: boolean;
  /** Prefer straight edges over detours (elk.layered.nodePlacement.favorStraightEdges). */
  favorStraightEdges?: boolean;
}

/** Read an optional spacing option, falling back to a per-key default. */
function spacingOf(v: number | undefined, dflt: number): string {
  return v == null ? String(dflt) : String(v);
}

/** Defaults kept aligned with the static skin's <s:layoutEngine>. */
export const INTERACTIVE_ELK_DEFAULTS = {
  nodeNode: 35,
  betweenLayers: 5,
  edgeEdge: 10,
  edgeNode: 12,
} as const;

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

/**
 * Port role of a terminal, mirroring the STATIC netlist2svg convention
 * (derived from the vendored bundle's classification):
 *
 *   - skin pin `s:position` top → input, bottom → output;
 *   - left/right pins → the explicit `port_directions` netlist2svgFormat
 *     assigns (NMOS D input / S output; PMOS S input / D output; BJT
 *     E output; JFET S output; MOS G/B and BJT B input);
 *   - power: vcc (A bottom) is the driver of its rail, gnd (A top) is a
 *     SINK (the rail is driven by e.g. NMOS S terminals);
 *   - io pseudo-nodes are inputExt = input.
 *
 * Undefined role → device is neither a driver nor consumer in ELK edge
 * terms, but still participates in the final routing (bridge/fallback).
 */
export type PortRole = "input" | "output" | undefined;

function roleFromPosition(position: string, d: AnalogDevice): PortRole {
  // The STATIC bundle classifies pins by skin position first:
  //   top → input, bottom → output
  // and only left/right pins go through explicit port_directions
  // (netlist2svgFormat: MOS G/B input, BJT B input, JFET G input;
  //  passive/diode left → input, right → output as ELK default).
  if (position === "top") return "input";
  if (position === "bottom") return "output";
  const kind = d.kind;
  if (kind === "mos") return "input"; // G/B are always inputs
  if (kind === "bjt_npn" || kind === "bjt_pnp") return "input"; // B left
  if (kind === "jfet_n" || kind === "jfet_p") return "input"; // G left
  // passives/diodes/generic with left/right pins: ELK position default
  return position === "left" ? "input" : "output";
}

/** Driver terminal of a net: prefer a port-directions "output" pin
 *  (NMOS S, PMOS D, BJT E), else the first terminal. Mirrors the
 *  port_directions netlist2svgFormat assigns for the static view.
 *  Kept for fallback path (bridge routing) only; edge building uses
 *  `portRole` (static multi-driver convention). */
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

/** Fan-out guard for power rails / bus nets: a net with N drivers × M
 *  consumers would otherwise issue N×M ELK edges and both explode the
 *  graph and risk a layered-crash. Above this product we collapse to a
 *  single (hub) driver → all consumers, matching how a rail is drawn. */
const MAX_EDGES_PER_NET = 48;

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
  //
  // STATIC-convention roles (see roleFromPosition): a net's
  // output-role pins are its drivers, input-role pins its consumers;
  // power vcc is the rail driver, gnd a sink. driver→consumer edges
  // mirror the static view. Guards: driverless → pseudo-driver (first
  // member, as static does); consumerless (all pins output — e.g. a
  // bus pulled by NMOS S only) → star bridge from the first driver;
  // huge fan-out (drivers × consumers > MAX_EDGES_PER_NET) collapses to
  // one hub driver → all consumers so power rails don't explode ELK.
  type ElkEdge = { id: string; sources: string[]; targets: string[] };
  const edges: ElkEdge[] = [];
  const edgeNetId = new Map<string, number>();
  let edgeCounter = 0;
  for (const [netId, members] of netMembers) {
    const portOf = (deviceKey: string, netId: number): string | undefined => {
      const specs = portsByKey.get(deviceKey) ?? [];
      const spec = specs.find((p) => p.netId === netId);
      return spec ? `${deviceKey}:${spec.pid}:${specs.indexOf(spec)}` : undefined;
    };
    const isIoNet = ioNets.some((io) => io.netId === netId);
    const powerDev = powers.find((p) =>
      (p.terminals ?? []).some((t) => t.netId === netId),
    );

    // Role of each routable member (has a port, not locked).
    const routable = members.filter((m) => !opts.excludeKeys?.has(m.deviceKey) && !!portOf(m.deviceKey, netId));
    if (routable.length < 2) continue; // nothing to wire

    const roleOf = (m: { deviceKey: string; device: AnalogDevice; terminal: string }): PortRole => {
      if (powerDev && m.deviceKey === deviceKey(powerDev)) {
        // power roles are fixed by rail kind (vcc driver, gnd sink)
        return (powerDev.instanceName ?? "") === (opts.gnd ?? "GND") ? "input" : "output";
      }
      if (isIoNet && m.deviceKey === `io:${netId}`) return "input"; // inputExt
      // Direct skin pin position (no ELK-side round-trip needed):
      const template = templateForDevice(table, m.device);
      const pin = template ? pinForTerminal(m.device, m.terminal, template) : undefined;
      return roleFromPosition(pin?.position ?? "", m.device);
    };

    let drivers = routable.filter((m) => roleOf(m) === "output");
    let consumers = routable.filter((m) => roleOf(m) === "input");

    // Consumerless net (everything is an output — e.g. NMOS S×N + vcc):
    // star-bridge from the first driver, so the wires still draw.
    if (consumers.length === 0 && drivers.length > 0) {
      const hub = drivers[0];
      consumers = drivers.slice(1);
      drivers = [hub];
    }
    // Driverless net (e.g. VDD rail when the vcc node was dropped/locked):
    // pseudo-driver = first member (static driverless-net convention).
    if (drivers.length === 0 && consumers.length > 0) {
      drivers = [consumers[0]];
      consumers = consumers.slice(1);
    }
    if (drivers.length === 0 || consumers.length === 0) continue;

    // Fan-out guard: collapse to a single hub driver when the full
    // product would blow up the ELK graph on a power/bus rail.
    if (drivers.length * consumers.length > MAX_EDGES_PER_NET) {
      drivers = [drivers[0]];
    }

    const srcPort = portOf(drivers[0].deviceKey, netId);
    if (!srcPort) continue;
    for (const driver of drivers) {
      const dsrc = portOf(driver.deviceKey, netId);
      if (!dsrc) continue;
      for (const c of consumers) {
        const dstPort = portOf(c.deviceKey, netId);
        if (!dstPort) continue;
        const id = `e${edgeCounter++}`;
        edges.push({ id, sources: [dsrc], targets: [dstPort] });
        edgeNetId.set(id, netId);
      }
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
      // Static parity: the vendored netlist2svg.bundle.js forwards ONLY
      // betweenLayers + nodeNode from the skin's layoutEngine; everything
      // else is ELK defaults. Extra spacings/behavior are optional toggles
      // (Netlist Settings) to fine-tune the layout.
      "elk.spacing.nodeNode": spacingOf(opts.nodeNode, INTERACTIVE_ELK_DEFAULTS.nodeNode),
      "elk.layered.spacing.nodeNodeBetweenLayers": spacingOf(opts.betweenLayers, INTERACTIVE_ELK_DEFAULTS.betweenLayers),
      ...(opts.edgeEdge != null ? { "elk.spacing.edgeEdge": String(opts.edgeEdge) } : {}),
      ...(opts.edgeNode != null ? { "elk.spacing.edgeNode": String(opts.edgeNode) } : {}),
      ...(opts.mergeEdges ? { "elk.layered.mergeEdges": "true" } : {}),
      ...(opts.favorStraightEdges ? { "elk.layered.nodePlacement.favorStraightEdges": "true" } : {}),
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
  const obstacles: Obstacle[] = Object.entries(positions).map(([key, p]) =>
    deviceObstacle(p, sizes[key] ?? { w: 30, h: 40 }),
  );
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

/**
 * Transform a pin (local dx/dy within the symbol box) under a device
 * orientation. Rotation is clockwise about the symbol center, mirror is
 * applied after rotation along the box axes.
 *
 * RETURN units: the SAME local frame the caller uses for `pin.dx/dy` —
 * i.e. top-left origin, y grows down. For rot 90/270 the caller should
 * also swap the node's width/height (see `orientedSize`).
 */
export interface DeviceOrientationLike {
  rot: 0 | 90 | 180 | 270;
  flip: "none" | "h" | "v";
}

export function transformPin(
  pin: { dx: number; dy: number },
  w: number,
  h: number,
  orient?: DeviceOrientationLike,
): { dx: number; dy: number } {
  if (!orient || (orient.rot === 0 && orient.flip === "none")) return { dx: pin.dx, dy: pin.dy };
  // normalize to center-relative coords (before rotation)
  const cx = w / 2;
  const cy = h / 2;
  let x = pin.dx - cx;
  let y = pin.dy - cy;
  // Rotate along the SVG rotate(θ) convention (positive θ = clockwise in
  // screen coords, y down): matrix x' = cos·x − sin·y, y' = sin·x + cos·y.
  switch (orient.rot) {
    case 90: { const nx = -y; y = x; x = nx; break; }
    case 180: { x = -x; y = -y; break; }
    case 270: { const nx = y; y = -x; x = nx; break; }
    default: break;
  }
  if (orient.flip === "h") { x = -x; }
  if (orient.flip === "v") { y = -y; }
  return { dx: x + cx, dy: y + cy };
}

/** Node size under rotation — 90/270 swap width and height. */
export function orientedSize(
  size: { w: number; h: number },
  orient?: DeviceOrientationLike,
): { w: number; h: number } {
  if (orient && (orient.rot === 90 || orient.rot === 270)) return { w: size.h, h: size.w };
  return size;
}

// ── Local drag-time router ───────────────────────────────────────

const OBSTACLE_MARGIN = 8;
const OVERLAP_PENALTY = 60;
const BEND_PENALTY = 2;

/**
 * Extra padding applied to every device's obstacle box on all sides, so
 * wires keep a clear visual distance from the symbol art (the raw symbol
 * template size only covers the glyph; pins and lead stubs sit on/near the
 * edges). Builders should emit obstacles as
 * `{ x: p.x - PAD, y: p.y - PAD, w: os.w + 2*PAD, h: os.h + 2*PAD }`.
 */
export const WIRE_OBSTACLE_PAD = 5;

/** Build an inflated obstacle box for a device at top-left `p`. */
export function deviceObstacle(
  p: Point,
  size: { w: number; h: number },
  orient?: DeviceOrientationLike,
): Obstacle {
  const os = orientedSize(size, orient);
  return { x: p.x - WIRE_OBSTACLE_PAD, y: p.y - WIRE_OBSTACLE_PAD, w: os.w + 2 * WIRE_OBSTACLE_PAD, h: os.h + 2 * WIRE_OBSTACLE_PAD };
}

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
