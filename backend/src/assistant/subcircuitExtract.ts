/// <reference types="node" />

/**
 * subcircuitExtract.ts — extract a focused subcircuit from the extracted
 * circuit and emit it as a Spectre netlist compatible with `normalizeForVyges`.
 *
 * The emitted netlist goes through the exact same Spectre→CDL normalizer that
 * the reference-library cells use, so the model's candidate and a library cell
 * are compared on identical footing by vyges-lvs.
 *
 * Terminal ordering follows device role (MOS: D G S B, BJT: C B E) so the
 * normalizer keeps the correct pin order in the CDL output. Device values are
 * placeholders — vyges-lvs compares topology, not sizing.
 */

import type { AssistantCircuitDeviceInput, DeviceKind } from "shared";

const MODEL_TOKEN: Record<DeviceKind, string> = {
  mos: "nmos",
  bjt_npn: "npn",
  bjt_pnp: "pnp",
  jfet_n: "njf",
  jfet_p: "pjf",
  resistor: "resistor",
  capacitor: "capacitor",
  diode: "diode",
  zener: "zener",
  schottky: "schottky",
  inductor: "inductor",
  unknown: "unknown",
};

const ROLE_ORDER: Partial<Record<DeviceKind, string[]>> = {
  mos: ["D", "G", "S", "B"],
  bjt_npn: ["C", "B", "E"],
  bjt_pnp: ["C", "B", "E"],
  jfet_n: ["D", "G", "S", "B"],
  jfet_p: ["D", "G", "S", "B"],
};

const POWER_NET_NAMES = new Set([
  "GND", "VCC", "VDD", "VSS", "VEE", "VBB", "VSUB", "AVDD", "AVSS", "DVDD", "DVSS", "0",
]);

function sanitizeNetName(raw: string): string {
  if (!raw) return "n0";
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n${cleaned}`;
}

function netName(netId: number, names: Map<number, string>): string {
  if (netId < 0) return "UNCONNECTED";
  const n = names.get(netId);
  if (n) return sanitizeNetName(n);
  return `n${netId}`;
}

function orderedTerminals(
  kind: DeviceKind,
  terminals: AssistantCircuitDeviceInput["terminals"],
): AssistantCircuitDeviceInput["terminals"] {
  const order = ROLE_ORDER[kind];
  if (!order || order.length === 0) return terminals;
  const byName = new Map(terminals.map((t) => [t.name, t]));
  const ordered = order.map((role) => byName.get(role)).filter((t): t is AssistantCircuitDeviceInput["terminals"][number] => Boolean(t));
  for (const t of terminals) if (!order.includes(t.name)) ordered.push(t);
  return ordered;
}

function isOrderedDevice(kind: DeviceKind): boolean {
  return kind === "mos" || kind === "bjt_npn" || kind === "bjt_pnp" || kind === "jfet_n" || kind === "jfet_p";
}

/**
 * Emit a Spectre netlist for the subcircuit defined by `deviceUuids`.
 * Nets connecting only to the selected devices become internal nets; nets that
 * also touch unselected devices become boundary ports (still valid nets for
 * vyges-lvs). Power/ground nets are emitted as `.GLOBAL` for correct anchoring.
 */
export function emitSubcircuitSpice(
  devices: AssistantCircuitDeviceInput[],
  namedNets: Array<{ id: number; name: string }>,
  deviceUuids: string[],
): string {
  const nameMap = new Map(namedNets.map((n) => [n.id, n.name]));
  const uuidSet = new Set(deviceUuids);
  const selected = uuidSet.size > 0 ? devices.filter((d) => uuidSet.has(d.uuid)) : devices;
  if (selected.length === 0) {
    throw new Error("No devices match the supplied UUIDs for LVS subcircuit extraction.");
  }

  const lines: string[] = [];
  const globals = new Set<string>();

  for (const device of selected) {
    // instanceName already carries the device letter (e.g. "Q30", "M1"); never prepend.
    const name = (device.instanceName || device.uuid).replace(/[^A-Za-z0-9_]/g, "_");
    const terminals = orderedTerminals(device.kind, device.terminals);
    const netTerms = terminals.map((t) => netName(t.netId, nameMap)).join(" ");
    const token = MODEL_TOKEN[device.kind] ?? "unknown";

    let line: string;
    if (isOrderedDevice(device.kind)) {
      line = `${name} (${netTerms}) ${token} m=1`;
    } else if (device.kind === "resistor") {
      line = `${name} (${netTerms}) resistor r=1k`;
    } else if (device.kind === "capacitor") {
      line = `${name} (${netTerms}) capacitor c=1p`;
    } else if (device.kind === "inductor") {
      line = `${name} (${netTerms}) inductor l=1n`;
    } else {
      line = `${name} (${netTerms}) ${token}`;
    }
    lines.push(line);

    for (const t of device.terminals) {
      const raw = nameMap.get(t.netId) ?? "";
      const nm = netName(t.netId, nameMap);
      if (POWER_NET_NAMES.has(nm) || POWER_NET_NAMES.has(raw)) globals.add(nm);
    }
  }

  const header = globals.size > 0 ? `.GLOBAL ${[...globals].join(" ")}\n` : "";
  return header + lines.join("\n");
}

/**
 * Coarse structural signature for prefiltering LVS candidates. Counts devices by
 * their MODEL token (nmos / pmos / npn / pnp / resistor / capacitor / …) so two
 * circuits with the same device-type multiset land in the same bucket. vyges-lvs
 * then does the real topological comparison within the bucket.
 */
const MODEL_VOCAB = /(?:^|\s)(nmos|pmos|njf|pjf|npn|pnp|resistor|capacitor|inductor|diode|zener|schottky|unknown)(?=\s|$)/;

export function signatureFromSpice(spice: string): Record<string, number> {
  const sig: Record<string, number> = {};
  for (const raw of spice.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith(".") || line.startsWith("*") || line.startsWith("//")) continue;
    const m = line.match(/^([A-Za-z])\w*/);
    if (!m) continue;
    const letter = m[1].toUpperCase();
    if (!/^[MQRCJLD]$/.test(letter)) continue;
    const model = line.match(MODEL_VOCAB)?.[1];
    const key = model ? `${letter}:${model}` : letter;
    sig[key] = (sig[key] ?? 0) + 1;
  }
  return sig;
}

/** Structural distance between two signatures: sum of absolute per-letter deltas. */
export function signatureDistance(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let d = 0;
  for (const k of keys) d += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return d;
}
