/**
 * spice.ts — SPICE/Spectre netlist generation for analog circuits.
 *
 * Targets Cadence Spectre syntax based on real extracted netlists
 * (OPA547 bjt_sample, FD6288 mos_sample). Key conventions:
 *
 *   — MOSFET:  M<name> (D G S B) <model> w=…u l=…u m=…  (no AS/AD/PS/PD)
 *   — BJT:     Q<name> (C B E [SUB]) npn/pnp m=…         (m normalised
 *               to the smallest AE for NPN, smallest PE for PNP in the set)
 *   — Resistor: R<name> (N+ N–) resistor r=<Ω>           (no W/L/type)
 *   — Capacitor:C<name> (N+ N–) capacitor c=<fF>f
 *   — Zener:    D<name> (N+ N–) zener
 *   — Diode:    D<name> (N+ N–) diode
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
  ResistorType,
  FloorplanRegion,
} from "shared";
import { effectiveSheetR, RESISTOR_PARAM_NAMES } from "./resistorDefaults";
import {
  deviceInRegion,
  detectBoundaryNets,
  resolveGlobalPortAliases,
} from "./hierarchical";

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
  return geom.multiplier && geom.multiplier > 1 ? `m=${geom.multiplier}` : "";
}
/**
 * Resistor format string.
 *
 * "ohms" (default) — resolved value, e.g. r=2500.
 * "sqRs"           — symbolic expression, e.g. r=10*Rbase (squares × param).
 *
 * The numeric Rsq is always computed from effectiveSheetR() for consistency;
 * in "sqRs" mode the variable name replaces the literal value.
 */
function fmtRes(geom: DeviceGeometryResistor, config: SpiceConfig): string {
  const rType = (geom.resistorType ?? "poly") as ResistorType;
  const sr = effectiveSheetR(rType, config.sheetR_ohms);
  const sq = geom.squares;
  const sqFmt = sq === Math.round(sq) ? sq.toFixed(0) : sq.toFixed(1);
  if (config.resistorFormat === "sqRs") {
    const paramName = RESISTOR_PARAM_NAMES[rType];
    return paramName ? `r=${sqFmt}*${paramName}` : `r=${sqFmt}*${Math.round(sr)}`;
  }
  // default "ohms" - resolved numeric value
  const rOhms = Math.round(sq * sr);
  return `r=${rOhms}`;
}
/** Capacitor: c=<value> — in femtofarads if known. */
function fmtCap(geom: DeviceGeometryCapacitor): string {
  if (geom.capacitance_fF != null && geom.capacitance_fF > 0) {
    return `c=${geom.capacitance_fF.toFixed(3)}f`;
  }
  return `c=${geom.area_um2.toFixed(1)}`; // flat-area fallback
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
  config?: SpiceConfig,
): string {
  const instName = d.instanceName ?? d.id;
  const termStr = terminalString(d.kind, d.terminals, netLookup, vdd, gnd);
  const modelName = d.modelName ?? guessModelName(d);
  const params = paramString(d, dialect, config);

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

    case "spectre": {
      // Spectre format: uses type keywords for passives & BJTs
      if (d.kind === "resistor")
        return `${indent}${instName} (${termStr}) resistor ${params}`;
      if (d.kind === "capacitor")
        return `${indent}${instName} (${termStr}) capacitor ${params}`;
      if (d.kind === "inductor")
        return `${indent}${instName} (${termStr}) inductor ${params}`;
      if (d.kind === "bjt_npn")
        return `${indent}${instName} (${termStr}) npn ${params}`;
      if (d.kind === "bjt_pnp")
        return `${indent}${instName} (${termStr}) pnp ${params}`;
      if (d.kind === "zener")
        return `${indent}${instName} (${termStr}) zener ${params}`;
      if (d.kind === "schottky" || d.kind === "diode")
        return `${indent}${instName} (${termStr}) diode ${params}`;
      // MOS, JFET → use model name
      return `${indent}${instName} (${termStr}) ${modelName} ${params}`;
    }

    case "hspice":
      // HSPICE format: M1 D G S B model W=10u L=0.35u M=1
      return `${indent}${instName} ${termStr} ${modelName} ${params}`;

    default:
      return `${indent}${instName} ${termStr} ${modelName} ${params}`;
  }
}

function paramString(d: AnalogDevice, dialect: "cdl" | "spectre" | "hspice", config?: SpiceConfig): string {
  const g = d.geometry;
  switch (d.kind) {
    case "mos": {
      const mg = g as DeviceGeometryMOS;
      return [fmtW(mg), fmtL(mg), fmtM(mg)]
        .filter((s) => s)
        .join(" ");
    }
    case "bjt_npn":
    case "bjt_pnp": {
      const bg = g as DeviceGeometryBJT;
      const m = bg.multiplier > 1 ? `m=${bg.multiplier}` : "";
      return m;
    }
    case "jfet_n":
    case "jfet_p": {
      const jg = g as DeviceGeometryJFET;
      const mosLike = { ...jg, mosType: "nmos" as const, totalW_um: (jg.W_um ?? 0) * (jg.fingers ?? 1) * (jg.multiplier ?? 1) };
      return [fmtW(mosLike as DeviceGeometryMOS), fmtL(mosLike as DeviceGeometryMOS), fmtM({ multiplier: jg.multiplier })]
        .filter((s) => s)
        .join(" ");
    }
    case "resistor":
      return fmtRes(g as DeviceGeometryResistor, config ?? {});
    case "capacitor":
      return fmtCap(g as DeviceGeometryCapacitor);
    case "diode":
    case "zener":
    case "schottky": {
      const dg = g as DeviceGeometryDiode;
      return dg.multiplier > 1 ? `m=${dg.multiplier}` : "";
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
 * Normalise BJT multipliers against the smallest device found in the set.
 *
 * For NPNs the reference is the minimum AE (<AE_um2>); for PNPs the minimum
 * PE (<PE_um>).  Every BJT gets `multiplier = round(its_value / min_value)`
 * so that a unit-size device has m=1 and larger devices scale up linearly.
 *
 * The normalised multiplier is written into each device geometry; the raw
 * area/perimeter values are kept in the original fields for reference.
 */
function normalizeBJTM(devices: AnalogDevice[]): AnalogDevice[] {
  let minNpnAE = Infinity;
  let minPnpPE = Infinity;

  for (const d of devices) {
    if (d.kind === "bjt_npn") {
      const bg = d.geometry as DeviceGeometryBJT;
      if (bg.AE_um2 > 0 && bg.AE_um2 < minNpnAE) minNpnAE = bg.AE_um2;
    }
    if (d.kind === "bjt_pnp") {
      const bg = d.geometry as DeviceGeometryBJT;
      if (bg.PE_um > 0 && bg.PE_um < minPnpPE) minPnpPE = bg.PE_um;
    }
  }

  return devices.map((d) => {
    if (d.kind === "bjt_npn" && minNpnAE > 0 && isFinite(minNpnAE)) {
      const bg = { ...d.geometry } as DeviceGeometryBJT;
      const raw = bg.AE_um2 / minNpnAE;
      const m = Math.max(1, Math.round(raw * 100) / 100);
      return { ...d, geometry: { ...bg, multiplier: m } };
    }
    if (d.kind === "bjt_pnp" && minPnpPE > 0 && isFinite(minPnpPE)) {
      const bg = { ...d.geometry } as DeviceGeometryBJT;
      const raw = bg.PE_um / minPnpPE;
      const m = Math.max(1, Math.round(raw * 100) / 100);
      return { ...d, geometry: { ...bg, multiplier: m } };
    }
    return d;
  });
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
  // BJT multiplier normalisation (must happen before instance naming so
  // the unit-size BJT becomes the reference — its m=1, larger ones scale)
  const normalised = normalizeBJTM(devices);
  const named = assignInstanceNames(normalised);
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
// Resistor parameter helpers
// ═════════════════════════════════════════════════════════════════

interface ResistorParam {
  name: string;  // e.g. "Rbase"
  value: number; // e.g. 200
}

/**
 * Collect unique resistor type → param name/value pairs used in the device list.
 * Only includes types that have a known parameter name.
 */
function collectResistorParams(
  devices: AnalogDevice[],
  config: SpiceConfig,
): ResistorParam[] {
  const seen = new Set<string>();
  const params: ResistorParam[] = [];
  for (const d of devices) {
    if (d.kind !== "resistor") continue;
    const rType = ((d.geometry as DeviceGeometryResistor).resistorType ?? "poly") as ResistorType;
    const paramName = RESISTOR_PARAM_NAMES[rType];
    if (!paramName || seen.has(paramName)) continue;
    seen.add(paramName);
    const value = effectiveSheetR(rType, config.sheetR_ohms);
    // Round to integer for clean output
    params.push({ name: paramName, value: Math.round(value) });
  }
  return params;
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
  if (config.sheetR_ohms && Object.keys(config.sheetR_ohms).length > 0) {
    lines.push(`* Exported with SheetR: ${JSON.stringify(config.sheetR_ohms)}`);
  }
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

  // Resistor sheet-R parameters (only when sqRs format is selected)
  if (config.resistorFormat === "sqRs") {
    const rParams = collectResistorParams(devices, config);
    for (const p of rParams) {
      lines.push(`.PARAM ${p.name}=${p.value}`);
    }
    if (rParams.length > 0) lines.push("");
  }

  // Device instances
  for (const d of devices) {
    lines.push(deviceLine(d, netLookup, vdd, gnd, "cdl", indent, config));
  }

  // Model cards — optional; user provides models via .scs in Cadence
  if (config.models && Object.keys(config.models).length > 0) {
    lines.push("");
    for (const [name, def] of Object.entries(config.models)) {
      lines.push(def);
    }
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
  lines.push(`// Date: ${new Date().toISOString().split("T")[0]}`);
  if (config.sheetR_ohms && Object.keys(config.sheetR_ohms).length > 0) {
    lines.push(`// Exported with SheetR: ${JSON.stringify(config.sheetR_ohms)}`);
  }
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

  // Resistor sheet-R parameters (only when sqRs format is selected)
  if (config.resistorFormat === "sqRs") {
    const rParams = collectResistorParams(devices, config);
    if (rParams.length > 0) {
      lines.push(`  parameters ${rParams.map(p => `${p.name}=${p.value}`).join(" ")}`);
    }
  }

  // Device instances
  for (const d of devices) {
    lines.push(deviceLine(d, netLookup, vdd, gnd, "spectre", indent, config));
  }

  // Model cards — skipped by default; user provides .scs in Cadence
  if (config.models && Object.keys(config.models).length > 0) {
    for (const [name, def] of Object.entries(config.models)) {
      lines.push(`${indent}${def}`);
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

  // Resistor sheet-R parameters (only when sqRs format is selected)
  if (config.resistorFormat === "sqRs") {
    const rParams = collectResistorParams(devices, config);
    for (const p of rParams) {
      lines.push(`.PARAM ${p.name}=${p.value}`);
    }
    if (rParams.length > 0) lines.push("");
  }

  for (const d of devices) {
    lines.push(deviceLine(d, netLookup, vdd, gnd, "hspice", "", config));
  }

  // Models — optional
  if (config.models && Object.keys(config.models).length > 0) {
    lines.push("");
    for (const [name, def] of Object.entries(config.models)) {
      lines.push(def);
    }
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

// ═════════════════════════════════════════════════════════════════
// Hierarchical netlist (Phase 2.1 B1, refined with global rename)
// ═════════════════════════════════════════════════════════════════
//
// Port aliases from floorplan regions are applied GLOBALLY to the
// netLookup before any subcircuit/top-level generation.  This means:
//   - The subcircuit port declaration uses the aliased name
//   - The top-level instantiation also uses the aliased name
//   - All device terminal references use the aliased name
//
// Collision resolution: if two different netIds get the same alias,
// the second gets an auto-suffix (_1, _2, …) and a warning is emitted.

/**
 * Generate a hierarchical SPICE netlist with region-based subcircuits.
 *
 * Devices are partitioned by floorplan region. Each region gets its own
 * .SUBCKT with auto-detected boundary nets as ports. The top-level
 * instantiates each region and includes any devices not assigned to
 * any region.
 *
 * Devices that don't fall inside any region are included flat in the
 * top-level netlist (default behaviour for un-regioned areas).
 *
 * Port names use region.portAliases when available, otherwise fall back
 * to resolved net names. Annotated VDD/GND nets are NOT promoted to ports
 * (they remain global).
 */
export function generateHierarchicalNetlist(
  devices: AnalogDevice[],
  moduleName: string,
  config: SpiceConfig,
  dialect: SpiceDialect = "cdl",
  netLookup?: Map<number, string>,
  floorplanRegions?: FloorplanRegion[],
): SpiceNetlist {
  const warnings: string[] = [];
  const nl = buildNetNameMap(devices, netLookup ?? new Map());
  const vdd = config.vdd ?? "VDD";
  const gnd = config.gnd ?? "GND";

  // ── Partition devices by region ────────────────────────────
  const regionDevices = new Map<string, AnalogDevice[]>();
  const assignedKeys = new Set<string>();

  const regions = floorplanRegions ?? [];

  for (const region of regions) {
    const inside: AnalogDevice[] = [];
    for (const d of devices) {
      const key = d.instanceName ?? d.id; // instanceName is unique; id may be duplicated across instances
      if (assignedKeys.has(key)) continue;
      if (deviceInRegion(d, region)) {
        inside.push(d);
        assignedKeys.add(key);
      }
    }
    if (inside.length > 0) {
      regionDevices.set(region.id, inside);
    }
  }

  // Devices not in any region
  const unassigned = devices.filter((d) => { const k = d.instanceName ?? d.id; return !assignedKeys.has(k); });

  // ── Global alias resolution ────────────────────────────────
  // Apply port aliases from all floorplan regions to the net lookup
  // BEFORE generating anything.  This means aliases appear everywhere:
  // subcircuit ports, top-level nets, and device terminals.
  const { aliases: globalAliases, warnings: aliasWarnings } =
    resolveGlobalPortAliases(floorplanRegions);
  warnings.push(...aliasWarnings);

  for (const [netId, alias] of globalAliases) {
    // Don't rename VDD/GND/GND net ids
    const currentName = sanitizeSpiceName(nl.get(netId) ?? `n${netId}`);
    if (currentName === vdd || currentName === gnd || currentName === "0") continue;
    nl.set(netId, alias);
  }

  // ── Generate each region subcircuit ────────────────────────
  const lines: string[] = [];
  const indent = "  ";

  const header = dialect === "spectre"
    ? `// Spectre hierarchical netlist generated by mmo-chip\n// Source: ${moduleName}\n// Date: ${new Date().toISOString().split("T")[0]}`
    : `* SPICE hierarchical netlist generated by mmo-chip\n* Source: ${moduleName}\n* Date: ${new Date().toISOString().split("T")[0]}`;

  lines.push(header);
  if (dialect !== "spectre") {
    lines.push(`.GLOBAL ${vdd} ${gnd}`);
  }
  lines.push("");

  // ── Write the subcircuit bodies ────────────────────────────
  const regionInstanceNames = new Map<string, string>();

  // Dummy check
  if (regionDevices.size === 0 && unassigned.length === 0) {
    return {
      text: `${header}\n\n* No devices found\n`,
      byKind: {},
      totalDevices: 0,
      warnings,
    };
  }

  for (const [regionId, insideDevices] of regionDevices) {
    const region = regions.find((r) => r.id === regionId);
    if (!region) continue;

    // Re-detect boundary nets (now using globally-renamed net names)
    const boundaryNets = detectBoundaryNets(insideDevices, devices);

    const subName = sanitizeSpiceName(region.name || `Region_${region.id.slice(0, 8)}`);
    regionInstanceNames.set(region.id, subName);

    // Build port list: boundary nets → net names, skip VDD/GND
    const portNames: string[] = [];
    for (const netId of boundaryNets) {
      const netName = sanitizeSpiceName(nl.get(netId) ?? `n${netId}`);
      if (netName === vdd || netName === gnd || netName === "0") continue;
      portNames.push(netName);
    }
    portNames.sort();

    // Local instance numbering for this subcircuit
    const norm = normalizeBJTM(insideDevices);
    const localNamed = assignInstanceNames(norm);

    const portList = [...portNames, vdd, gnd].filter(Boolean);

    if (dialect === "spectre") {
      lines.push(`subckt ${subName} (${portList.join(" ")})`);
    } else {
      lines.push(`.SUBCKT ${subName} ${portList.join(" ")}`);
    }

    // Resistor sheet-R parameters (only when sqRs format is selected)
    if (config.resistorFormat === "sqRs") {
      const rParams = collectResistorParams(insideDevices, config);
      if (rParams.length > 0) {
        if (dialect === "spectre") {
          lines.push(`${indent}parameters ${rParams.map(p => `${p.name}=${p.value}`).join(" ")}`);
        } else {
          for (const p of rParams) lines.push(`  .PARAM ${p.name}=${p.value}`);
        }
      }
    }

    for (const d of localNamed) {
      lines.push(deviceLine(d, nl, vdd, gnd, dialect, indent, config));
    }

    if (dialect === "spectre") {
      lines.push(`ends ${subName}`);
    } else {
      lines.push(`.ENDS ${subName}`);
    }
    lines.push("");
  }

  // ── Top-level subcircuit ───────────────────────────────────
  const topLevelName = sanitizeSpiceName(moduleName);

  // Collect top-level ports: boundary net names from all subckts + unassigned
  const topPortNames = new Set<string>();
  for (const [regionId] of regionDevices) {
    const region = regions.find((r) => r.id === regionId);
    if (!region) continue;
    const insideDevices = regionDevices.get(regionId)!;
    const boundaryNets = detectBoundaryNets(insideDevices, devices);
    for (const netId of boundaryNets) {
      const netName = sanitizeSpiceName(nl.get(netId) ?? `n${netId}`);
      if (netName === vdd || netName === gnd || netName === "0") continue;
      topPortNames.add(netName);
    }
  }
  // Unassigned device nets become top-level ports too
  for (const d of unassigned) {
    for (const t of d.terminals) {
      if (t.netId >= 0) {
        const rawName = nl.get(t.netId) ?? `n${t.netId}`;
        const netName = sanitizeSpiceName(rawName);
        if (netName !== vdd && netName !== gnd && netName !== "0") {
          topPortNames.add(netName);
        }
      }
    }
  }
  const topPorts = [...topPortNames].sort();

  if (dialect === "spectre") {
    lines.push(`subckt ${topLevelName} (${topPorts.join(" ")} ${vdd} ${gnd})`);
  } else {
    lines.push(`.SUBCKT ${topLevelName} ${topPorts.join(" ")} ${vdd} ${gnd}`);
  }

  // Resistor sheet-R parameters (only when sqRs format is selected)
  if (config.resistorFormat === "sqRs") {
    const rParams = collectResistorParams(devices, config);
    if (rParams.length > 0) {
      if (dialect === "spectre") {
        lines.push(`  parameters ${rParams.map(p => `${p.name}=${p.value}`).join(" ")}`);
      } else {
        for (const p of rParams) lines.push(`  .PARAM ${p.name}=${p.value}`);
      }
    }
  }

  // Instantiate region subcircuits
  let instCounter = 0;
  for (const [regionId] of regionDevices) {
    instCounter++;
    const region = regions.find((r) => r.id === regionId);
    if (!region) continue;
    const insideDevices = regionDevices.get(regionId)!;
    const boundaryNets = detectBoundaryNets(insideDevices, devices);

    const subName = regionInstanceNames.get(region.id) ?? `X_${region.id.slice(0, 8)}`;

    // Port connections: for each boundary net (non-VDD/GND), use the net name
    const portNames: string[] = [];
    for (const netId of boundaryNets) {
      const netName = sanitizeSpiceName(nl.get(netId) ?? `n${netId}`);
      if (netName === vdd || netName === gnd || netName === "0") continue;
      portNames.push(netName);
    }
    portNames.sort();

    const portConnections = [...portNames, vdd, gnd];

    const instName = `X${instCounter}`;
    if (dialect === "spectre") {
      lines.push(`${indent}${instName} (${portConnections.join(" ")}) ${subName}`);
    } else {
      lines.push(`${indent}${instName} ${portConnections.join(" ")} ${subName}`);
    }
  }

  // Unassigned devices (flat in top-level)
  if (unassigned.length > 0) {
    const norm = normalizeBJTM(unassigned);
    const flatNamed = assignInstanceNames(norm);
    for (const d of flatNamed) {
      lines.push(deviceLine(d, nl, vdd, gnd, dialect, indent, config));
    }
  }

  if (dialect === "spectre") {
    lines.push(`ends ${topLevelName}`);
  } else {
    lines.push(`.ENDS ${topLevelName}`);
  }

  // ── Count by kind ──────────────────────────────────────────
  const byKind: Record<string, number> = {};
  for (const d of devices) {
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  }

  // ── Warnings ───────────────────────────────────────────────
  for (const d of devices) {
    for (const t of d.terminals) {
      if (t.netId < 0) {
        warnings.push(
          `${d.instanceName ?? d.id}: terminal "${t.name}" is unconnected`,
        );
      }
    }
  }

  return {
    text: lines.join("\n"),
    byKind,
    totalDevices: devices.length,
    warnings,
  };
}
