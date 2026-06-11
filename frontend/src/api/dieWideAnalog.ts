/**
 * dieWideAnalog.ts — Die-wide analog device collection and export.
 *
 * Collects all analog devices across every cell type on a die,
 * plus any die-level annotations, and generates a unified SPICE/CDL
 * netlist for the whole chip.
 *
 * Uses simple marker-based detection (USER draws npn_id/res_id/cap_id…)
 * No Clipper2, no auto-detection, no LVS.
 */

import type { AnalogDevice, CellType, DieAnnotations, SpiceConfig } from "shared";
import { extractMarkedDevices } from "../lib/extraction/simpleAnalog";
import { generateSpiceNetlist } from "../lib/export/spice";

/**
 * Collect analog devices from a single cell type's annotation.
 * Simple marker-based detection (npn_id, res_id, cap_id, diode_id layers).
 */
export function extractAnalogDevicesFromCellType(
  cellType: CellType,
  umPerPx: number,
): AnalogDevice[] {
  return extractMarkedDevices(cellType.layers, cellType.id, umPerPx);
}

/**
 * Collect ALL analog devices across every cell type on a die.
 * For each cell type, detection runs ONCE; discovered devices are then
 * replicated per INSTANCE of that cell type.
 */
export function collectDieWideAnalogDevices(
  annotations: DieAnnotations,
  umPerPx: number = 1.0,
  _spiceConfig?: SpiceConfig,
): AnalogDevice[] {
  const allDevices: AnalogDevice[] = [];
  const cellTypeById = new Map(
    annotations.cellTypes.map((ct: CellType) => [ct.id, ct]),
  );

  interface CellRef { id: string; cellTypeId: string; x: number; y: number; [k: string]: any }
  const instancesByCt = new Map<string, CellRef[]>();
  const cells = annotations.cells ?? [];
  for (const cell of cells) {
    const list = instancesByCt.get(cell.cellTypeId) ?? [];
    list.push(cell);
    instancesByCt.set(cell.cellTypeId, list);
  }
  console.log(`[collectDieWide] ${cells.length} cells, ${instancesByCt.size} types`);
  for (const [ctId, list] of instancesByCt) {
    const ct = cellTypeById.get(ctId);
    console.log(`  type ${ct?.name ?? ctId}: ${list.length} instances`);
  }

  const counters: Record<string, number> = {
    mos: 0, bjt_npn: 0, bjt_pnp: 0,
    jfet_n: 0, jfet_p: 0, resistor: 0, capacitor: 0, diode: 0, unknown: 0,
  };
  const nextPref: Record<string, string> = {
    bjt_npn: "Q", bjt_pnp: "Q",
    mos: "M", resistor: "R", capacitor: "C", diode: "D",
    jfet_n: "J", jfet_p: "J", unknown: "X",
  };

  for (const ct of annotations.cellTypes) {
    const instanceCount = (instancesByCt.get(ct.id) ?? []).length;
    if (instanceCount === 0) continue;

    let ctDevices: AnalogDevice[];
    try {
      ctDevices = extractMarkedDevices(ct.layers, ct.id, umPerPx);
    } catch (e) {
      console.warn(`collectDieWideAnalogDevices("${ct.name}") failed:`, e);
      continue;
    }

    if (ctDevices.length === 0) continue;

    for (let inst = 0; inst < instanceCount; inst++) {
      for (const dev of ctDevices) {
        const prefix = nextPref[dev.kind] ?? "X";
        counters[dev.kind] = (counters[dev.kind] ?? 0) + 1;
        const instanceName = `${prefix}${counters[dev.kind]}`;
        // Give each instance UNIQUE net IDs for its terminals
        const freshNets = new Map<string, number>();
        let nextFresh = 2000 + allDevices.length * 10;
        const uniqueTerminals = dev.terminals.map((t) => {
          if (t.netId >= 0) {
            // Fresh net per terminal per instance
            const fresh = nextFresh++;
            freshNets.set(t.name, fresh);
            return { ...t, netId: fresh };
          }
          return t;
        });
        allDevices.push({ ...dev, instanceName, terminals: uniqueTerminals });
      }
    }
    console.log(
      `  → ${ct.name}: ${ctDevices.length} devices × ${instanceCount} instances = ${ctDevices.length * instanceCount}`,
    );
  }

  return allDevices;
}

/**
 * Full pipeline: collect die-wide analog devices → generate CDL netlist.
 */
export function detectAndExportDieWide(
  annotations: DieAnnotations,
  moduleName: string,
  dialect: "cdl" | "spectre" | "hspice" = "cdl",
  spiceConfig?: SpiceConfig,
): {
  devices: AnalogDevice[];
  text: string;
  byKind: Record<string, number>;
  totalDevices: number;
  warnings: string[];
} {
  const devices = collectDieWideAnalogDevices(
    annotations,
    spiceConfig?.umPerPx ?? 1.0,
    spiceConfig,
  );

  const result = generateSpiceNetlist(devices, moduleName, spiceConfig ?? {}, dialect);

  return {
    devices,
    text: result.text,
    byKind: result.byKind,
    totalDevices: result.totalDevices,
    warnings: result.warnings,
  };
}
