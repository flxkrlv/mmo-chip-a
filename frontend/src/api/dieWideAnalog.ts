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

        // 1. Compute contact-level terminal positions.
        //    Each contact is tagged with which terminals it overlaps.
        //    Shared contacts → used for LABELS only.
        //    Unique contacts → used for wire matching (prevents accidental B/E shorting).
        const termPoints: Array<{x:number;y:number;name:string;cid:string}> = [];
        const allContacts = (ct.layers?.contact ?? []) as LayerShape[];
        const contactTis = new Map<string, Set<number>>();
        const contactPos = new Map<string, {x:number;y:number}>(); // contact id → cell-local centre

        for (let ti = 0; ti < dev.terminals.length; ti++) {
          const t = dev.terminals[ti];
          const layerNames = terminalLayersOf(dev.kind, t.name);
          for (const layerName of layerNames) {
            const termShapes = ct.layers?.[layerName as keyof typeof ct.layers] as LayerShape[] | undefined;
            if (!termShapes) continue;
            for (const ts of termShapes) {
              const tb = shapeBounds(ts);
              if (!tb) continue;
              for (const cs of allContacts) {
                const cb = shapeBounds(cs);
                if (!cb) continue;
                if (rectsOverlap(tb.x, tb.y, tb.x+tb.width, tb.y+tb.height,
                                  cb.x, cb.y, cb.x+cb.width, cb.y+cb.height)) {
                  const cc = centerOfShape(cs as any);
                  if (cc) {
                    termPoints.push({ x: cellCX + cc.x, y: cellCY + cc.y, name: t.name, cid: cs.id });
                    const set = contactTis.get(cs.id) ?? new Set();
                    set.add(ti);
                    contactTis.set(cs.id, set);
                    if (!contactPos.has(cs.id)) contactPos.set(cs.id, cc);
                  }
                }
              }
            }
          }
        }

        // Per-terminal centre for wire matching — only unique contacts.
        const termCenters: Array<{x:number;y:number}|null> = dev.terminals.map(() => null);
        for (let ti = 0; ti < dev.terminals.length; ti++) {
          let sx = 0, sy = 0, n = 0;
          for (const [cid, tis] of contactTis) {
            if (tis.size !== 1 || !tis.has(ti)) continue;
            const cp = contactPos.get(cid);
            if (!cp) continue;
            sx += cp.x; sy += cp.y; n++;
          }
          if (n > 0) termCenters[ti] = { x: cellCX + sx/n, y: cellCY + sy/n };
        }

        // 2. Match each terminal to a die-level wire using ACTUAL contact
        //    positions, not bbox interpolation. Fall back to bbox centre if
        //    no contacts found for a terminal.
        const matchedTerms = dev.terminals.map((t, ti) => {
          if (t.netId < 0) return t;
          const tc = termCenters[ti];
          let mx: number, my: number;
          if (tc) {
            mx = tc.x; my = tc.y;
          } else if (dev.bbox) {
            // Fallback: bbox interpolation
            mx = cellCX + dev.bbox.x + dev.bbox.width * (ti + 0.5) / (dev.terminals.length + 1);
            my = cellCY + dev.bbox.y + dev.bbox.height * 0.5;
          } else {
            const fresh = 2000 + allDevices.length * 10 + ti;
            return { ...t, netId: fresh };
          }
          const wireNetId = matchWireNetId(nets, mx, my, 80);
          if (wireNetId != null) return { ...t, netId: wireNetId };
          const fresh = 2000 + allDevices.length * 10 + ti;
          return { ...t, netId: fresh };
        });

        allDevices.push({ ...dev, instanceName: instName, terminals: matchedTerms, bbox: worldBbox, _termPoints: termPoints.map(p=>({x:p.x,y:p.y,name:p.name})) } as AnalogDevice & { _termPoints: Array<{x:number;y:number;name:string}> });
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

/** Map device kind + terminal name to the layer type(s) that hold its shape.
 *  Returns primary then fallback layers — so a BJT base checks "base" first,
 *  then "bulk" if the user drew the base with the bulk tool. */
function terminalLayersOf(kind: DeviceKind, name: string): string[] {
  switch (kind) {
    case "bjt_npn": case "bjt_pnp": {
      const bjt: Record<string, string[]> = {
        C: ["collector"],
        B: ["base", "bulk"],
        E: ["emitter"],
      };
      return bjt[name] ?? [];
    }
    case "mos": {
      const mos: Record<string, string[]> = {
        D: ["drain"],
        G: ["gate"],
        S: ["source"],
        B: ["bulk"],
      };
      return mos[name] ?? [];
    }
    default:
      return ["contact"];
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

/** Axis-aligned bounding box of a LayerShape. */
function shapeBounds(s: LayerShape): {x:number;y:number;width:number;height:number} | null {
  switch (s.kind) {
    case "rect": return { x: s.x, y: s.y, width: s.width, height: s.height };
    case "point": return { x: s.x - s.size/2, y: s.y - s.size/2, width: s.size, height: s.size };
    case "circle": return { x: s.x - s.radius, y: s.y - s.radius, width: s.radius*2, height: s.radius*2 };
    case "polygon": {
      if (s.points.length === 0) return null;
      let mx = Infinity, my = Infinity, Mx = -Infinity, My = -Infinity;
      for (const p of s.points) {
        if (p.x < mx) mx = p.x; if (p.x > Mx) Mx = p.x;
        if (p.y < my) my = p.y; if (p.y > My) My = p.y;
      }
      return { x: mx, y: my, width: Mx - mx, height: My - my };
    }
    case "line": {
      const x1=Math.min(s.x1,s.x2), x2=Math.max(s.x1,s.x2);
      const y1=Math.min(s.y1,s.y2), y2=Math.max(s.y1,s.y2);
      return { x: x1, y: y1, width: x2-x1, height: y2-y1 };
    }
    default: return null;
  }
}

function rectsOverlap(ax1:number, ay1:number, ax2:number, ay2:number,
                       bx1:number, by1:number, bx2:number, by2:number): boolean {
  return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
}
