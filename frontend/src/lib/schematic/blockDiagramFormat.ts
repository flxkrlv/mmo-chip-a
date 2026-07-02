/**
 * blockDiagramFormat.ts — Generate Yosys JSON for functional block diagram.
 *
 * Each floorplan region (subsckt) becomes a sub_odd/sub_even rectangle
 * with ports on its left (inputs) and right (outputs). Cross-region nets
 * become wires between blocks.
 *
 * OPTIONALLY also renders unassigned (top-level) analog devices alongside
 * the blocks — pass them via the `unassignedDevices` parameter.
 *
 * IO pins → inputExt symbols. VDD/GND → global power symbols.
 * Uses netlist2svg skin with layout RIGHT.
 */

import type { AnalogDevice, FloorplanRegion } from "shared";

// ── Yosys JSON types (mirrors netlist2svgFormat) ─────────────────

interface YosysPort {
  direction: "input" | "output";
  bits: number[];
}

interface YosysCell {
  type: string;
  port_directions?: Record<string, string>;
  connections: Record<string, number[]>;
  attributes?: Record<string, string>;
}

interface YosysModule {
  ports: Record<string, YosysPort>;
  cells: Record<string, YosysCell>;
}

interface YosysNetlist {
  modules: Record<string, YosysModule>;
}

// ── Config ───────────────────────────────────────────────────────

export interface BlockDiagramConfig {
  vdd: string;
  gnd: string;
}

// ══════════════════════════════════════════════════════════════════
//  Analog device → skin type mapping (PROVEN names from format.ts)
//  These use ALIAS names (nmos_v, pmos_v, r_v, c_v, etc.) because
//  netlist2svg looks up by alias, not by primary s:type.
// ══════════════════════════════════════════════════════════════════

interface SkinPortMap {
  [terminalName: string]: string;
}

const DEVICE_PORT_MAP: Record<string, SkinPortMap> = {
  mos:       { D: "D", G: "G", S: "S", B: "B" },
  bjt_npn:   { C: "C", B: "B", E: "E", S: "S" },
  bjt_pnp:   { C: "C", B: "B", E: "E", S: "S" },
  jfet_n:    { D: "D", G: "G", S: "S" },
  jfet_p:    { D: "D", G: "G", S: "S" },
  resistor:  { PLUS: "A", MINUS: "B" },
  capacitor: { PLUS: "A", MINUS: "B" },
  diode:     { PLUS: "+", MINUS: "-" },
  zener:     { PLUS: "+", MINUS: "-" },
  schottky:  { PLUS: "+", MINUS: "-" },
  inductor:  { PLUS: "A", MINUS: "B" },
};

/** Returns the netlist2svg alias (e.g. "nmos_v", "r_v") used by format.ts */
function cellTypeForDevice(d: AnalogDevice): string {
  switch (d.kind) {
    case "mos": {
      const mt = (d.geometry as any).mosType;
      return mt === "pmos" ? "pmos_v" : "nmos_v";
    }
    case "bjt_npn": return "q_npn";
    case "bjt_pnp": return "q_pnp";
    case "jfet_n":
    case "jfet_p":  return "generic";
    case "resistor":  return "r_v";
    case "capacitor": return "c_v";
    case "diode":     return "d_v";
    case "zener":     return "d_v";
    case "schottky":  return "d_sk_v";
    case "inductor":  return "l_v";
    default:          return "generic";
  }
}

function portDirectionsForDevice(d: AnalogDevice): Record<string, string> | undefined {
  if (d.kind === "mos") {
    const mt = (d.geometry as any).mosType;
    if (mt === "pmos") return { D: "output", G: "input", S: "input", B: "input" };
    return { D: "input", G: "input", S: "output", B: "input" };
  }
  if (d.kind.startsWith("bjt_")) return { C: "input", B: "input", E: "output" };
  if (d.kind.startsWith("jfet_")) return { D: "input", G: "input", S: "output" };
  return undefined;
}

// ══════════════════════════════════════════════════════════════════
//  Direction inference
// ══════════════════════════════════════════════════════════════════

function isGateTerminal(d: AnalogDevice, termName: string): boolean {
  switch (d.kind) {
    case "mos":        return termName === "G";
    case "bjt_npn":
    case "bjt_pnp":    return termName === "B";
    case "jfet_n":
    case "jfet_p":     return termName === "G";
    default:           return false;
  }
}

function inferPortDirection(
  regionDevices: AnalogDevice[],
  netId: number,
): "input" | "output" | "inout" {
  let hasGate = false;
  let hasPassive = false;
  for (const d of regionDevices) {
    for (const t of d.terminals) {
      if (t.netId !== netId) continue;
      if (isGateTerminal(d, t.name)) hasGate = true;
      else hasPassive = true;
    }
  }
  if (hasGate && hasPassive) return "inout";
  if (hasGate) return "input";
  return "output";
}

// ══════════════════════════════════════════════════════════════════
//  Unified net ID assignment
// ══════════════════════════════════════════════════════════════════

function assignUnifiedNetIds(
  floorplanDevices: Map<string, AnalogDevice[]>,
  unassignedDevices: AnalogDevice[],
  ioNetIds: Set<number>,
  namedNets: Map<number, string>,
  vdd: string,
  gnd: string,
): { netToBitId: Map<number, number>; bitIdToNetName: Map<number, string> } {
  const regionNetSets = new Map<string, Set<number>>();
  for (const [rid, devs] of floorplanDevices) {
    const s = new Set<number>();
    for (const d of devs) {
      for (const t of d.terminals) {
        if (t.netId >= 0) s.add(t.netId);
      }
    }
    regionNetSets.set(rid, s);
  }

  const unassignedNetSet = new Set<number>();
  for (const d of unassignedDevices) {
    for (const t of d.terminals) {
      if (t.netId >= 0) unassignedNetSet.add(t.netId);
    }
  }

  const allNets = new Set<number>();
  for (const n of unassignedNetSet) allNets.add(n);

  const regionIds = [...regionNetSets.keys()];
  for (let i = 0; i < regionIds.length; i++) {
    const setA = regionNetSets.get(regionIds[i])!;
    for (const netId of setA) {
      let shared = false;
      for (let j = i + 1; j < regionIds.length; j++) {
        if (regionNetSets.get(regionIds[j])!.has(netId)) { shared = true; break; }
      }
      if (unassignedNetSet.has(netId)) shared = true;
      if (ioNetIds.has(netId)) shared = true;
      if (shared) allNets.add(netId);
    }
  }

  for (const [netId, name] of namedNets) {
    if (name === vdd || name === gnd) allNets.add(netId);
  }

  const netToBitId = new Map<number, number>();
  const bitIdToNetName = new Map<number, string>();
  let nextId = 10;
  for (const netId of allNets) {
    netToBitId.set(netId, nextId);
    const name = namedNets.get(netId);
    if (name) bitIdToNetName.set(nextId, name);
    nextId++;
  }

  return { netToBitId, bitIdToNetName };
}

// ══════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════

function safePortName(netName: string): string {
  return netName.replace(/[^a-zA-Z0-9_]/g, "_");
}

function buildDeviceConnections(
  d: AnalogDevice,
  netToBitId: Map<number, number>,
): Record<string, number[]> {
  const conns: Record<string, number[]> = {};
  const portMap = DEVICE_PORT_MAP[d.kind] ?? { PLUS: "A", MINUS: "B" };
  for (const t of d.terminals) {
    const portName = portMap[t.name];
    if (!portName) continue;
    const bitId = netToBitId.get(t.netId);
    if (bitId != null) conns[portName] = [bitId];
  }
  return conns;
}

function sortByNetName(
  namedNets: Map<number, string>,
): (a: { netId: number }, b: { netId: number }) => number {
  return (a, b) => {
    const na = namedNets.get(a.netId) ?? `N${a.netId}`;
    const nb = namedNets.get(b.netId) ?? `N${b.netId}`;
    return na.localeCompare(nb);
  };
}

// ── Value string for unassigned devices (mirrors netlist2svgFormat) ──

function unassignedAttrs(d: AnalogDevice): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  switch (d.kind) {
    case "resistor": {
      const g = d.geometry as any;
      const lines: string[] = [];
      const detailLines: string[] = [];
      if (g.resistance_ohms != null) {
        lines.push(formatSimple(g.resistance_ohms) + "Ω");
        detailLines.push(formatSimple(g.resistance_ohms) + "Ω");
      }
      if (g.squares != null && g.squares > 0) detailLines.push(`${g.squares.toFixed(1)} sq`);
      if (g.resistorType) detailLines.push(g.resistorType);
      if (lines.length > 0) result.value = lines.join("\n");
      if (detailLines.length > 0) result._detail = detailLines.join("\n");
      return Object.keys(result).length > 0 ? result : undefined;
    }
    case "mos": {
      const g = d.geometry as any;
      const lines: string[] = [g.mosType === "pmos" ? "PMOS" : "NMOS"];
      if (g.W_um) lines.push(`W=${g.W_um.toFixed(2)} um`);
      if (g.L_um) lines.push(`L=${g.L_um.toFixed(2)} um`);
      if (g.multiplier && g.multiplier > 1) lines.push(`M=${g.multiplier}`);
      const joined = lines.join("\n");
      result.value = joined;
      result._detail = joined;
      return result;
    }
    case "bjt_npn":
    case "bjt_pnp": {
      const g = d.geometry as any;
      const isNpn = g.bjtType === "npn";
      // Schematic: just M
      if (g.multiplier && g.multiplier > 1) result.value = `M=${g.multiplier}`;
      // Tooltip: type + AE(NPN)/PE(PNP) + M
      const details: string[] = [isNpn ? "NPN" : "PNP"];
      if (isNpn && g.AE_um2) details.push(`AE=${g.AE_um2.toFixed(2)} um2`);
      else if (!isNpn && g.PE_um) details.push(`PE=${g.PE_um.toFixed(2)} um`);
      if (g.multiplier && g.multiplier > 1) details.push(`M=${g.multiplier}`);
      if (details.length > 0) result._detail = details.join("\n");
      return Object.keys(result).length > 0 ? result : undefined;
    }
    case "capacitor": {
      const g = d.geometry as any;
      if (g.capacitance_fF == null) return undefined;
      const fF = g.capacitance_fF;
      let cap: string;
      if (fF >= 1_000_000) cap = `${(fF / 1_000_000).toFixed(1)}uF`;
      else if (fF >= 1_000) cap = `${(fF / 1_000).toFixed(1)}nF`;
      else cap = `${fF.toFixed(0)}pF`;
      result.value = cap;
      result._detail = cap;
      return result;
    }
    default:
      return undefined;
  }
}

function formatSimple(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
  if (val >= 1) return `${val.toFixed(1)}`;
  if (val >= 0.001) return `${(val * 1_000).toFixed(1)}m`;
  return `${(val * 1_000_000).toFixed(0)}u`;
}

// ══════════════════════════════════════════════════════════════════
//  Main generator
// ══════════════════════════════════════════════════════════════════

/**
 * Generate a Yosys-format netlist for the functional block diagram.
 *
 * @param floorplanDevices  Devices per region (key = regionId)
 * @param floorplanRegions  Region definitions (for names)
 * @param namedNets         netId → name map
 * @param ioNetIds          set of die-level IO pin net IDs
 * @param moduleName        Yosys module name
 * @param config            VDD/GND names
 * @param unassignedDevices Optional — top-level analog devices drawn
 *                          alongside the region blocks
 */
export function generateBlockDiagram(
  floorplanDevices: Map<string, AnalogDevice[]>,
  floorplanRegions: FloorplanRegion[],
  namedNets: Map<number, string>,
  ioNetIds: Set<number>,
  moduleName: string,
  config?: Partial<BlockDiagramConfig>,
  unassignedDevices?: AnalogDevice[],
): YosysNetlist {
  const cfg: BlockDiagramConfig = { vdd: "VDD", gnd: "GND", ...config };
  const unassigned = unassignedDevices ?? [];

  // Build region-name lookup
  const regionMap = new Map<string, FloorplanRegion>();
  for (const r of floorplanRegions) regionMap.set(r.id, r);

  // Unified net ID assignment
  const { netToBitId, bitIdToNetName } = assignUnifiedNetIds(
    floorplanDevices, unassigned, ioNetIds, namedNets, cfg.vdd, cfg.gnd,
  );

  if (netToBitId.size === 0) {
    return { modules: { [moduleName]: { ports: {}, cells: {} } } };
  }

  const cells: Record<string, YosysCell> = {};
  const ports: Record<string, YosysPort> = {};
  const sortFn = sortByNetName(namedNets);

  // ══ Per-region block cells ════════════════════════════════════
  // We use custom "block_odd" / "block_even" types instead of the
  // built-in sub_odd/sub_even because the built-in types don't support
  // s:attribute text replacement reliably. The custom types use
  //   s:attribute="name"
  // so we set `name` in the attributes.

  let regionIndex = 0;
  for (const [regionId, devices] of floorplanDevices) {
    if (devices.length === 0) continue;
    const region = regionMap.get(regionId);
    const blockName = region?.name ?? regionId;

    // Collect netIds used inside this region
    const regionNets = new Set<number>();
    for (const d of devices) {
      for (const t of d.terminals) {
        if (t.netId >= 0) regionNets.add(t.netId);
      }
    }

    // Only nets that have a bit ID AND are also used OUTSIDE this region
    const portEntries: { netId: number; direction: string }[] = [];
    for (const netId of regionNets) {
      if (!netToBitId.has(netId)) continue;
      const dir = inferPortDirection(devices, netId);
      portEntries.push({ netId, direction: dir });
    }

    if (portEntries.length === 0) continue;

    const inputs = portEntries.filter(p => p.direction === "input" || p.direction === "inout").sort(sortFn);
    const outputs = portEntries.filter(p => p.direction === "output" || p.direction === "inout").sort(sortFn);

    const conns: Record<string, number[]> = {};
    const dirs: Record<string, string> = {};

    for (const p of inputs) {
      const netName = namedNets.get(p.netId) ?? `N${p.netId}`;
      const portName = `in_${safePortName(netName)}`;
      conns[portName] = [netToBitId.get(p.netId)!];
      dirs[portName] = "input";
    }
    for (const p of outputs) {
      const netName = namedNets.get(p.netId) ?? `N${p.netId}`;
      const portName = `out_${safePortName(netName)}`;
      conns[portName] = [netToBitId.get(p.netId)!];
      dirs[portName] = "output";
    }

    const blockType = regionIndex % 2 === 0 ? "sub_odd" : "sub_even";
    regionIndex++;

    cells[blockName] = {
      type: blockType,
      port_directions: dirs,
      connections: conns,
      attributes: {
        ref: blockName,
      },
    };
  }

  // ══ Unassigned analog device cells ════════════════════════════

  for (const d of unassigned) {
    const instName = d.instanceName ?? `X${d.id.slice(0, 8)}`;
    const type = cellTypeForDevice(d);
    const conns = buildDeviceConnections(d, netToBitId);
    if (Object.keys(conns).length === 0) continue;

    const attrs: Record<string, string> = { ref: instName };
    // Add value/multiplier attributes (same logic as netlist2svgFormat.ts)
    const devAttrs = unassignedAttrs(d);
    if (devAttrs) Object.assign(attrs, devAttrs);
    const dirs = portDirectionsForDevice(d);
    for (const [portName, bitIds] of Object.entries(conns)) {
      const bitId = Array.isArray(bitIds) ? bitIds[0] : bitIds;
      const netName = bitIdToNetName.get(bitId);
      if (netName) attrs[`_net_${portName}`] = netName;
    }

    cells[instName] = {
      type,
      ...(dirs ? { port_directions: dirs } : {}),
      connections: conns,
      attributes: attrs,
    };
  }

  // ══ IO pin symbols (inputExt) ══════════════════════════════════

  for (const [netId, name] of namedNets) {
    const bitId = netToBitId.get(netId);
    if (bitId == null) continue;
    if (name === cfg.vdd || name === cfg.gnd) continue;
    if (!ioNetIds.has(netId)) continue;

    const cellName = `IO_${safePortName(name)}`;
    cells[cellName] = {
      type: "inputExt",
      connections: { Y: [bitId] },
      attributes: { ref: name },
    };
    ports[name] = { direction: "input", bits: [bitId] };
  }

  // ══ VDD / GND symbols ═════════════════════════════════════════

  let vddBitId: number | undefined;
  let gndBitId: number | undefined;
  for (const [netId, name] of namedNets) {
    const bitId = netToBitId.get(netId);
    if (bitId == null) continue;
    if (name === cfg.vdd) vddBitId = bitId;
    if (name === cfg.gnd) gndBitId = bitId;
  }

  if (vddBitId != null) {
    cells["VDD"] = {
      type: "vcc",
      connections: { A: [vddBitId] },
      attributes: { ref: cfg.vdd, value: cfg.vdd },
    };
  }
  if (gndBitId != null) {
    cells["GND"] = {
      type: "gnd",
      connections: { A: [gndBitId] },
      attributes: { ref: cfg.gnd, value: cfg.gnd },
    };
  }

  return {
    modules: {
      [moduleName]: { ports, cells },
    },
  };
}
