/**
 * dieWideAnalog.ts — Die-wide analog device collection and export.
 *
 * Collects all analog devices across every cell type on a die,
 * matches terminals to die-level wires via segment-rectangle intersection,
 * and generates CDL/Spectre.
 *
 * ── Device detection architecture ─────────────────────────────────
 * Each device kind defines its terminal-to-layout-layer mapping in
 * DEVICE_TERMINAL_DEFS.  The resolveDeviceContacts() function then
 * handles all matching uniformly:
 *
 *   • point-in-shape: contact center must fall inside a layer shape
 *   • priority: for overlapping layers (BJT emitter⊂base), lowest
 *     priority number wins  (E=0, C=1, B=2)
 *   • shared layers: when two terminals map to the same layer (MOS
 *     D+S both on "diffusion"), contacts are round-robined among them
 *   • bulk exclusion (MOS): a contact on nwell/pwell counts as B only
 *     when it is NOT also on diffusion or polysilicon
 *   • no bbox gating: all contacts in the cell type are considered;
 *     well-cross contamination is harmless because all devices in the
 *     same well share the same bulk potential
 *
 * Adding a new device kind: just add a TerminalDef[] to DEVICE_TERMINAL_DEFS.
 */

import type {
  AnalogDevice, AnnotationNet, Cell, CellType,
  DeviceGeometryMOS, DeviceKind, DieAnnotations, IOPin,
  LayerShape, SpiceConfig,
} from "shared";
import { extractMarkedDevices, detectMOSFromLayers, consumeSegmentShapes } from "../lib/extraction/simpleAnalog";
import { isClipperLoaded } from "../lib/extraction/clipper";
import { generateSpiceNetlist } from "../lib/export/spice";

// ═════════════════════════════════════════════════════════════════
// Device terminal definitions
// ═════════════════════════════════════════════════════════════════

interface TerminalDef {
  name: string;
  /** Layout layers to search for shapes of this terminal. */
  layers: string[];
  /**
   * Overlap priority (lower = wins).  When two terminals' layers both
   * contain a contact (e.g. BJT emitter embedded in base), the terminal
   * with the lowest priority gets the contact.
   * Undefined = no special priority (contacts can match multiple terminals
   * for shared-layer round-robin).
   */
  priority?: number;
}

const BJT_DEFS: TerminalDef[] = [
  { name: "E", layers: ["emitter"], priority: 0 },
  { name: "C", layers: ["collector"], priority: 1 },
  { name: "B", layers: ["base", "bulk"], priority: 2 },
];

const MOS_DEFS: TerminalDef[] = [
  { name: "D", layers: ["diffusion"] },
  { name: "G", layers: ["polysilicon"] },
  { name: "S", layers: ["diffusion"] },
  { name: "B", layers: ["bulk", "nwell", "pwell"] },
];

const DEFAULT_2T_DEFS: TerminalDef[] = [
  { name: "PLUS", layers: ["contact"] },
  { name: "MINUS", layers: ["contact"] },
];

const DIODE_DEFS: TerminalDef[] = [
  // Diode anode (PLUS) = base/well, cathode (MINUS) = emitter.
  // Emitter is embedded in base → emitter gets higher priority
  // (lower number) so contacts on the emitter junction go to MINUS.
  { name: "PLUS", layers: ["base", "bulk"], priority: 1 },
  { name: "MINUS", layers: ["emitter"], priority: 0 },
];

// Record<DeviceKind, TerminalDef[]> but we use string-keyed for ergonomics
const DEVICE_TERMINAL_DEFS: Record<string, TerminalDef[]> = {
  bjt_npn: BJT_DEFS,
  bjt_pnp: BJT_DEFS,
  mos: MOS_DEFS,
  resistor: DEFAULT_2T_DEFS,
  capacitor: DEFAULT_2T_DEFS,
  diode: DIODE_DEFS,
  jfet_n: DEFAULT_2T_DEFS,
  jfet_p: DEFAULT_2T_DEFS,
  zener: DEFAULT_2T_DEFS,
  schottky: DEFAULT_2T_DEFS,
  inductor: DEFAULT_2T_DEFS,
  unknown: DEFAULT_2T_DEFS,
};

/** Build a name→TerminalDef lookup for a device kind. */
function terminalDefMap(kind: DeviceKind): Map<string, TerminalDef> {
  const defs = DEVICE_TERMINAL_DEFS[kind] ?? DEFAULT_2T_DEFS;
  const map = new Map<string, TerminalDef>();
  for (const d of defs) map.set(d.name, d);
  return map;
}

/** Detect if a device kind uses priority-based overlap resolution. */
function defsHavePriority(defs: Map<string, TerminalDef>): boolean {
  for (const [, d] of defs) if (d.priority !== undefined) return true;
  return false;
}

// ═════════════════════════════════════════════════════════════════
// Geometry helpers
// ═════════════════════════════════════════════════════════════════

function shapeBounds(s: LayerShape): {x:number;y:number;width:number;height:number} | null {
  switch (s.kind) {
    case "rect": return { x: s.x, y: s.y, width: s.width, height: s.height };
    case "point": return { x: s.x - s.size/2, y: s.y - s.size/2, width: s.size, height: s.size };
    case "circle": return { x: s.x - s.radius, y: s.y - s.radius, width: s.radius*2, height: s.radius*2 };
    case "polygon": {
      if (s.points.length === 0) return null;
      let mx = Infinity, my = Infinity, Mx = -Infinity, My = -Infinity;
      for (const p of s.points) { if (p.x<mx)mx=p.x; if(p.x>Mx)Mx=p.x; if(p.y<my)my=p.y; if(p.y>My)My=p.y; }
      return { x: mx, y: my, width: Mx-mx, height: My-my };
    }
    case "line": {
      return { x: Math.min(s.x1,s.x2), y: Math.min(s.y1,s.y2), width: Math.abs(s.x2-s.x1), height: Math.abs(s.y2-s.y1) };
    }
    default: return null;
  }
}

function centerOfShape(s: LayerShape): {x:number;y:number}|null {
  switch (s.kind) {
    case "rect": return { x: s.x + s.width/2, y: s.y + s.height/2 };
    case "point": return { x: s.x, y: s.y };
    case "circle": return { x: s.x, y: s.y };
    case "polygon": {
      if (s.points.length===0) return null;
      let sx=0,sy=0; for(const p of s.points){sx+=p.x;sy+=p.y;}
      return {x:sx/s.points.length, y:sy/s.points.length};
    }
    case "line": return { x: (s.x1+s.x2)/2, y: (s.y1+s.y2)/2 };
    default: return null;
  }
}

function rectsOverlap(ax1:number,ay1:number,ax2:number,ay2:number,
                       bx1:number,by1:number,bx2:number,by2:number): boolean {
  return ax1<bx2 && ax2>bx1 && ay1<by2 && ay2>by1;
}

/** Check if a point (px,py) is inside a shape (rect/polygon/circle/point/line). */
function pointInShape(px: number, py: number, s: LayerShape): boolean {
  switch (s.kind) {
    case "rect":
      return px >= s.x && px <= s.x + s.width && py >= s.y && py <= s.y + s.height;
    case "polygon": {
      const pts = s.points;
      if (pts.length < 3) return false;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, yi = pts[i].y;
        const xj = pts[j].x, yj = pts[j].y;
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
          inside = !inside;
      }
      return inside;
    }
    case "circle":
      return (px - s.x) ** 2 + (py - s.y) ** 2 <= s.radius * s.radius;
    case "point":
      return Math.abs(px - s.x) <= s.size / 2 && Math.abs(py - s.y) <= s.size / 2;
    case "line": {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) return (px - s.x1) ** 2 + (py - s.y1) ** 2 <= (s.width ?? 4) ** 2;
      let t = ((px - s.x1) * dx + (py - s.y1) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = s.x1 + t * dx, cy = s.y1 + t * dy;
      return (px - cx) ** 2 + (py - cy) ** 2 <= ((s.width ?? 4) / 2) ** 2;
    }
    default:
      return false;
  }
}

/** Line segment vs axis-aligned rectangle intersection test. */
function segmentIntersectsRect(
  x1:number, y1:number, x2:number, y2:number,
  rx:number, ry:number, rw:number, rh:number,
): boolean {
  const rmxx = rx + rw, rmyy = ry + rh;
  if (x1>=rx && x1<=rmxx && y1>=ry && y1<=rmyy) return true;
  if (x2>=rx && x2<=rmxx && y2>=ry && y2<=rmyy) return true;
  const chk = (ex1:number,ey1:number,ex2:number,ey2:number) => {
    const dcx=x2-x1,dcy=y2-y1, dex=ex2-ex1,dey=ey2-ey1;
    const d=dcx*dey-dcy*dex;
    if (Math.abs(d)<1e-9) return false;
    return (t=>t>=0&&t<=1)(((ex1-x1)*dey-(ey1-y1)*dex)/d) &&
           (u=>u>=0&&u<=1)(((ex1-x1)*dcy-(ey1-y1)*dcx)/d);
  };
  return chk(rx,ry,rmxx,ry)||chk(rmxx,ry,rmxx,rmyy)||chk(rmxx,rmyy,rx,rmyy)||chk(rx,rmyy,rx,ry);
}

// ═════════════════════════════════════════════════════════════════
// Terminal contact resolution
// ═════════════════════════════════════════════════════════════════

/**
 * Resolve which contacts belong to which terminals for a single device.
 *
 * Iterates dev.terminals (the real terminal order from the device) and
 * looks up each terminal's layer mapping from the device definition by
 * *name*, so the mapping is robust regardless of terminal ordering.
 *
 * Returns:
 *   - termPoints:  one entry per contact (for overlay display)
 *   - termContacts: contacts grouped by terminal index (for wire matching)
 */
function resolveDeviceContacts(
  dev: AnalogDevice,
  ctLayers: Record<string, LayerShape[] | undefined>,
  cx: number, cy: number,
): {
  termPoints: Array<{x:number;y:number;name:string}>;
  termContacts: Array<Array<{x:number;y:number}>>;
} {
  const defMap = terminalDefMap(dev.kind);
  const hasPri = defsHavePriority(defMap);
  const termContacts: Array<Array<{x:number;y:number}>> = dev.terminals.map(() => []);

  // ── Match each contact to its candidate terminal(s) ──────────
  // cTis: contact-shape id → set of matching DEV.terminal indices
  // cPos: contact-shape id → world-coordinate center point
  const allContactShapes = (ctLayers.contact ?? []) as LayerShape[];
  const cTis = new Map<string, Set<number>>();
  const cPos = new Map<string, {x:number;y:number}>();

  // For MOS bulk exclusion: layers that a well contact must NOT be on.
  // ("diffusion" and "polysilicon" — the active terminal layers)
  const mosOtherLayers: string[] = [];
  for (const [key, d] of defMap) {
    if (key === "B") continue;
    for (const l of d.layers) {
      if (!mosOtherLayers.includes(l)) mosOtherLayers.push(l);
    }
  }

  for (const cs of allContactShapes) {
    const cc = centerOfShape(cs as any);
    if (!cc) continue;

    // ── Find candidate (dev.terminal-index → priority) pairs ──
    const candidates: Array<{ti:number; pri:number}> = [];

    for (let ti = 0; ti < dev.terminals.length; ti++) {
      const termName = dev.terminals[ti].name;
      const termDef = defMap.get(termName);
      if (!termDef) continue; // terminal not in our definitions → skip

      let matched = false;
      for (const layer of termDef.layers) {
        const shapes = ctLayers[layer] as LayerShape[] | undefined;
        if (!shapes) continue;

        for (const shape of shapes) {
          // If the terminal knows which shapes belong to it, only
          // match contacts that land inside THOSE shapes.  This prevents
          // contacts from a different device in the same cell type from
          // leaking into this device's terminal resolution.
          const termShapeIds = dev.terminals[ti].shapeIds;
          if (termShapeIds && termShapeIds.length > 0 && !termShapeIds.includes(shape.id)) continue;

          const isInside = pointInShape(cc.x, cc.y, shape);
          if (shape.id.startsWith("mos_well") || shape.id.includes("_seg")) {
            console.log(`[analog] resolveContact dev=${dev.instanceName??dev.id} term=${termName} shape=${shape.id.slice(0,30)} (${shape.kind}) pt=(${cc.x.toFixed(1)},${cc.y.toFixed(1)}) => ${isInside ? "INSIDE" : "OUTSIDE"} shapeIds=${JSON.stringify(dev.terminals[ti].shapeIds)}`);
          }
          if (isInside) {
            // MOS B (bulk): contact must be EXCLUSIVELY on well layers —
            // if also on diffusion or polysilicon, it's an S/D/G contact.
            if (dev.kind === "mos" && termDef.name === "B") {
              const alsoOnOther = mosOtherLayers.some((otherLayer) => {
                const otherShapes = ctLayers[otherLayer] as LayerShape[] | undefined;
                return otherShapes?.some((s) => pointInShape(cc.x, cc.y, s)) ?? false;
              });
              if (alsoOnOther) continue; // skip B for this contact
            }
            candidates.push({ ti, pri: termDef.priority ?? 999 });
            matched = true;
            break;
          } else {
            if (shape.id.startsWith("mos_well") || shape.id.includes("_seg")) {
              console.log(`[analog]   OUTSIDE for term ${termName}`);
            }
          }
        }
        if (matched) break; // one match per layer = enough for this terminal
      }
    }

    if (candidates.length === 0) continue;

    // ── Resolve winner(s) ──────────────────────────────────────
    // Priority devices (BJT): keep only terminal(s) with the best
    //   (lowest) priority number.  This handles overlapping layers
    //   like emitter ⊂ base — E(p0) wins over B(p2).
    // Non-priority devices (MOS, 2T): keep ALL candidate terminals
    //   so shared-layer round-robin (D+S on diffusion) works.
    let selected: number[];
    if (hasPri) {
      const bestPri = Math.min(...candidates.map((c) => c.pri));
      selected = [...new Set(
        candidates.filter((c) => c.pri === bestPri).map((c) => c.ti),
      )];
    } else {
      selected = [...new Set(candidates.map((c) => c.ti))];
    }
    if (selected.length === 0) continue;

    // Record
    const wx = cx + cc.x, wy = cy + cc.y;
    if (!cPos.has(cs.id)) cPos.set(cs.id, { x: wx, y: wy });
    const set = cTis.get(cs.id) ?? new Set<number>();
    for (const ti of selected) set.add(ti);
    cTis.set(cs.id, set);
  }

  // ── Build termContacts (wire matching) with round-robin ──────
  const bySig = new Map<string, Array<{cid:string; cp:{x:number;y:number}}>>();
  for (const [cid, tis] of cTis) {
    const sig = [...tis].sort().map((ti) => dev.terminals[ti].name).join(",");
    const cp = cPos.get(cid)!;
    const list = bySig.get(sig) ?? [];
    list.push({ cid, cp });
    bySig.set(sig, list);
  }

  for (const [, contacts] of bySig) {
    const firstCid = contacts[0].cid;
    const firstTis = cTis.get(firstCid)!;
    const sig = [...firstTis].sort().map((ti) => dev.terminals[ti].name).join(",");
    const termIndices = sig.split(",").map((n) =>
      dev.terminals.findIndex((t) => t.name === n),
    ).filter((i) => i >= 0);

    if (termIndices.length <= 1) {
      // Unique layer → assign all contacts to that terminal.
      for (const { cp } of contacts) {
        termContacts[termIndices[0]].push({ x: cp.x, y: cp.y });
      }
    } else {
      // Shared layer (D+S for MOS, PLUS+MINUS for simple 2T devices) →
      // distribute round-robin so both terminals get contacts.
      for (let ci = 0; ci < contacts.length; ci++) {
        const ti = termIndices[ci % termIndices.length];
        termContacts[ti].push({ x: contacts[ci].cp.x, y: contacts[ci].cp.y });
      }
    }
  }

  // ── Build termPoints from termContacts (post-round-robin) ──
  // Each contact is now assigned to exactly one terminal by round-robin
  // (or unique assignment).  Using termContacts guarantees correct labels:
  // PLUS/MINUS for 2T devices, D/S for MOS (→S/D later), E/C/B for BJT.
  const termPoints: Array<{x:number;y:number;name:string}> = [];
  for (let ti = 0; ti < termContacts.length; ti++) {
    for (const cp of termContacts[ti]) {
      const wr = Math.round(cp.x), hr = Math.round(cp.y);
      const already = termPoints.some((p) => Math.round(p.x) === wr && Math.round(p.y) === hr);
      if (!already) {
        termPoints.push({ x: cp.x, y: cp.y, name: dev.terminals[ti].name });
      }
    }
  }

  return { termPoints, termContacts };
}

// ═════════════════════════════════════════════════════════════════
// Wire-to-terminal matching
// ═════════════════════════════════════════════════════════════════

/** Check if any wire segment passes within `tol` px of a point. */
function matchWireToPoint(
  nets: AnnotationNet[],
  px:number, py:number, tol:number,
  netIdMap: Map<string,number>,
  nextId: {v:number},
): number|null {
  const tol2 = tol*tol;
  for (const net of nets) {
    for (const edge of net.edges) {
      const a = net.nodes.find(n=>n.id===edge.from);
      const b = net.nodes.find(n=>n.id===edge.to);
      if (!a||!b) continue;
      const dx=b.x-a.x, dy=b.y-a.y;
      const len2=dx*dx+dy*dy;
      let t = len2===0 ? 0 : ((px-a.x)*dx+(py-a.y)*dy)/len2;
      t = Math.max(0,Math.min(1,t));
      const cx=a.x+t*dx, cy=a.y+t*dy;
      const dist2 = (cx-px)*(cx-px)+(cy-py)*(cy-py);
      if (dist2 <= tol2) {
        if (!netIdMap.has(net.id)) netIdMap.set(net.id, nextId.v++);
        return netIdMap.get(net.id)!;
      }
    }
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════
// Device extraction (marker + well-based)
// ═════════════════════════════════════════════════════════════════
// MOS is well-based only (nwell/pwell + diffusion + polysilicon).
// BJT, resistor, capacitor, diode are marker-based.

export function extractAnalogDevicesFromCellType(
  cellType: CellType, umPerPx: number,
): AnalogDevice[] {
  const marker = extractMarkedDevices(cellType.layers, cellType.id, umPerPx);
  const well = detectMOSFromLayers(cellType.layers, cellType.id, umPerPx);
  return [...well, ...marker];
}

// ═════════════════════════════════════════════════════════════════
// Main collection
// ═════════════════════════════════════════════════════════════════

export interface DieWideAnalogResult {
  devices: AnalogDevice[];
  /** netId → human-readable name (from IO pins and pin labels) */
  namedNets: Map<number, string>;
  /** Annotation-net UUID → numerical netId used in devices' terminals. */
  netIdMap: Map<string, number>;
  /** Warnings (unconnected terminals, auto-connected bulk, etc.) */
  warnings: string[];
}

export function collectDieWideAnalogDevices(
  annotations: DieAnnotations,
  umPerPx: number = 1.0,
  _spiceConfig?: SpiceConfig,
): DieWideAnalogResult {
  const ann = annotations as DieAnnotations;
  const allDevices: AnalogDevice[] = [];
  const nets = ann.nets ?? [];

  const cells = ann.cells ?? [];
  const instancesByCt = new Map<string, Cell[]>();
  for (const cell of cells) {
    const list = instancesByCt.get(cell.cellTypeId) ?? [];
    list.push(cell);
    instancesByCt.set(cell.cellTypeId, list);
  }

  const warnings: string[] = [];

  // Warn when Clipper2 is not loaded — poly gate grouping falls back
  // to shapeId-only dedup, which may miss connected poly shapes.
  if (!isClipperLoaded()) {
    warnings.push(
      "Clipper2 is not loaded — polysilicon gate net grouping uses shapeId-only " +
      "fallback. Connected poly shapes may not share a gate net. " +
      "Reload the page if Clipper was expected to be available."
    );
  }

  const netIdMap = new Map<string, number>();
  const nextNetId = { v: 100 };
  // Cache: cell instance + cell-level netId → die-level netId.
  // Ensures multiple devices in the same cell instance sharing the same
  // gate poly (e.g., G=1000 from polyGateNetMap) get one die-level net.
  const cellNetCache = new Map<string, number>();

  const counters: Record<string,number> = {};
  const pref: Record<string,string> = {
    bjt_npn:"Q",bjt_pnp:"Q",mos:"M",resistor:"R",capacitor:"C",diode:"D",
    jfet_n:"J",jfet_p:"J",unknown:"X",
  };

  for (const ct of ann.cellTypes) {
    const instanceList = instancesByCt.get(ct.id)??[];
    if (instanceList.length===0) continue;

    let ctDevices: AnalogDevice[];
    try {
      ctDevices = extractAnalogDevicesFromCellType(ct, umPerPx);
    } catch(e) { console.warn(`extractAnalogDevicesFromCellType("${ct.name}") failed:`,e); continue; }
    if (ctDevices.length===0) continue;

    for (let inst=0; inst<instanceList.length; inst++) {
      const instCell = instanceList[inst];
      for (const dev of ctDevices) {
        const prefx = pref[dev.kind]??"X";
        counters[prefx] = (counters[prefx]??0) + 1;
        const instName = `${prefx}${counters[prefx]}`;
        const cx = instCell?.x??0, cy = instCell?.y??0;

        const worldBbox = dev.bbox
          ? { ...dev.bbox, x: dev.bbox.x+cx, y: dev.bbox.y+cy }
          : dev.bbox;

        // ── Inject synthetic segment shapes (multi-finger MOS) ──
        // When detectMOSFromLayers splits a diffusion via Clipper2,
        // it caches synthetic polygon shapes. Inject them into
        // ctLayers so resolveDeviceContacts can find the correct
        // segment polygons for D/S contact matching.
        const segShapes = consumeSegmentShapes(dev.id);
        if (segShapes.length > 0) {
          console.log(`[analog] injecting ${segShapes.length} segment shapes for ${dev.instanceName ?? dev.id}`);
        }
        const layersWithSegs = segShapes.length > 0
          ? {
              ...ct.layers,
              diffusion: [
                ...((ct.layers as Record<string, LayerShape[] | undefined>).diffusion ?? []),
                ...segShapes,
              ],
            } as Record<string, LayerShape[] | undefined>
          : (ct.layers as Record<string, LayerShape[] | undefined>);

        // ── Resolve which contacts belong to which terminals ──
        // Uses the unified resolveDeviceContacts() which handles all
        // device types (BJT priority E>C>B, MOS shared D/S, bulk
        // exclusion, name-based terminal-to-def resolution).
        const { termPoints, termContacts } = resolveDeviceContacts(
          dev,
          layersWithSegs,
          cx, cy,
        );

        // ── Wire matching by contact proximity (10px) ────────
        const matchedTerms = dev.terminals.map((t,ti)=>{
          if (t.netId < 0 && dev.kind === "mos" && t.name === "B") {
            // No well contact (or not resolved) → bulk = global supply
            const mosType = (dev.geometry as DeviceGeometryMOS)?.mosType;
            const vddNames = [
              _spiceConfig?.vdd ?? "VDD",
              "VCC", "vcc", "VDD", "vdd",
            ];
            const gndNames = [
              _spiceConfig?.gnd ?? "GND",
              "VSS", "vss", "GND", "gnd",
            ];
            const targetNames = mosType === "pmos" ? vddNames : gndNames;
            const supplyName = targetNames[0];

            // 1) Check annotated net names
            let foundNetId: number | null = null;
            for (const n of nets) {
              if (n.name && targetNames.includes(n.name)) {
                if (!netIdMap.has(n.id)) netIdMap.set(n.id, nextNetId.v++);
                foundNetId = netIdMap.get(n.id)!;
                break;
              }
            }

            // 2) Check IO pin names
            if (foundNetId == null) {
              const pins = ann.pins ?? [];
              for (const pin of pins) {
                if (targetNames.includes(pin.name)) {
                  const pinNetId = matchWireToPoint(nets, pin.x, pin.y, 10, netIdMap, nextNetId);
                  if (pinNetId != null) {
                    foundNetId = pinNetId;
                    break;
                  }
                }
              }
            }

            if (foundNetId != null) {
              warnings.push(
                `${instName} (${mosType.toUpperCase()}): bulk has no well contact — auto-connected to global ${supplyName}`
              );
              return {...t, netId: foundNetId};
            }

            // 3) No net found → use or create a global supply net.
            // Dedup: all devices without a well contact share the same
            // global supply net (_global_VDD or _global_GND) so their
            // bulk terminals are shorted together (correct: they are in
            // the same well diffusion region conceptually).
            let freshId = netIdMap.get(`_global_${supplyName}`);
            if (freshId == null) {
              freshId = nextNetId.v++;
              netIdMap.set(`_global_${supplyName}`, freshId);
            }
            warnings.push(
              `${instName} (${mosType.toUpperCase()}): bulk has no well contact — auto-connected to global ${supplyName}`
            );
            return {...t, netId: freshId};
          }
          if (t.netId < 0) {
            const fresh = 2000 + allDevices.length*10 + ti;
            return {...t, netId: fresh};
          }
          // ── Cell-level net dedup cache ────────────────────────
          // Devices in the same cell instance sharing a cell-level netId
          // (e.g. G=1000 from polyGateNetMap) must map to one die-level net.
          const cacheKey = `${instCell.id}:${t.netId}`;
          const cachedDieNet = cellNetCache.get(cacheKey);
          if (cachedDieNet !== undefined) {
            console.log(`[analog] cellNetCache HIT inst=${instCell.id} cellNet=${t.netId} → dieNet=${cachedDieNet} for ${instName}.${dev.terminals[ti].name}`);
            return {...t, netId: cachedDieNet};
          }
          const contacts = termContacts[ti];
          // contacts.length === 0 — no contact centers
          for (const cp of contacts) {
            const wid = matchWireToPoint(nets, cp.x, cp.y, 10, netIdMap, nextNetId);
            if (wid!=null) {
              cellNetCache.set(cacheKey, wid);
              return {...t, netId: wid};
            }
          }
          const fresh = 2000 + allDevices.length*10 + ti;
          cellNetCache.set(cacheKey, fresh);
          return {...t, netId: fresh};
        });

        // ── MOS: D/S termPoints keep their original names for net lookup ─
        // The overlay relabels "D"/"S" to "S/D" at draw time.
        // Storing as-is preserves the terminal distinction for correct
        // netId resolution per contact.

        allDevices.push({
          ...dev,
          instanceName: instName, terminals: matchedTerms, bbox: worldBbox,
          _termPoints: termPoints,
          _cellId: instCell.id,
        } as AnalogDevice & { _termPoints: typeof termPoints; _cellId: string });
      }
    }
  }

  // ── Build namedNets: annotation net names + IO pin names ────
  const namedNets = new Map<number, string>();
  for (const aNet of nets) {
    const spiceId = netIdMap.get(aNet.id);
    if (spiceId != null && aNet.name) {
      namedNets.set(spiceId, aNet.name);
    }
  }
  const pins = ann.pins ?? [];
  for (const pin of pins) {
    const netId = matchWireToPoint(nets, pin.x, pin.y, 10, netIdMap, nextNetId);
    if (netId != null) {
      if (!namedNets.has(netId)) namedNets.set(netId, pin.name);
    }
  }

  // Register fresh global supply nets (_global_VDD, _global_GND) as named nets
  for (const [key, id] of netIdMap) {
    if (key.startsWith("_global_")) {
      const name = key.slice("_global_".length);
      if (!namedNets.has(id)) namedNets.set(id, name);
    }
  }

  return { devices: allDevices, namedNets, netIdMap, warnings };
}

// ═════════════════════════════════════════════════════════════════
// Export pipeline
// ═════════════════════════════════════════════════════════════════

export function detectAndExportDieWide(
  annotations: DieAnnotations,
  moduleName: string,
  dialect: "cdl"|"spectre"|"hspice" = "cdl",
  spiceConfig?: SpiceConfig,
) {
  const { devices, namedNets, warnings: deviceWarnings } = collectDieWideAnalogDevices(annotations, spiceConfig?.umPerPx??1.0, spiceConfig);
  const result = generateSpiceNetlist(devices, moduleName, spiceConfig??{}, dialect, namedNets);
  return { devices, text: result.text, byKind: result.byKind, totalDevices: result.totalDevices, warnings: [...deviceWarnings, ...result.warnings] };
}
