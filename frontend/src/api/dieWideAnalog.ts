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
  DeviceKind, DieAnnotations, LayerShape, SpiceConfig,
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

  const counters: Record<string, number> = {};
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
      if (ctDevices.length > 0) {
        console.log(`[extract] ${ct.name} (${ct.id.slice(0,6)}): ${ctDevices.map(d=>`${d.kind} terms=[${d.terminals.map(t=>t.name).join(',')}]`).join('; ')}`);
        const lk = ct.layers ? Object.keys(ct.layers).filter(k => (ct.layers as any)[k]?.length) : [];
        console.log(`  layers: ${lk.join(', ')}`);
      }
    } catch (e) {
      console.warn(`extractMarkedDevices("${ct.name}") failed:`, e);
      continue;
    }
    if (ctDevices.length === 0) continue;

    for (let inst = 0; inst < instanceList.length; inst++) {
      const instCell = instanceList[inst];
      for (const dev of ctDevices) {
        const p = pref[dev.kind] ?? "X";
        counters[p] = (counters[p] ?? 0) + 1;
        const instName = `${p}${counters[p]}`;

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

        // Compute terminal die-world positions from cell type layers
        // so the overlay can draw terminal labels (C/B/E) at actual shape centers.
        // Collect terminal positions per shape (not per terminal): a terminal
        // with two base contacts → two B labels, but one net.
        const termPoints: Array<{x:number;y:number;name:string}> = [];
        for (const t of dev.terminals) {
          const layerName = terminalLayerOf(dev.kind, t.name);
          if (!layerName) continue;
          const shapes = ct.layers?.[layerName as keyof typeof ct.layers] as LayerShape[] | undefined;
          if (!shapes) continue;
          for (const s of shapes) {
            const c = centerOfShape(s as any);
            if (c) termPoints.push({ x: cellCX + c.x, y: cellCY + c.y, name: t.name });
          }
        }

        allDevices.push({ ...dev, instanceName: instName, terminals: matchedTerms, bbox: worldBbox, _termPoints: termPoints } as AnalogDevice & { _termPoints: typeof termPoints });
        if (termPoints.length === 0 && inst === 0) {
          console.log(`[terms] ${instName} (${dev.kind}) ct=${ct.name}: 0 terminal shapes found. layers present:`, Object.keys(ct.layers ?? {}));
        }
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

// ── Terminal-position helpers ───────────────────────────────────

/** Map device kind + terminal name to the layer type that holds its shape. */
function terminalLayerOf(kind: DeviceKind, name: string): string | null {
  switch (kind) {
    case "bjt_npn": case "bjt_pnp":
      return { C: "collector", B: "base", E: "emitter" }[name] ?? null;
    case "mos":
      return { D: "drain", G: "gate", S: "source", B: "bulk" }[name] ?? null;
    default:
      return "contact";
  }
}

/** Return the centre of any LayerShape, or null if degenerate. */
function centerOfShape(s: LayerShape): { x: number; y: number } | null {
  switch (s.kind) {
    case "rect": return { x: s.x + s.width / 2, y: s.y + s.height / 2 };
    case "point": return { x: s.x, y: s.y };
    case "circle": return { x: s.x, y: s.y };
    case "polygon": {
      if (s.points.length === 0) return null;
      let sx = 0, sy = 0;
      for (const p of s.points) { sx += p.x; sy += p.y; }
      return { x: sx / s.points.length, y: sy / s.points.length };
    }
    case "line": return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
    default: return null;
  }
}
