/**
 * spiceDutNetlist.ts — build a simulation-ready netlist from the extracted
 * circuit snapshot.
 *
 * The assistant's SPICE tool used to ask the model for the whole netlist.
 * That does not work: a 120-line netlist does not survive being copied by a
 * language model (lines get mangled, the testbench gets forgotten), and every
 * copy is a chance to lose a device.
 *
 * So the DUT netlist is built here — from the same snapshot the model sees —
 * and the model only writes the *testbench*: the supply, the load and the
 * analysis directive. The values come from the extracted geometry (sheet
 * resistance, emitter area, W/L, multipliers), so the netlist is the real
 * circuit, not a placeholder.
 *
 * The output is Spectre-flavoured (parenthesised node lists); the shared
 * netlist converter turns it into ngspice syntax.
 */

import type { AssistantCircuitDeviceInput, DeviceKind } from "shared";

type Device = AssistantCircuitDeviceInput;
type NetNames = Map<number, string>;

function netLabel(netId: number, names: NetNames): string {
  if (netId < 0) return "nc";
  const name = names.get(netId);
  if (!name) return `NET${netId}`;
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Terminal names per device kind, in SPICE order. */
const TERMINAL_ORDER: Partial<Record<DeviceKind, string[]>> = {
  mos: ["D", "G", "S", "B"],
  bjt_npn: ["C", "B", "E"],
  bjt_pnp: ["C", "B", "E"],
  jfet_n: ["D", "G", "S"],
  jfet_p: ["D", "G", "S"],
  resistor: ["PLUS", "MINUS"],
  capacitor: ["PLUS", "MINUS"],
  diode: ["PLUS", "MINUS"],
  zener: ["PLUS", "MINUS"],
  schottky: ["PLUS", "MINUS"],
  inductor: ["PLUS", "MINUS"],
};

function orderedTerminals(device: Device): string[] {
  const order = TERMINAL_ORDER[device.kind];
  const byName = new Map(device.terminals.map((t) => [t.name, t]));
  if (!order) return device.terminals.map((t) => t.name);
  const out = order.map((role) => byName.get(role)?.name).filter((n): n is string => Boolean(n));
  for (const t of device.terminals) if (!out.includes(t.name)) out.push(t.name);
  return out;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One device as a Spectre-style netlist line. */
function deviceLine(device: Device, names: NetNames): string | null {
  const name = (device.instanceName || device.uuid).replace(/[^A-Za-z0-9_]/g, "_");
  const geometry = device.geometry as unknown as Record<string, unknown>;
  const terminals = orderedTerminals(device);
  const nets = terminals.map((role) => {
    const terminal = device.terminals.find((t) => t.name === role);
    return netLabel(terminal?.netId ?? -1, names);
  });
  const nodes = `(${nets.join(" ")})`;

  switch (device.kind) {
    case "resistor": {
      const sheet = number(geometry.sheetR_ohms);
      const squares = number(geometry.squares) ?? 1;
      const r = number(geometry.resistance_ohms) ?? (sheet !== undefined ? sheet * squares : undefined);
      const value = r && r > 0 ? r : 1000;
      return `${name} ${nodes} resistor r=${value}`;
    }
    case "capacitor": {
      const c = number(geometry.capacitance_fF);
      const value = c && c > 0 ? `${c}f` : "1p";
      return `${name} ${nodes} capacitor c=${value}`;
    }
    case "inductor":
      return `${name} ${nodes} inductor l=1n`;
    case "diode":
      return `${name} ${nodes} diode`;
    case "zener":
      return `${name} ${nodes} zener`;
    case "schottky":
      return `${name} ${nodes} schottky`;
    case "bjt_npn":
    case "bjt_pnp": {
      const model = device.kind === "bjt_npn" ? "npn" : "pnp";
      const m = number(geometry.multiplier);
      return `${name} ${nodes} 0 ${model}${m && m > 1 ? ` m=${m}` : ""}`;
    }
    case "mos": {
      const mosType = geometry.mosType === "pmos" ? "pmos" : "nmos";
      const w = number(geometry.W_um);
      const l = number(geometry.L_um);
      const m = number(geometry.multiplier);
      const params = [
        w ? `w=${w}u` : "",
        l ? `l=${l}u` : "",
        m && m > 1 ? `m=${m}` : "",
      ].filter(Boolean).join(" ");
      return `${name} ${nodes} ${mosType}${params ? ` ${params}` : ""}`;
    }
    case "jfet_n":
    case "jfet_p": {
      const model = device.kind === "jfet_n" ? "njf" : "pjf";
      const w = number(geometry.W_um);
      const l = number(geometry.L_um);
      const params = [w ? `w=${w}u` : "", l ? `l=${l}u` : ""].filter(Boolean).join(" ");
      return `${name} ${nodes} ${model}${params ? ` ${params}` : ""}`;
    }
    default:
      return null;
  }
}

/**
 * Build the DUT netlist for a set of devices.
 *
 * @param devices — the devices to include (the whole die or a finding)
 * @param namedNets — id → net name
 * @returns a Spectre-flavoured netlist, ready for the netlist converter
 */
export function buildSimulationNetlist(
  devices: Device[],
  namedNets: Array<{ id: number; name: string }>,
): string {
  const names: NetNames = new Map(namedNets.map((n) => [n.id, n.name]));
  const lines: string[] = ["* DUT netlist (built from the extracted circuit)"];
  let skipped = 0;
  for (const device of devices) {
    const line = deviceLine(device, names);
    if (line) lines.push(line);
    else skipped += 1;
  }
  if (skipped > 0) lines.push(`* (${skipped} device(s) of unknown type were skipped)`);
  return lines.join("\n");
}

/**
 * The net names the testbench can use: the named nets plus the global rails.
 * The model gets this list so it can pick the right node for the supply.
 */
export function testbenchNetNames(
  devices: Device[],
  namedNets: Array<{ id: number; name: string }>,
): string[] {
  const names = new Set<string>();
  for (const net of namedNets) names.add(net.name.replace(/[^A-Za-z0-9_]/g, "_"));
  const map: NetNames = new Map(namedNets.map((n) => [n.id, n.name]));
  for (const device of devices) {
    for (const terminal of device.terminals) {
      const label = netLabel(terminal.netId, map);
      names.add(label);
    }
  }
  return [...names].filter(Boolean).sort();
}
