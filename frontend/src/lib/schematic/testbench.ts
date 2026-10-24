/**
 * testbench.ts — turn a simulation netlist into a testbench schematic.
 *
 * The testbench view answers "what is driving what": the DUT is drawn as one
 * rectangle with its pins, and the sources and loads the testbench connects
 * to it are drawn around it, wired to the pins they share a net with.
 *
 * It reuses the app's own schematic renderer (`InteractiveAnalogSchematic`)
 * through the same `HierarchyBlock` machinery the Netlist tab uses for
 * floorplan regions — so wires are routed to the real pin anchors by ELK
 * instead of being drawn by hand.
 */

import type { AnalogDevice } from "shared";
import { parseNetlistToDevices } from "./netlistTextToDevices";
import type { HierarchyBlock } from "./interactiveAnalogLayout";

export interface TestbenchData {
  /** Top-level testbench devices: sources, loads, level shifters, … */
  devices: AnalogDevice[];
  /** netId → net name. */
  namedNets: Map<number, string>;
  /** The DUT instance(s), drawn as blocks. */
  blocks: HierarchyBlock[];
  /** Subcircuit name of the DUT (null when the netlist is flat). */
  dutName: string | null;
  /** Port names of the DUT, in order. */
  dutPorts: string[];
  /** False when the netlist has nothing to draw. */
  ok: boolean;
  /** Why the testbench picture is not available. */
  message?: string;
  /** Power nets, for the renderer's VDD/GND symbols. */
  vdd?: string;
  gnd?: string;
}

const SUBCKT_RE = /^\.subckt\s+(\S+)\s*(.*)$/i;
const ENDS_RE = /^\.ends\b/i;
const X_RE = /^([X]\w*)\s+(.+)$/i;

/** Split a netlist into its top level and its `.subckt` definitions. */
function splitNetlist(netlist: string): {
  topLevel: string;
  subckts: Map<string, string[]>;
} {
  const top: string[] = [];
  const subckts = new Map<string, string[]>();
  let inside = false;

  for (const raw of netlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("*")) continue;
    const sub = SUBCKT_RE.exec(line);
    if (sub) {
      inside = true;
      subckts.set(sub[1], sub[2].trim().split(/\s+/).filter(Boolean));
      continue;
    }
    if (ENDS_RE.test(line)) { inside = false; continue; }
    if (inside) continue;
    top.push(raw);
  }
  return { topLevel: top.join("\n"), subckts };
}

/** Nets the top-level sources drive (their "+" node). */
function drivenNets(devices: AnalogDevice[]): Set<number> {
  const out = new Set<number>();
  for (const d of devices) {
    if (d.kind !== "voltage_source" && d.kind !== "current_source") continue;
    for (const t of d.terminals) if (t.name === "PLUS") out.add(t.netId);
  }
  return out;
}

/** Power-ish net names. */
const POWER_RE = /^(vcc|vdd|avdd|avcc|vdda|vddio|vbus|gnd|vss|vee|0)$/i;

/**
 * Parse a simulation netlist into a testbench picture.
 *
 * @param netlist  the netlist that gets simulated (DUT + testbench)
 * @param options  `vdd`/`gnd` names for the power symbols
 */
export function parseTestbenchNetlist(
  netlist: string,
  options: { vdd?: string; gnd?: string } = {},
): TestbenchData {
  const { topLevel, subckts } = splitNetlist(netlist);

  // The X instances are the DUT(s); everything else at the top level is a
  // testbench element (source, load, …).
  const instances: Array<{ name: string; nodes: string[]; subckt: string }> = [];
  for (const raw of topLevel.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("*") || line.startsWith(".")) continue;
    const x = X_RE.exec(line);
    if (!x) continue;
    const tokens = x[2].trim().split(/\s+/);
    instances.push({ name: x[1], nodes: tokens.slice(0, -1), subckt: tokens[tokens.length - 1] });
  }

  const parsed = parseNetlistToDevices(topLevel);
  const instanceNames = new Set(instances.map((i) => i.name));
  const devices = parsed.devices.filter((d) => !instanceNames.has(d.instanceName ?? d.id));
  const namedNets = parsed.namedNets;

  // Every node of an instance is a pin of the block, so it needs a net — even
  // when no top-level device touches it (a DUT pin the testbench leaves open).
  let nextNetId = 1 + [...namedNets.keys()].reduce((max, id) => Math.max(max, id), -1);
  for (const instance of instances) {
    for (const netName of instance.nodes) {
      if (netIdOf(namedNets, netName) == null) namedNets.set(nextNetId++, netName);
    }
  }

  const vdd = options.vdd ?? "VDD";
  const gnd = options.gnd ?? "0";

  // No DUT instance: either a flat netlist (draw everything) or a subcircuit
  // that is never instantiated (nothing to wire up).
  if (instances.length === 0) {
    if (subckts.size > 0) {
      return {
        devices,
        namedNets,
        blocks: [],
        dutName: null,
        dutPorts: [],
        ok: false,
        message: `The subcircuit${subckts.size > 1 ? "s" : ""} ${[...subckts.keys()].join(", ")} ${subckts.size > 1 ? "are" : "is"} never instantiated — add an \`X1 … <subckt>\` line to the testbench.`,
        vdd,
        gnd,
      };
    }
    return { devices, namedNets, blocks: [], dutName: null, dutPorts: [], ok: devices.length > 0, vdd, gnd };
  }

  const driven = drivenNets(devices);
  const blocks: HierarchyBlock[] = [];

  for (const instance of instances) {
    const ports = subckts.get(instance.subckt) ?? [];
    const nets: HierarchyBlock["nets"] = [];
    ports.forEach((_port, index) => {
      const netName = instance.nodes[index];
      if (!netName) return;
      const netId = netIdOf(namedNets, netName);
      if (netId == null) return;
      const isPower = POWER_RE.test(netName);
      const direction: "input" | "output" = isPower || driven.has(netId) ? "input" : "output";
      nets.push({ netId, name: netName, direction });
    });
    blocks.push({ regionId: instance.name, name: `${instance.name} · ${instance.subckt}`, nets });
  }

  const dutName = instances[0]?.subckt ?? null;
  const dutPorts = subckts.get(dutName ?? "") ?? [];

  return { devices, namedNets, blocks, dutName, dutPorts, ok: true, vdd, gnd };
}

/** Find the net id of a net name (case-insensitive). */
function netIdOf(namedNets: Map<number, string>, name: string): number | undefined {
  const key = name.toLowerCase();
  for (const [netId, netName] of namedNets) {
    if (netName.toLowerCase() === key) return netId;
  }
  return undefined;
}

/**
 * Name of the DUT a netlist works with: the subcircuit the testbench
 * instantiates, or — when nothing is instantiated — the only subcircuit it
 * defines. Used to select the matching entry in the subcircuit picker.
 */
export function detectDutName(netlist: string): string | null {
  const { topLevel, subckts } = splitNetlist(netlist);
  for (const raw of topLevel.split(/\r?\n/)) {
    const x = X_RE.exec(raw.trim());
    if (!x) continue;
    const tokens = x[2].trim().split(/\s+/);
    const subckt = tokens[tokens.length - 1];
    if (subckts.has(subckt)) return subckt;
  }
  if (subckts.size === 1) return [...subckts.keys()][0];
  return null;
}
