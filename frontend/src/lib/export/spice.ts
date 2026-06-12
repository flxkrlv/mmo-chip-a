/**
 * spice.ts — SPICE/CDL/Spectre netlist generation for analog circuits.
 *
 * Converts extracted AnalogDevice[] → text netlist in three dialects:
 *   - CDL     (Cadence Design Language) — standard for Cadence CI/CV
 *   - Spectre — modern Cadence/Mentor format
 *   - HSPICE  — Synopsys HSPICE format
 *
 * Architecture:
 *   1. `buildSpiceModel` — sort devices, assign instance names, resolve nets
 *   2. `generateCDL`     — emit .SUBCKT/.ENDS, M/Q/R/C cards
 *   3. `generateSpectre` — emit subckt/ends, device instances
 *   4. `generateHSPICE`  — emit .SUBCKT, device lines
 *
 * Each dialect emits the same electrical content with different syntax.
 */

import type {
  AnalogDevice,
  DeviceGeometry,
  DeviceGeometryBJT,
  DeviceGeometryCapacitor,
  DeviceGeometryDiode,
  DeviceGeometryJFET,
  DeviceGeometryMOS,
  DeviceGeometryResistor,
  DeviceKind,
  DeviceTerminal,
  SpiceConfig,
  SpiceDialect,
} from "shared";

// ═════════════════════════════════════════════════════════════════
// Naming helpers
// ═════════════════════════════════════════════════════════════════

const INSTANCE_PREFIXES: Record<DeviceKind, string> = {
  mos: "M",
  bjt_npn: "Q",
  bjt_pnp: "Q",
  jfet_n: "J",
  jfet_p: "J",
  resistor: "R",
  capacitor: "C",
  diode: "D",
  zener: "D",
  schottky: "D",
  inductor: "L",
  unknown: "X",
};

/**
 * Sanitize a net name for SPICE (replace non-alphanumeric chars).
 * SPICE net names can be alphanumeric + underscore, or numeric (=local).
 */
export function sanitizeSpiceName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(s) ? `n_${s}` : s || "n_";
}

/**
 * Assign instance names (M1, Q1, Q2, R1, C1…) to devices.
 * Devices are sorted by kind first, then by id.
 */
export function assignInstanceNames(
  devices: AnalogDevice[],
): AnalogDevice[] {
  const counters = new Map<string, number>();
  return devices.map((d) => {
    const prefix = INSTANCE_PREFIXES[d.kind] || "X";
    const count = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, count);
    return { ...d, instanceName: `${prefix}${count}` };
  });
}

/**
 * Resolve net id → SPICE net name.
 * Returns "0" for GND, "VDD"/"VCC" for power, or "net<N>" for everything else.
 */
function netName(
  netId: number,
  netLookup: Map<number, string>,
  vddName: string,
  gndName: string,
): string {
  if (netId < 0) return `nc_${Math.abs(netId)}`; // unconnected, NOT ground
  const custom = netLookup.get(netId);
  if (custom) return sanitizeSpiceName(custom);

  // Heuristic: check if this net is known as VCC/GND from its role
  // (we don't have roles here, but we can check the device terminal names)
  return `n${netId}`;
}

// ═════════════════════════════════════════════════════════════════
// Parameter formatting
// ═════════════════════════════════════════════════════════════════

function fmtValue(v: number | undefined, unit: string): string {
  if (v == null || v <= 0) return "";
  // Format with appropriate scale (u=μm, p=pico, f=femto)
  return `${v.toFixed(3)}${unit}`;
}

function fmtW(geom: DeviceGeometryMOS): string {
  return `W=${fmtValue(geom.W_um, "u")}`;
}
function fmtL(geom: DeviceGeometryMOS): string {
  return `L=${fmtValue(geom.L_um, "u")}`;
}
function fmtM(geom: { multiplier?: number }): string {
  return geom.multiplier && geom.multiplier > 1 ? `M=${geom.multiplier}` : "";
}
function fmtNF(geom: { fingers?: number }): string {
  return geom.fingers && geom.fingers > 1 ? `NF=${geom.fingers}` : "";
}
function fmtArea(geom: DeviceGeometryBJT | DeviceGeometryDiode): string {
  const area = "area_um2" in geom ? (geom as DeviceGeometryBJT).totalAE_um2
    : (geom as DeviceGeometryDiode).area_um2;
  return area > 0 ? `AREA=${area.toFixed(4)}E-12` : "";
}
function fmtPerim(geom: DeviceGeometryBJT | DeviceGeometryDiode): string {
  const perim = "PE_um" in geom ? (geom as DeviceGeometryBJT).PE_um
    : (geom as DeviceGeometryDiode).perimeter_um;
  return perim > 0 ? `PJ=${perim.toFixed(3)}E-6` : "";
}
function fmtRes(geom: DeviceGeometryResistor): string {
  const parts: string[] = [];
  if (geom.squares > 0) parts.push(`SQUARES=${geom.squares.toFixed(1)}`);
  if (geom.W_um > 0) parts.push(`W=${geom.W_um.toFixed(1)}u`);
  if (geom.L_um > 0) parts.push(`L=${geom.L_um.toFixed(1)}u`);
  return parts.join(" ");
}
function fmtCap(geom: DeviceGeometryCapacitor): string {
  if (geom.capacitance_fF != null && geom.capacitance_fF > 0) {
    return `C=${geom.capacitance_fF.toFixed(3)}f`;
  }
  return `W=${fmtValue(Math.sqrt(geom.area_um2), "u")} ` +
    `L=${fmtValue(Math.sqrt(geom.area_um2), "u")}`;
}

// ═════════════════════════════════════════════════════════════════
// Terminal string builders
// ═════════════════════════════════════════════════════════════════

/**
 * Build the terminal net name string for a device.
 * Order depends on device kind (SPICE convention).
 */
function terminalString(
  kind: DeviceKind,
  terminals: DeviceTerminal[],
  netLookup: Map<number, string>,
  vdd: string,
  gnd: string,
): string {
  const tn = (name: string) => {
    const t = terminals.find((t) => t.name === name);
    return t ? netName(t.netId, netLookup, vdd, gnd) : "0";
  };

  switch (kind) {
    case "mos":
      // D G S B (drain, gate, source, bulk)
      return `${tn("D")} ${tn("G")} ${tn("S")} ${tn("B")}`;
    case "bjt_npn":
    case "bjt_pnp":
      // C B E (collector, base, emitter)
      return `${tn("C")} ${tn("B")} ${tn("E")}`;
    case "jfet_n":
    case "jfet_p":
      // D G S (drain, gate, source)
      return `${tn("D")} ${tn("G")} ${tn("S")}`;
    case "resistor":
      return `${tn("PLUS")} ${tn("MINUS")}`;
    case "capacitor":
      return `${tn("PLUS")} ${tn("MINUS")}`;
    case "diode":
    case "zener":
    case "schottky":
      return `${tn("PLUS")} ${tn("MINUS")}`;
    case "inductor":
      return `${tn("PLUS")} ${tn("MINUS")}`;
    default:
      return terminals.map((t) => tn(t.name)).join(" ");
  }
}

// ═════════════════════════════════════════════════════════════════
// Model card generation
// ═════════════════════════════════════════════════════════════════

/**
 * Build .MODEL cards for device types that need them.
 * Uses user-provided models from SpiceConfig, or generates generic ones.
 */
function buildModelCards(
  devices: AnalogDevice[],
  config: SpiceConfig,
): string[] {
  const models: string[] = [];
  const seen = new Set<string>();

  for (const d of devices) {
    const modelName = d.modelName ?? guessModelName(d);
    if (seen.has(modelName)) continue;
    seen.add(modelName);

    // User override
    if (config.models?.[modelName]) {
      models.push(config.models[modelName]);
      continue;
    }

    // Generate a generic model
    const model = makeGenericModel(d, modelName);
    if (model) models.push(model);
  }

  return models;
}

function guessModelName(d: AnalogDevice): string {
  const kindNames: Record<DeviceKind, string> = {
    mos: "CMOS",
    bjt_npn: "NPN",
    bjt_pnp: "PNP",
    jfet_n: "NJF",
    jfet_p: "PJF",
    resistor: "RES",
    capacitor: "CAP",
    diode: "D",
    zener: "DZ",
    schottky: "DS",
    inductor: "IND",
    unknown: "UNKN",
  };
  return `${kindNames[d.kind] ?? "DEV"}_GEN`;
}

function makeGenericModel(d: AnalogDevice, name: string): string | null {
  const g = d.geometry;
  switch (d.kind) {
    case "mos": {
      const mg = g as DeviceGeometryMOS;
      return `.MODEL ${name} ${mg.mosType === "pmos" ? "PMOS" : "NMOS"} ` +
        `(VTO=0.7 KP=1e-4${mg.L_um < 1 ? " LAMBDA=0.1" : ""})`;
    }
    case "bjt_npn":
      return `.MODEL ${name} NPN (BF=200 IS=1e-16 VAF=50)`;
    case "bjt_pnp":
      return `.MODEL ${name} PNP (BF=100 IS=1e-16 VAF=50)`;
    case "jfet_n":
      return `.MODEL ${name} NJF (VTO=-2 BETA=1e-3)`;
    case "jfet_p":
      return `.MODEL ${name} PJF (VTO=2 BETA=1e-3)`;
    case "diode":
      return `.MODEL ${name} D (IS=1e-14 N=1)`;
    case "zener":
      return `.MODEL ${name} D (IS=1e-14 BV=5.6 N=1)`;
    case "schottky":
      return `.MODEL ${name} D (IS=1e-10 N=1.05)`;
    default:
      return null; // passive devices don't need model cards
  }
}

// ═════════════════════════════════════════════════════════════════
// Device instance lines
// ═════════════════════════════════════════════════════════════════

function deviceLine(
  d: AnalogDevice,
  netLookup: Map<number, string>,
  vdd: string,
  gnd: string,
  dialect: "cdl" | "spectre" | "hspice",
  indent: string,
): string {
  const instName = d.instanceName ?? d.id;
  const termStr = terminalString(d.kind, d.terminals, netLookup, vdd, gnd);
  const modelName = d.modelName ?? guessModelName(d);
  const params = paramString(d, dialect);

  switch (dialect) {
    case "cdl":
      // CDL format: M1 D G S B model W=10u L=0.35u M=1
      if (d.kind === "resistor") {
        return `${indent}${instName} ${termStr} ${modelName} ${params}`;
      }
      if (d.kind === "capacitor") {
        return `${indent}${instName} ${termStr} ${modelName} ${params}`;
      }
      if (d.kind === "inductor") {
        return `${indent}${instName} ${termStr} ${modelName} ${params}`;
      }
      return `${indent}${instName} ${termStr} ${modelName} ${params}`;

    case "spectre":
      // Spectre format: M1 (D G S B) model w=10u l=0.35u m=1
      return `${indent}${instName} (${termStr}) ${modelName} ${params}`;

    case "hspice":
      // HSPICE format: M1 D G S B model W=10u L=0.35u M=1
      return `${indent}${instName} ${termStr} ${modelName} ${params}`;

    default:
      return `${indent}${instName} ${termStr} ${modelName} ${params}`;
  }
}

function paramString(d: AnalogDevice, dialect: "cdl" | "spectre" | "hspice"): string {
  const g = d.geometry;
  switch (d.kind) {
    case "mos": {
      const mg = g as DeviceGeometryMOS;
      return [fmtW(mg), fmtL(mg), fmtM(mg), fmtNF(mg)]
        .filter((s) => s)
        .join(" ");
    }
    case "bjt_npn":
    case "bjt_pnp": {
      const bg = g as DeviceGeometryBJT;
      const area = (bg as any).AE_um2 > 0 ? (dialect === "cdl" ? `AREA=${((bg as any).AE_um2 * 1e-12).toExponential(2)}` : `area=${((bg as any).AE_um2 * 1e-12).toExponential(2)}`) : "";
      const m = bg.multiplier > 1 ? (dialect === "cdl" ? `M=${bg.multiplier}` : `m=${bg.multiplier}`) : "";
      return [area, m].filter((s) => s).join(" ");
    }
    case "jfet_n":
    case "jfet_p": {
      const jg = g as DeviceGeometryJFET;
      return [fmtW({ ...jg, mosType: "nmos" } as DeviceGeometryMOS), fmtL({ ...jg, mosType: "nmos" } as DeviceGeometryMOS), fmtM({ multiplier: jg.multiplier })]
        .filter((s) => s)
        .join(" ");
    }
    case "resistor":
      return fmtRes(g as DeviceGeometryResistor);
    case "capacitor":
      return fmtCap(g as DeviceGeometryCapacitor);
    case "diode":
    case "zener":
    case "schottky": {
      const dg = g as DeviceGeometryDiode;
      return [fmtArea(dg), fmtPerim(dg), fmtM({ multiplier: dg.multiplier })]
        .filter((s) => s)
        .join(" ");
    }
    default:
      return "";
  }
}

// ═════════════════════════════════════════════════════════════════
// Net lookup builder
// ═════════════════════════════════════════════════════════════════

function buildNetNameMap(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
): Map<number, string> {
  const nm = new Map<number, string>(namedNets);
  // Collect all unique net ids from device terminals
  const netIds = new Set<number>();
  for (const d of devices) {
    for (const t of d.terminals) {
      if (t.netId >= 0) netIds.add(t.netId);
    }
  }
  // Assign names to nets that don't have one yet
  let counter = 0;
  for (const id of netIds) {
    if (!nm.has(id)) {
      nm.set(id, `net${id}`);
    }
  }
  return nm;
}

// ═════════════════════════════════════════════════════════════════
// SPICE dialect generators
// ═════════════════════════════════════════════════════════════════

export interface SpiceNetlist {
  /** Full netlist text */
  text: string;
  /** Instance count per device kind */
  byKind: Record<string, number>;
  /** Total device count */
  totalDevices: number;
  /** Warnings (missing models, unconnected terminals, etc.) */
  warnings: string[];
}

/**
 * Generate a SPICE netlist from extracted analog devices.
 *
 * @param devices   — extracted analog devices (before instance naming)
 * @param moduleName — name for the top-level subcircuit
 * @param config    — SPICE technology configuration
 * @param dialect   — output format
 * @param netLookup — optional mapping of netId → human-readable name
 * @returns         — structured netlist result
 */
export function generateSpiceNetlist(
  devices: AnalogDevice[],
  moduleName: string,
  config: SpiceConfig,
  dialect: SpiceDialect = "cdl",
  netLookup?: Map<number, string>,
): SpiceNetlist {
  const named = assignInstanceNames(devices);
  const nl = buildNetNameMap(named, netLookup ?? new Map());
  const vdd = config.vdd ?? "VDD";
  const gnd = config.gnd ?? "GND";
  const warnings: string[] = [];

  // Count by kind
  const byKind: Record<string, number> = {};
  for (const d of named) {
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  }

  // Warn about unconnected terminals
  for (const d of named) {
    for (const t of d.terminals) {
      if (t.netId < 0) {
        warnings.push(
          `${d.instanceName ?? d.id}: terminal "${t.name}" is unconnected`,
        );
      }
    }
  }

  let text: string;
  switch (dialect) {
    case "cdl":
      text = generateCDL(named, moduleName, nl, config, vdd, gnd);
      break;
    case "spectre":
      text = generateSpectre(named, moduleName, nl, config, vdd, gnd);
      break;
    case "hspice":
      text = generateHSPICE(named, moduleName, nl, config, vdd, gnd);
      break;
    default:
      text = generateCDL(named, moduleName, nl, config, vdd, gnd);
  }

  return {
    text,
    byKind,
    totalDevices: named.length,
    warnings,
  };
}

// ═════════════════════════════════════════════════════════════════
// CDL generator
// ═════════════════════════════════════════════════════════════════

function generateCDL(
  devices: AnalogDevice[],
  moduleName: string,
  netLookup: Map<number, string>,
  config: SpiceConfig,
  vdd: string,
  gnd: string,
): string {
  const lines: string[] = [];
  const indent = "  ";

  // Header
  lines.push(`* SPICE netlist generated by mmo-chip analog export`);
  lines.push(`* Source: ${moduleName}`);
  lines.push(`* Date: ${new Date().toISOString().split("T")[0]}`);
  lines.push(`.GLOBAL ${vdd} ${gnd}`);
  lines.push("");

  // Ports: collect all distinct net names that are NOT VDD/GND
  const portNets = new Set<string>();
  for (const d of devices) {
    const termStr = terminalString(d.kind, d.terminals, netLookup, vdd, gnd);
    for (const term of termStr.split(" ")) {
      const sanitized = term.trim();
      if (sanitized && sanitized !== "0" && sanitized !== vdd && sanitized !== gnd) {
        portNets.add(sanitized);
      }
    }
  }
  const ports = [...portNets].sort();

  // Subcircuit declaration — CDL format:
  // .SUBCKT NAME net1 net2 net3 VDD GND
  lines.push(`.SUBCKT ${sanitizeSpiceName(moduleName)} ${ports.join(" ")} ${vdd} ${gnd}`);
  lines.push("");

  // Device instances
  for (const d of devices) {
    lines.push(deviceLine(d, netLookup, vdd, gnd, "cdl", indent));
  }

  // Model cards
  if (config.models || devices.length > 0) {
    lines.push("");
    const modelCards = buildModelCards(devices, config);
    for (const mc of modelCards) lines.push(mc);
  }

  // Footer
  lines.push("");
  lines.push(`.ENDS ${sanitizeSpiceName(moduleName)}`);

  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════
// Spectre generator
// ═════════════════════════════════════════════════════════════════

function generateSpectre(
  devices: AnalogDevice[],
  moduleName: string,
  netLookup: Map<number, string>,
  config: SpiceConfig,
  vdd: string,
  gnd: string,
): string {
  const lines: string[] = [];
  const indent = "  ";

  // Header
  lines.push(`// Spectre netlist generated by mmo-chip analog export`);
  lines.push(`// Source: ${moduleName}`);
  lines.push("");

  // Ports (same collection as CDL)
  const portNets = new Set<string>();
  for (const d of devices) {
    const termStr = terminalString(d.kind, d.terminals, netLookup, vdd, gnd);
    for (const term of termStr.split(" ")) {
      const sanitized = term.trim();
      if (sanitized && sanitized !== "0" && sanitized !== vdd && sanitized !== gnd) {
        portNets.add(sanitized);
      }
    }
  }
  const ports = [...portNets].sort();

  // Subcircuit — Spectre format: subckt NAME (p1 p2 ...) (vdd gnd)
  lines.push(`subckt ${sanitizeSpiceName(moduleName)} (${ports.join(" ")} ${vdd} ${gnd})`);

  // Device instances
  for (const d of devices) {
    lines.push(deviceLine(d, netLookup, vdd, gnd, "spectre", indent));
  }

  // Model cards (Spectre: model name type params=...)
  const seen = new Set<string>();
  for (const d of devices) {
    const modelName = d.modelName ?? guessModelName(d);
    if (seen.has(modelName)) continue;
    seen.add(modelName);
    if (config.models?.[modelName]) {
      lines.push(`${indent}${config.models[modelName]}`);
    } else {
      // Generate Spectre-format model
      const genModel = makeGenericModelSpectre(d, modelName);
      if (genModel) lines.push(genModel);
    }
  }

  // Footer
  lines.push(`ends ${sanitizeSpiceName(moduleName)}`);

  return lines.join("\n");
}

function makeGenericModelSpectre(d: AnalogDevice, name: string): string | null {
  const g = d.geometry;
  const indent = "  ";
  switch (d.kind) {
    case "mos": {
      const mg = g as DeviceGeometryMOS;
      const mosType = mg.mosType === "pmos" ? "pmos" : "nmos";
      return `${indent}model ${name} ${mosType} (vto=0.7 kp=1e-4)`;
    }
    case "bjt_npn":
      return `${indent}model ${name} npn (bf=200 is=1e-16 vaf=50)`;
    case "bjt_pnp":
      return `${indent}model ${name} pnp (bf=100 is=1e-16 vaf=50)`;
    case "jfet_n":
      return `${indent}model ${name} njf (vto=-2 beta=1e-3)`;
    case "jfet_p":
      return `${indent}model ${name} pjf (vto=2 beta=1e-3)`;
    case "diode":
      return `${indent}model ${name} diode (is=1e-14 n=1)`;
    default:
      return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// HSPICE generator
// ═════════════════════════════════════════════════════════════════

function generateHSPICE(
  devices: AnalogDevice[],
  moduleName: string,
  netLookup: Map<number, string>,
  config: SpiceConfig,
  vdd: string,
  gnd: string,
): string {
  const lines: string[] = [];
  const indent = "+";

  // HSPICE uses the same card format as CDL but with .SUBCKT/.ENDS
  const cdl = generateCDL(devices, moduleName, netLookup, config, vdd, gnd);

  // Replace CDL-style header
  lines.push(`* HSPICE netlist generated by mmo-chip analog export`);
  lines.push(`* Source: ${moduleName}`);
  lines.push(`.OPTION POST=2 PROBE`);
  lines.push(`.GLOBAL ${vdd} ${gnd}`);
  lines.push("");

  // Ports
  const portNets = new Set<string>();
  for (const d of devices) {
    const termStr = terminalString(d.kind, d.terminals, netLookup, vdd, gnd);
    for (const term of termStr.split(" ")) {
      const sanitized = term.trim();
      if (sanitized && sanitized !== "0" && sanitized !== vdd && sanitized !== gnd) {
        portNets.add(sanitized);
      }
    }
  }
  const ports = [...portNets].sort();

  lines.push(`.SUBCKT ${sanitizeSpiceName(moduleName)} ${ports.join(" ")} ${vdd} ${gnd}`);

  for (const d of devices) {
    lines.push(deviceLine(d, netLookup, vdd, gnd, "hspice", ""));
  }

  // Models
  if (config.models || devices.length > 0) {
    lines.push("");
    const modelCards = buildModelCards(devices, config);
    for (const mc of modelCards) lines.push(mc);
  }

  lines.push(`.ENDS ${sanitizeSpiceName(moduleName)}`);

  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════
// Convenience: detect + export in one step
// ═════════════════════════════════════════════════════════════════

/**
 * Full pipeline: detect analog devices from shapes → generate SPICE netlist.
 * This is what the backend calls from the export API.
 */
export function detectAndExport(
  devices: AnalogDevice[],
  moduleName: string,
  config: SpiceConfig,
  dialect: SpiceDialect = "cdl",
  namedNets?: Map<number, string>,
): SpiceNetlist {
  return generateSpiceNetlist(devices, moduleName, config, dialect, namedNets);
}
