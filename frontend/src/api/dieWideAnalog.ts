/**
 * dieWideAnalog.ts — Die-wide analog device collection and export.
 *
 * Collects all analog devices across every cell type on a die,
 * matches terminals to die-level wires, and generates CDL/Spectre.
 *
 * Uses simple marker-based detection (npn_id/mos_id/res_id…)
 * No Clipper2, no auto-detection, no LVS.
 */

import type {
  AnalogDevice, AnnotationNet, Cell, CellType,
  DieAnnotations, SpiceConfig,
} from "shared";
import { extractMarkedDevices } from "../lib/extraction/simpleAnalog";
import { generateSpiceNetlist } from "../lib/export/spice";

/**
 * Collect analog devices from a single cell type's annotation.
 */
export function extractAnalogDevicesFromCellType(
  cellType: CellType,
  umPerPx: number,
): AnalogDevice[] {
  return extractMarkedDevices(cellType.layers, cellType.id, umPerPx);
}

/**
 * Match a terminal position (in die coords) to the closest die-level wire.
 * Returns a stable net ID derived from the wire name, or null if none found.
 */
function matchWireNetId(
  nets: AnnotationNet[],
  dieX: number,
  dieY: number,
  tolerance: number,
): number | null {
  let bestHash: number | null = null;
  let bestDist = tolerance;
  for (const net of nets) {
    for (const node of net.nodes) {
      const d = Math.hypot(node.x - dieX, node.y - dieY);
      if (d < bestDist) {
        bestDist = d;
        // Stable hash from wire name
        let h = 0;
        for (let i = 0; i < net.name.length; i++)
          h = ((h << 5) - h) + net.name.charCodeAt(i), h |= 0;
        bestHash = Math.abs(h) % 9000 + 100;
      }
    }
  }
  return bestHash;
}

/**
 * Collect ALL analog devices across every cell type on a die.
 * Replicates devices per instance, matches terminals to die-level wires.
 */
export function collectDieWideAnalogDevices(
  annotations: DieAnnotations,
  umPerPx: number = 1.0,
  _spiceConfig?: SpiceConfig,
): AnalogDevice[] {
  const ann = annotations as DieAnnotations;
  const allDevices: AnalogDevice[] = [];
  const nets = ann.nets ?? [];

  // Group cells by type
  const cells = ann.cells ?? [];
  const instancesByCt = new Map<string, Cell[]>();
  for (const cell of cells) {
    const list = instancesByCt.get(cell.cellTypeId) ?? [];
    list.push(cell);
    instancesByCt.set(cell.cellTypeId, list);
  }
  console.log(`[dieWide] ${cells.length} cells, ${instancesByCt.size} types`);

  const counters: Record<string, number> = {
    mos: 0, bjt_npn: 0, bjt_pnp: 0,
    jfet_n: 0, jfet_p: 0, resistor: 0, capacitor: 0, diode: 0, unknown: 0,
  };
  const pref: Record<string, string> = {
    bjt_npn: "Q", bjt_pnp: "Q",
    mos: "M", resistor: "R", capacitor: "C", diode: "D",
    jfet_n: "J", jfet_p: "J", unknown: "X",
  };

  for (const ct of ann.cellTypes) {
    const instanceList = instancesByCt.get(ct.id) ?? [];
    if (instanceList.length === 0) continue;

    let ctDevices: AnalogDevice[];
    try {
      ctDevices = extractMarkedDevices(ct.layers, ct.id, umPerPx);
    } catch (e) {
      console.warn(`extractMarkedDevices("${ct.name}") failed:`, e);
      continue;
    }
    if (ctDevices.length === 0) continue;

    for (let inst = 0; inst < instanceList.length; inst++) {
      const instCell = instanceList[inst];
      for (const dev of ctDevices) {
        const p = pref[dev.kind] ?? "X";
        counters[dev.kind] = (counters[dev.kind] ?? 0) + 1;
        const instName = `${p}${counters[dev.kind]}`;

        const cellCX = instCell?.x ?? 0;
        const cellCY = instCell?.y ?? 0;

        // Transform bbox to die-world coordinates
        const worldBbox = dev.bbox
          ? { ...dev.bbox, x: dev.bbox.x + cellCX, y: dev.bbox.y + cellCY }
          : dev.bbox;

        // Match each terminal to a die-level wire, or assign unique fresh net
        const matchedTerms = dev.terminals.map((t, ti) => {
          if (t.netId < 0) return t;
          const bbox = dev.bbox;
          if (!bbox) {
            const fresh = 2000 + allDevices.length * 10 + ti;
            return { ...t, netId: fresh };
          }
          const termDieX = cellCX + bbox.x + bbox.width * (ti + 0.5) / (dev.terminals.length + 1);
          const termDieY = cellCY + bbox.y + bbox.height * 0.5;

          const wireNetId = matchWireNetId(nets, termDieX, termDieY, 80);
          if (wireNetId != null) return { ...t, netId: wireNetId };

          const fresh = 2000 + allDevices.length * 10 + ti;
          return { ...t, netId: fresh };
        });

        allDevices.push({ ...dev, instanceName: instName, terminals: matchedTerms, bbox: worldBbox });
      }
    }
    console.log(`  → ${ct.name}: ${ctDevices.length}dev × ${instanceList.length}inst`);
  }

  return allDevices;
}

/**
 * Full pipeline: collect → generate CDL netlist.
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
    annotations, spiceConfig?.umPerPx ?? 1.0, spiceConfig,
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
