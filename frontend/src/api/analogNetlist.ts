/**
 * analogNetlist.ts — Analog CDL/Spectre netlist generation hook.
 *
 * Mirrors `useDieCode` from codeGen.ts but for the analog pipeline:
 * collects die-wide analog devices, generates SPICE netlist (CDL by default),
 * and builds an outline / line-index so the Netlist page can scroll to
 * specific device instances.
 */

import { useMemo } from "react";
import type { AnalogDevice, DieAnnotations, SpiceConfig, SpiceDialect } from "shared";
import { apiGet, apiPost } from "./client";
import {
  assignInstanceNames,
  generateSpiceNetlist,
  generateHierarchicalNetlist,
  type SpiceNetlist,
} from "../lib/export/spice";
import { matchGeometry } from "../lib/export/matching";
import { collectDieWideAnalogDevices } from "./dieWideAnalog";

// ── Public shapes ─────────────────────────────────────────────────

export interface AnalogNetlistLeaf {
  id: string;
  label: string;       // instance name, e.g. "M1"
  meta: string;        // device kind / type, e.g. "mos · NMOS"
  line: number;        // 1-based line in the source text
  deviceKind: string;
  /** Cell instance ID this device belongs to (for framing). */
  cellId: string;
}

export interface AnalogNetlistGroup {
  kind: string;        // e.g. "mos", "bjt_npn", "resistor"
  title: string;       // human-readable, e.g. "MOS transistors"
  leaves: AnalogNetlistLeaf[];
}

export interface AnalogNetlistResult {
  source: string;
  moduleName: string;
  fileName: string;
  outline: AnalogNetlistGroup[];
  warnings: string[];
  totalDevices: number;
  byKind: Record<string, number>;
  /** instanceName → cellId lookup for cross-tab navigation. */
  deviceCellMap: Map<string, string>;
  /** Number of device terminals that have no wire connection (netId >= 2000). */
  unconnectedCount: number;
  /** Total cell instances on the die. */
  totalCells: number;
  /** Total annotation nets on the die. */
  totalNets: number;
}

// ── Helpers ───────────────────────────────────────────────────────

const KIND_TITLES: Record<string, string> = {
  mos: "MOS transistors",
  bjt_npn: "NPN BJTs",
  bjt_pnp: "PNP BJTs",
  jfet_n: "N-JFETs",
  jfet_p: "P-JFETs",
  resistor: "Resistors",
  capacitor: "Capacitors",
  diode: "Diodes",
  zener: "Zener diodes",
  schottky: "Schottky diodes",
  inductor: "Inductors",
  unknown: "Other devices",
};

function kindTitle(kind: string): string {
  return KIND_TITLES[kind] ?? kind;
}

/**
 * Parse the generated CDL text and build a line-number index for each
 * device instance. Devices appear as:
 *   <prefix><digits> ...    (M1, Q1, Q2, R1, C1, D1, X1 …)
 * We scan every line and record the first token that starts with a known
 * instance prefix.
 */
function buildLineIndex(
  text: string,
  devices: Array<{ instanceName: string; kind: string }>,
    // instanceName guaranteed by assignInstanceNames()
): Map<string, number> { // eslint-disable-line
  const map = new Map<string, number>();
  // Known instance prefixes in SPICE: M Q J R C D L X
  const prefixSet = new Set(["M", "Q", "J", "R", "C", "D", "L", "X"]);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("*") || line.startsWith("//") || line.startsWith(".")) continue;
    const first = line.split(/\s+/)[0];
    // Must start with a known prefix followed by a digit (e.g. M1, Q12)
    const m = first.match(/^([A-Z]+)(\d+)$/);
    if (m && prefixSet.has(m[1])) {
      const name = first;
      const dev = devices.find((d) => d.instanceName === name);
      if (dev) {
        map.set(dev.instanceName, i + 1); // 1-based
      }
    }
  }
  return map;
}

/**
 * Build outline groups from devices, using the line index to map
 * instance names to source lines.
 */
function buildOutline(
  devices: Array<{ instanceName: string; kind: string; modelName?: string; _cellId?: string }>,
    // instanceName guaranteed by assignInstanceNames()
  lineIndex: Map<string, number>,
): AnalogNetlistGroup[] { // eslint-disable-line
  const groups = new Map<string, AnalogNetlistGroup>();
  for (const d of devices) {
    let g = groups.get(d.kind);
    if (!g) {
      g = {
        kind: d.kind,
        title: kindTitle(d.kind),
        leaves: [],
      };
      groups.set(d.kind, g);
    }
    g.leaves.push({
      id: `inst:${d.instanceName}`,
      label: d.instanceName,
      meta: d.modelName ?? d.kind,
      line: lineIndex.get(d.instanceName) ?? 1,
      deviceKind: d.kind,
      cellId: d._cellId ?? "",
    });
  }
  // Sort groups by kind, leaves by instance name numerically
  const sorted = [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
  for (const g of sorted) {
    g.leaves.sort((a, b) => {
      const na = parseInt(a.label.replace(/^[A-Z]+/, ""), 10);
      const nb = parseInt(b.label.replace(/^[A-Z]+/, ""), 10);
      return na - nb;
    });
  }
  return sorted;
}

// ── Synchronous build ─────────────────────────────────────────────

interface BuildOptions {
  hierarchical?: boolean;
}

function buildAnalogNetlist(
  annotations: DieAnnotations,
  moduleName: string,
  dialect: SpiceDialect = "cdl",
  spiceConfig?: SpiceConfig,
  options?: BuildOptions,
): AnalogNetlistResult {
  const { devices, namedNets, warnings: deviceWarnings } = collectDieWideAnalogDevices(
    annotations,
    spiceConfig?.umPerPx ?? annotations.umPerPx ?? 1.0,
    spiceConfig,
  );

  // Assign instance names (M1, Q1, R1, …)
  const named = assignInstanceNames(devices);

  // Optional geometry matching (averaging similar devices)
  const matchWarnings = matchGeometry(named as (AnalogDevice & { instanceName: string })[], spiceConfig ?? {}, namedNets);

  const config: SpiceConfig = spiceConfig ?? {};

  const isHierarchical = options?.hierarchical ?? false;

  const result: SpiceNetlist = isHierarchical
    ? generateHierarchicalNetlist(
        named,
        moduleName,
        config,
        dialect,
        namedNets,
        annotations.floorplanRegions,
      )
    : generateSpiceNetlist(
        named,
        moduleName,
        config,
        dialect,
        namedNets,
      );

  // Build line index + outline (assignInstanceNames guarantees instanceName)
  const namedSafe = named as Array<AnalogDevice & { instanceName: string }>;
  const lineIndex = buildLineIndex(result.text, namedSafe);
  const outline = buildOutline(namedSafe, lineIndex);

  // instanceName → cellId lookup
  const deviceCellMap = new Map<string, string>();
  for (const d of named) {
    const cellId = (d as any)._cellId as string | undefined;
    if (cellId && d.instanceName) deviceCellMap.set(d.instanceName, cellId);
  }

  // Count unconnected terminals (netId >= 2000 = fresh IDs when wire matching failed)
  const unconnectedCount = named.reduce((sum, d) => {
    return sum + d.terminals.filter((t) => t.netId >= 2000).length;
  }, 0);
  const totalCells = annotations.cells?.length ?? 0;
  const totalNets = annotations.nets?.length ?? 0;

  return {
    source: result.text,
    moduleName,
    fileName: `${moduleName}.${dialect === "cdl" ? "cdl" : dialect === "spectre" ? "scs" : "sp"}`,
    outline,
    warnings: [...deviceWarnings, ...result.warnings, ...matchWarnings.map(w => w.text)],
    totalDevices: result.totalDevices,
    byKind: result.byKind,
    deviceCellMap,
    unconnectedCount,
    totalCells,
    totalNets,
  };
}

// ── React hook ────────────────────────────────────────────────────
//
// Generation is synchronous pure compute, wrapped in useMemo keyed on
// annotations. No async / network dependency.

interface UseAnalogNetlist {
  data: AnalogNetlistResult | null;
  loading: boolean;
  error: string | null;
}

export function useAnalogNetlist(
  annotations: DieAnnotations | undefined,
  moduleName: string,
  dialect: SpiceDialect = "cdl",
  spiceConfig?: SpiceConfig,
  hierarchical: boolean = false,
): UseAnalogNetlist {
  const data = useMemo<AnalogNetlistResult | null>(() => {
    if (!annotations) return null;
    try {
      return buildAnalogNetlist(annotations, moduleName, dialect, spiceConfig, { hierarchical });
    } catch (e) {
      // Surface the error; the page will show it.
      throw e;
    }
  }, [annotations, moduleName, dialect, spiceConfig, hierarchical]);

  return {
    data,
    loading: !annotations,
    error: null,
  };
}

// ── SpiceConfig persistence ────────────────────────────────────────

/**
 * Load saved SpiceConfig from the backend.
 */
export async function loadSpiceConfig(dieId: string): Promise<SpiceConfig> {
  try {
    const result = await apiGet<SpiceConfig | null>(
      `/api/dies/${encodeURIComponent(dieId)}/spice-config`,
    );
    return result ?? {};
  } catch {
    return {};
  }
}

/**
 * Save SpiceConfig to the backend.
 */
export async function saveSpiceConfigToBackend(
  dieId: string,
  config: SpiceConfig,
): Promise<void> {
  await apiPost(
    `/api/dies/${encodeURIComponent(dieId)}/spice-config`,
    config,
  );
}

