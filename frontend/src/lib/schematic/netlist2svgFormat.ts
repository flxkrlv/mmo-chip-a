/**
 * netlist2svgFormat.ts — Convert mmo-chip analog devices to Yosys JSON
 * format consumable by netlist2svg (netlist2svg NPM package).
 *
 * netlist2svg expects a Yosys-compatible netlist:
 *
 *   {
 *     modules: {
 *       "<name>": {
 *         ports: { ... },
 *         cells: { ... }
 *       }
 *     }
 *   }
 *
 * Each cell has:
 *   - type: one of the analog-skin symbols (r_v, c_v, q_npn, d_h, vcc, gnd, …)
 *   - connections: { <port>: [bitId, …] }
 *   - port_directions: { <port>: "input"|"output" }  (optional for skin-defined cells)
 *   - attributes: { value: "…", ref: "…" }
 *
 * We add custom types for our MOS devices:
 *   - "nmos_v" → NMOS (vertical, D/G/S/B ports)
 *   - "pmos_v" → PMOS (vertical, D/G/S/B ports)
 */

import type {
  AnalogDevice,
  DeviceGeometryMOS,
  DeviceGeometryResistor,
  DeviceGeometryCapacitor,
} from "shared";

// ── Yosys JSON types ─────────────────────────────────────────────

interface YosysPort {
  direction: "input" | "output";
  bits: number[];
}

interface YosysCell {
  type: string;
  port_directions?: Record<string, string>;
  connections: Record<string, number[]>;
  parameters?: Record<string, number>;
  attributes?: Record<string, string>;
}

interface YosysModule {
  ports: Record<string, YosysPort>;
  cells: Record<string, YosysCell>;
}

interface YosysNetlist {
  modules: Record<string, YosysModule>;
}

// ── Terminal-to-port mapping per device kind ─────────────────────

const DEVICE_PORT_MAP: Record<string, Record<string, string>> = {
  mos:    { D: "D", G: "G", S: "S", B: "B" },
  bjt_npn: { C: "C", B: "B", E: "E", S: "S" },
  bjt_pnp: { C: "C", B: "B", E: "E", S: "S" },
  jfet_n:  { D: "D", G: "G", S: "S" },
  jfet_p:  { D: "D", G: "G", S: "S" },
  resistor:  { PLUS: "A", MINUS: "B" },
  capacitor: { PLUS: "A", MINUS: "B" },
  diode:   { PLUS: "+", MINUS: "-" },
  zener:   { PLUS: "+", MINUS: "-" },
  schottky: { PLUS: "+", MINUS: "-" },
  inductor: { PLUS: "A", MINUS: "B" },
};

// ── Cell type per device kind (maps to netlist2svg skin types) ──

function cellTypeForDevice(d: AnalogDevice): string {
  switch (d.kind) {
    case "mos": {
      const g = d.geometry as DeviceGeometryMOS;
      return g.mosType === "pmos" ? "pmos_v" : "nmos_v";
    }
    case "bjt_npn": return "q_npn";
    case "bjt_pnp": return "q_pnp";
    case "jfet_n":
    case "jfet_p":  return "generic"; // JFET not in skin yet
    case "resistor":  return "r_v";
    case "capacitor": return "c_v";
    case "diode":     return "d_v";
    case "zener":     return "d_v";   // no zener in skin — use diode for now
    case "schottky":  return "d_sk_v";
    case "inductor":  return "l_v";
    default:          return "generic";
  }
}

// ── Value string for passives ────────────────────────────────────

function valueString(d: AnalogDevice): string | undefined {
  switch (d.kind) {
    case "resistor": {
      const g = d.geometry as DeviceGeometryResistor;
      if (g.resistance_ohms == null) return undefined;
      return formatValue(g.resistance_ohms, "Ω");
    }
    case "capacitor": {
      const g = d.geometry as DeviceGeometryCapacitor;
      if (g.capacitance_fF == null) return undefined;
      return formatCapacitance(g.capacitance_fF);
    }
    case "inductor":
      return undefined;
    default:
      return undefined;
  }
}

function formatValue(val: number, unit: string): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M${unit}`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k${unit}`;
  if (val >= 1) return `${val.toFixed(1)}${unit}`;
  if (val >= 0.001) return `${(val * 1_000).toFixed(1)}m${unit}`;
  return `${(val * 1_000_000).toFixed(0)}u${unit}`;
}

function formatCapacitance(fF: number): string {
  if (fF >= 1_000_000) return `${(fF / 1_000_000).toFixed(1)}uF`;
  if (fF >= 1_000) return `${(fF / 1_000).toFixed(1)}nF`;
  return `${fF.toFixed(0)}pF`;
}

// ── W/L string for MOS (multi-line vertical format) ─────────────
// Renders as:
//   PMOS
//   W=1.23 um
//   L=0.45 um
// Requires .valuelabel CSS class with white-space:pre in the skin.

function mosAttributes(d: AnalogDevice): Record<string, string> | undefined {
  if (d.kind !== "mos") return undefined;
  const g = d.geometry as DeviceGeometryMOS;
  const lines: string[] = [];
  lines.push(g.mosType === "pmos" ? "PMOS" : "NMOS");
  if (g.W_um) lines.push(`W=${g.W_um.toFixed(2)} um`);
  if (g.L_um) lines.push(`L=${g.L_um.toFixed(2)} um`);
  if (g.multiplier && g.multiplier > 1) lines.push(`M=${g.multiplier}`);
  return { value: lines.join("\n") };
}

// ── Build net ID mapping ────────────────────────────────────────
// netlist2svg uses integer "bit IDs" for connections.
// We assign sequential IDs to each unique net.

function buildNetIdMap(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
): {
  /** netId → netlist2svg bit ID */
  netToBitId: Map<number, number>;
  /** bit ID → human-readable net name */
  bitIdToName: Map<number, string>;
  maxBitId: number;
} {
  // Collect all unique netIds used by devices
  const allNetIds = new Set<number>();
  for (const d of devices) {
    for (const t of d.terminals) {
      if (t.netId >= 0) allNetIds.add(t.netId);
    }
  }

  const netToBitId = new Map<number, number>();
  const bitIdToName = new Map<number, string>();
  let nextBitId = 2; // start from 2 (reserve 0/1 for constants if needed)

  for (const netId of allNetIds) {
    const bitId = nextBitId++;
    netToBitId.set(netId, bitId);
    const name = namedNets.get(netId);
    if (name) bitIdToName.set(bitId, name);
  }

  return { netToBitId, bitIdToName, maxBitId: nextBitId - 1 };
}

// ── Terminal → connection array ─────────────────────────────────

function terminalConnections(
  d: AnalogDevice,
  portMap: Record<string, string>,
  netToBitId: Map<number, number>,
): Record<string, number[]> {
  const conns: Record<string, number[]> = {};
  for (const term of d.terminals) {
    const portName = portMap[term.name];
    if (!portName) continue;
    const bitId = netToBitId.get(term.netId);
    if (bitId != null) {
      conns[portName] = [bitId];
    }
  }
  return conns;
}

// ── Port directions for cells that need them ────────────────────

function portDirections(d: AnalogDevice): Record<string, string> | undefined {
  // Skin-defined cells like r_v, c_v, d_v, vcc, gnd don't need directions.
  // Generic cells and MOS do need them for proper port placement.
  if (d.kind === "mos") {
    // NMOS: D top (input), S bottom (output); PMOS: S top (input), D bottom (output)
    const g = d.geometry as DeviceGeometryMOS;
    if (g.mosType === "pmos") {
      return { D: "output", G: "input", S: "input", B: "input" };
    }
    return { D: "input", G: "input", S: "output", B: "input" };
  }
  if (d.kind.startsWith("bjt_")) {
    return { C: "input", B: "input", E: "output" };
  }
  if (d.kind.startsWith("jfet_")) {
    return { D: "input", G: "input", S: "output" };
  }
  return undefined;
}

// ── Collect port names per device kind ──────────────────────────

function topLevelPorts(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  netToBitId: Map<number, number>,
  vdd: string,
  gnd: string,
  ioNetIds?: Set<number>,
): Record<string, YosysPort> {
  const ports: Record<string, YosysPort> = {};

  const seenNetIds = new Set<number>();
  for (const d of devices) {
    for (const t of d.terminals) {
      if (t.netId < 0) continue;
      if (seenNetIds.has(t.netId)) continue;
      seenNetIds.add(t.netId);

      // If ioNetIds is provided, only these nets become ports.
      // Otherwise ALL named nets become ports (can overwhelm ELK).
      if (ioNetIds && !ioNetIds.has(t.netId)) continue;

      const netName = namedNets.get(t.netId);
      if (!netName) continue;
      if (netName === vdd || netName === gnd) continue;

      const bitId = netToBitId.get(t.netId);
      if (bitId == null) continue;

      ports[netName] = {
        direction: "input",
        bits: [bitId],
      };
    }
  }

  return ports;
}

// ── Main conversion function ────────────────────────────────────

export interface Netlist2SvgConfig {
  vdd: string;
  gnd: string;
  hierarchical: boolean;
  /** Optional: only create Yosys ports for these net IDs (die-level IO pins).
   *  When omitted, ALL named nets become ports — which can overwhelm ELK
   *  and cause "Invalid hitboxes for scanline constraint calculation". */
  ioNetIds?: Set<number>;
}

/**
 * Convert a flat array of analog devices + namedNets into Yosys JSON
 * for netlist2svg rendering.
 */
export function formatDevicesAsNetlist2Svg(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  moduleName: string,
  config?: Partial<Netlist2SvgConfig>,
): YosysNetlist {
  const cfg: Netlist2SvgConfig = {
    vdd: "VDD",
    gnd: "GND",
    hierarchical: true,
    ...config,
  };

  const { netToBitId } = buildNetIdMap(devices, namedNets);

  // Build the cells
  const cells: Record<string, YosysCell> = {};

  for (const d of devices) {
    const instName = d.instanceName ?? `X${d.id.slice(0, 8)}`;
    const type = cellTypeForDevice(d);
    const portMap = DEVICE_PORT_MAP[d.kind] ?? { PLUS: "A", MINUS: "B" };

    const conns = terminalConnections(d, portMap, netToBitId);
    if (Object.keys(conns).length === 0) continue;

    const cellAttrs: Record<string, string> = {};
    const val = valueString(d);
    if (val) cellAttrs.value = val;
    const mosAttrs = mosAttributes(d);
    if (mosAttrs) Object.assign(cellAttrs, mosAttrs);

    // Add instance name as ref attribute
    cellAttrs.ref = instName;

    const cell: YosysCell = {
      type,
      connections: conns,
      attributes: cellAttrs,
    };

    // Port directions for generic/default-skinned cells
    const dirs = portDirections(d);
    if (dirs) cell.port_directions = dirs;

    cells[instName] = cell;
  }

  // ── Add VCC and GND power cells (visible symbols, not ports) ──
  let vddNetId: number | undefined;
  let gndNetId: number | undefined;
  for (const [netId, netName] of namedNets) {
    if (netName === cfg.vdd) vddNetId = netId;
    if (netName === cfg.gnd) gndNetId = netId;
  }
  const vddBitId = vddNetId != null ? netToBitId.get(vddNetId) : undefined;
  const gndBitId = gndNetId != null ? netToBitId.get(gndNetId) : undefined;
  console.log('[n2s] VDD match:', cfg.vdd, '→ netId:', vddNetId, 'bitId:', vddBitId, '| namedNets has it:', vddNetId != null);
  console.log('[n2s] GND match:', cfg.gnd, '→ netId:', gndNetId, 'bitId:', gndBitId, '| namedNets has it:', gndNetId != null);
  if (vddBitId != null) {
    cells["VDD"] = {
      type: "vcc",
      connections: { A: [vddBitId] },
      attributes: { ref: cfg.vdd },
    };
  }
  if (gndBitId != null) {
    cells["GND"] = {
      type: "gnd",
      connections: { A: [gndBitId] },
      attributes: { ref: cfg.gnd },
    };
  }

  // Build top-level ports from IO pins (named nets)
  const ports = topLevelPorts(devices, namedNets, netToBitId, cfg.vdd, cfg.gnd, cfg.ioNetIds);

  // Build the module
  const module: YosysModule = {
    ports,
    cells,
  };

  return {
    modules: {
      [moduleName]: module,
    },
  };
}

/**
 * Generate Yosys JSON for all devices with optional hierarchical
 * partitioning by floorplan region.
 */
export function generateNetlist2SvgViews(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  moduleName: string,
  config?: Partial<Netlist2SvgConfig>,
  floorplanDevices?: Map<string, AnalogDevice[]>,
): {
  flat: YosysNetlist;
  perRegion: Map<string, { name: string; netlist: YosysNetlist }>;
} {
  const flat = formatDevicesAsNetlist2Svg(devices, namedNets, moduleName, config);

  const perRegion = new Map<string, { name: string; netlist: YosysNetlist }>();

  if (floorplanDevices) {
    for (const [regionId, regionDevices] of floorplanDevices) {
      if (regionDevices.length === 0) continue;
      const regionName = regionId.replace(/[^a-zA-Z0-9_]/g, "_");
      const subName = `${moduleName}.${regionName}`;
      const result = formatDevicesAsNetlist2Svg(
        regionDevices, namedNets, subName, config,
      );
      perRegion.set(regionId, { name: regionName, netlist: result });
    }
  }

  return { flat, perRegion };
}

/**
 * Serialize Yosys netlist to JSON string for netlist2svg.
 */
export function serializeNetlist2Svg(netlist: YosysNetlist): string {
  return JSON.stringify(netlist, null, 2);
}
