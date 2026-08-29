/**
 * netlistTextToDevices.ts — Parse a normalized CDL/Spectre netlist string into
 * `AnalogDevice[]` + a `namedNets` map so it can be rendered by the app's
 * existing netlist2svg pipeline (`formatDevicesAsNetlist2Svg` + `Netlist2SvgView`).
 *
 * This is the single place that turns the reference/candidate netlist text shown
 * in the LVS cards into a schematic, reusing the same renderer the Netlist
 * (Analog) tab already uses — no duplicate SVG engine.
 */

import type { AnalogDevice, DeviceGeometry, DeviceTerminal } from "shared";

export interface ParsedNetlist {
  devices: AnalogDevice[];
  namedNets: Map<number, string>;
}

interface RawDev {
  name: string;
  prefix: string;
  model?: string;
  terminals: string[];
  params: Record<string, string>;
}

function parseParam(token: string): [string, string] | null {
  const m = token.match(/^([a-zA-Z_]+)\s*=\s*([\S]+)$/);
  if (m) return [m[1].toLowerCase(), m[2]];
  return null;
}

function parseDeviceLine(line: string): RawDev | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith(".")) return null;
  const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/);
  if (!m) return null;
  const name = m[1];
  const prefix = name[0].toUpperCase();
  const tokens = m[2].trim().split(/\s+/).filter(Boolean);
  const params: Record<string, string> = {};
  let terminals: string[];
  let model: string | undefined;

  if (prefix === "M") {
    terminals = tokens.slice(0, 4);
    model = tokens[4]?.replace(/^.*=/, "");
    for (const t of tokens.slice(4)) {
      const p = parseParam(t);
      if (p) params[p[0]] = p[1];
    }
  } else if (prefix === "Q") {
    terminals = tokens.slice(0, 3);
    model = tokens[3]?.replace(/^.*=/, "");
    for (const t of tokens.slice(3)) {
      const p = parseParam(t);
      if (p) params[p[0]] = p[1];
    }
  } else if (prefix === "R" || prefix === "C" || prefix === "L" || prefix === "D") {
    terminals = tokens.slice(0, 2);
    // second positional token may be a value (e.g. "1k") or a model keyword
    const third = tokens[2];
    if (third && /[a-zA-Z]/.test(third) && !/^[a-zA-Z]+\s*=/.test(third)) {
      model = third.replace(/^.*=/, "");
    }
    for (const t of tokens.slice(2)) {
      const p = parseParam(t);
      if (p) params[p[0]] = p[1];
      else if (t && !/^[a-zA-Z]/.test(t)) {
        // bare positional value (R/C/L value token, no key)
        if (prefix === "R") params.r = t;
        else if (prefix === "C") params.c = t;
        else if (prefix === "L") params.l = t;
      }
    }
  } else {
    terminals = tokens.slice(0, 2);
  }
  if (terminals.length === 0) return null;
  return { name, prefix, model, terminals, params };
}

/** Lightweight SI suffix → multiplier (relative to the field's base unit). */
function siToMul(s: string): number {
  const m = s.match(/^([\d.eE+-]+)\s*([a-zA-Z]*)$/);
  if (!m) return Number(s) || 1;
  const val = Number(m[1]) || 0;
  switch ((m[2] || "").toLowerCase()) {
    case "k": return val * 1e3;
    case "m": return val * 1e-3;
    case "u": return val * 1e-6;
    case "n": return val * 1e-9;
    case "p": return val * 1e-12;
    case "f": return val * 1e-15;
    default: return val;
  }
}

/** Convert a value token (ohms/k/fF) into a number, ignoring SI suffix noise. */
function valueNum(token: string | undefined): number | undefined {
  if (!token) return undefined;
  // strip trailing unit letters, keep exponent form
  const cleaned = token.replace(/[a-zA-Z]/g, "");
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : undefined;
}

function terminalNames(prefix: string): string[] {
  switch (prefix) {
    case "M": return ["D", "G", "S", "B"];
    // Normalized CDL drops the BJT substrate pin, so only C/B/E remain.
    case "Q": return ["C", "B", "E"];
    default: return ["PLUS", "MINUS"];
  }
}

function buildDevice(raw: RawDev, netIdFor: (net: string) => number): AnalogDevice | null {
  const tNames = terminalNames(raw.prefix);
  if (raw.terminals.length < tNames.length) return null;
  const terminals: DeviceTerminal[] = tNames.map((nm, i) => ({
    name: nm,
    netId: netIdFor(raw.terminals[i]),
  }));

  const num = (k: string) => valueNum(raw.params[k]);
  const model = (raw.model ?? "").toLowerCase();
  const mk = (g: DeviceGeometry): AnalogDevice => ({
    id: raw.name,
    kind: "unknown",
    geometry: g,
    cellTypeId: "",
    instanceName: raw.name,
    terminals,
  });

  if (raw.prefix === "M") {
    const mosType = model.includes("pmos") ? "pmos" : model.includes("nmos") ? "nmos" : model.startsWith("p") ? "pmos" : "nmos";
    const w = num("w");
    const l = num("l");
    const mult = num("m") ?? 1;
    return {
      ...mk({
        L_um: l ?? 1,
        W_um: w ?? 1,
        fingers: 1,
        multiplier: mult,
        totalW_um: (w ?? 1) * mult,
        mosType: mosType as "pmos" | "nmos" | "unknown",
      }),
      kind: "mos",
      modelName: raw.model,
    };
  }
  if (raw.prefix === "Q") {
    const bjtType = model.includes("pnp") ? "pnp" : "npn";
    const ae = num("ae") ?? num("area") ?? 1;
    const pe = num("pe") ?? num("perim") ?? 1;
    const mult = num("m") ?? 1;
    return {
      ...mk({
        AE_um2: ae,
        PE_um: pe,
        multiplier: mult,
        totalAE_um2: ae * mult,
        emitterFingers: 1,
        bjtType: bjtType as "npn" | "pnp" | "unknown",
      }),
      kind: bjtType === "pnp" ? "bjt_pnp" : "bjt_npn",
      modelName: raw.model,
    };
  }
  if (raw.prefix === "R") {
    const r = num("r") ?? valueNum(raw.params.r);
    return {
      ...mk({
        L_um: 1, W_um: 1, squares: 1, fingers: 1,
        multiplier: num("m") ?? 1,
        resistance_ohms: r,
        resistorType: (raw.params.resistorType as never) ?? "poly",
      }),
      kind: "resistor",
      modelName: raw.model,
    };
  }
  if (raw.prefix === "C") {
    const c = num("c") ?? valueNum(raw.params.c);
    return {
      ...mk({
        area_um2: 1, perimeter_um: 1,
        multiplier: num("m") ?? 1,
        capacitance_fF: c,
      }),
      kind: "capacitor",
      modelName: raw.model,
    };
  }
  if (raw.prefix === "L") {
    return {
      ...mk({ L_um: 1, W_um: 1, squares: 1, fingers: 1, multiplier: num("m") ?? 1 }),
      kind: "inductor",
      modelName: raw.model,
    };
  }
  if (raw.prefix === "D") {
    const kind = model.includes("schottky") ? "schottky" : model.includes("zener") ? "zener" : "diode";
    return {
      ...mk({ area_um2: 1, perimeter_um: 1, multiplier: num("m") ?? 1 }),
      kind,
      modelName: raw.model,
    };
  }
  return null;
}

/** Parse a CDL/Spectre netlist string into devices + namedNets for netlist2svg. */
export function parseNetlistToDevices(text: string): ParsedNetlist {
  const devices: AnalogDevice[] = [];
  const namedNets = new Map<number, string>();
  const netIdMap = new Map<string, number>();
  let nextNetId = 1;

  const netIdFor = (net: string): number => {
    let id = netIdMap.get(net);
    if (id === undefined) {
      id = nextNetId++;
      netIdMap.set(net, id);
      namedNets.set(id, net);
    }
    return id;
  };

  for (const line of text.split("\n")) {
    const raw = parseDeviceLine(line);
    if (!raw) continue;
    const dev = buildDevice(raw, netIdFor);
    if (dev) devices.push(dev);
  }
  return { devices, namedNets };
}
