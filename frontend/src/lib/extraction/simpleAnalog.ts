/**
 * simpleAnalog.ts — Маркерная + well-based аналоговая детекция.
 *
 * Два режима работы:
 *
 * 1. extractMarkedDevices() — маркерная детекция.
 *    Пользователь явно рисует слои-маркеры устройств
 *    (npn_id, pnp_id, res_id, cap_id, diode_id).
 *    Детекция смотрит на слои внутри bbox маркера.
 *
 * 2. detectMOSFromLayers() — well-based MOS детекция.
 *    Автоматически находит MOS по nwell/pwell + diffusion + polysilicon.
 *    Для multi-finger (fingers > 1) использует Clipper2 polygonDifference()
 *    для разрезания диффузии между затворами (splitDiffusionAtGates).
 *
 * NPN:  npn_id + collector + base + emitter
 * RES:  res_id + body + contact×2
 * CAP:  cap_id + capacitor_bottom + capacitor_top
 * DIO:  diode_id
 *
 * Diode from BJT without collector:
 *   npn_id/pnp_id + base + emitter (no collector) → diode
 *   base = anode (PLUS), emitter = cathode (MINUS)
 *   AE/PE from base-emitter overlap (same as BJT)
 *
 * MOS:  nwell/pwell + diffusion + polysilicon + contact (well tap)
 *   Clipper2 diff split for ALL MOS (1 or N gates)
 *   single-finger: 1 gate → 2 segments (S and D)
 *   multi-finger:  N gates → N+1 segments → N devices (one per gate)
 */

import type {
  AnalogDevice, CellLayers, DeviceGeometry,
  DeviceGeometryMOS, DeviceKind, DeviceTerminal, LayerShape,
  ResistorType,
} from "shared";
import { polygonBounds, rectsIntersect } from "../geometry";
import type { Point, Rect } from "../geometry";
import {
  getClipper,
  isClipperLoaded,
  polygonDifference,
  polygonInflate,
  polygonIntersection,
  polygonsIntersect,
  ringSignedArea,
} from "./clipper";
import { shapeToPolygon, UnionFind } from "./common";
import { effectiveSheetR } from "../export/resistorDefaults";

/**
 * Module-level cache: device ID → synthetic segment LayerShapes created by
 * Clipper2 diffusion splitting for MOS. The die-level pipeline
 * (dieWideAnalog.ts) reads these shapes and injects them into ctLayers so
 * resolveDeviceContacts can find the correct segment polygons.
 *
 * IMPORTANT: this cache is populated ONCE per cell type (during
 * extractAnalogDevicesFromCellType) but queried N times — once per cell
 * instance. We NEVER delete entries so every instance gets the shapes.
 */
export const _segmentShapesCache = new Map<string, LayerShape[]>();
export function consumeSegmentShapes(
  _deviceId: string,
): LayerShape[] {
  // Return stored shapes without deleting — the same cell type may be
  // instantiated multiple times on the die (clones/merged cells) and each
  // instance needs the same synthetic segment shapes.
  return _segmentShapesCache.get(_deviceId) ?? [];
}

// ── Net ID generation ────────────────────────────────────────────
// Each call to extractMarkedDevices gets fresh unique net IDs.
let _nextNet = 1000;
export function resetDummyNets() { _nextNet = 1000; }
export function nextNet(): number { return _nextNet++; }

// ── Shape helpers ────────────────────────────────────────────────

function shapeBbox(s: LayerShape): Rect | null {
  if ("kind" in s) {
    switch (s.kind) {
      case "rect":
        return { x: s.x, y: s.y, width: s.width, height: s.height };
      case "point":
        return {
          x: s.x - s.size, y: s.y - s.size,
          width: s.size * 2, height: s.size * 2,
        };
      case "circle":
        return { x: s.x - s.radius, y: s.y - s.radius, width: s.radius * 2, height: s.radius * 2 };
      case "polygon":
        return polygonBounds(s.points);
      case "line": {
        const hw = (s.width as number) ?? 4;
        const lx1 = Math.min(s.x1, s.x2), lx2 = Math.max(s.x1, s.x2);
        const ly1 = Math.min(s.y1, s.y2), ly2 = Math.max(s.y1, s.y2);
        return { x: lx1 - hw/2, y: ly1 - hw/2, width: (lx2 - lx1) + hw, height: (ly2 - ly1) + hw };
      }
    }
  }
  return null;
}

function overlapArea(a: Rect, b: Rect): number {
  const ox = Math.max(a.x, b.x);
  const oy = Math.max(a.y, b.y);
  const ox2 = Math.min(a.x + a.width, b.x + b.width);
  const oy2 = Math.min(a.y + a.height, b.y + b.height);
  if (ox >= ox2 || oy >= oy2) return 0;
  return (ox2 - ox) * (oy2 - oy);
}

/** Intersection rectangle of two bounding boxes, or null if disjoint. */
function intersectionBbox(a: Rect, b: Rect): Rect | null {
  const ix = Math.max(a.x, b.x);
  const iy = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.width, b.x + b.width);
  const iy2 = Math.min(a.y + a.height, b.y + b.height);
  if (ix >= ix2 || iy >= iy2) return null;
  return { x: ix, y: iy, width: ix2 - ix, height: iy2 - iy };
}

function shapesInside(
  layers: CellLayers | undefined,
  targetLayer: string,
  container: Rect,
): LayerShape[] {
  if (!layers) return [];
  const shapes = (layers as Record<string, LayerShape[] | undefined>)[targetLayer];
  if (!shapes) return [];
  return shapes.filter((s) => {
    const b = shapeBbox(s);
    return (
      b && b.x >= container.x && b.y >= container.y &&
      b.x + b.width <= container.x + container.width &&
      b.y + b.height <= container.y + container.height
    );
  });
}

interface DeviceBox {
  id: string;
  kind: DeviceKind;
  bbox: Rect;
}

function findMarkers(layers: CellLayers | undefined): DeviceBox[] {
  if (!layers) return [];
  const boxes: DeviceBox[] = [];
  const markerMap: Record<string, DeviceKind> = {
    npn_id: "bjt_npn",
    pnp_id: "bjt_pnp",
    lpnp_id: "bjt_pnp",
    vpnp: "unknown",
    cap_id: "capacitor",
    diode_id: "diode",
  };
  for (const [layerId, shapes] of Object.entries(layers)) {
    const kind = markerMap[layerId];
    if (!kind || !shapes) continue;
    for (const s of shapes) {
      const bbox = shapeBbox(s);
      if (bbox) boxes.push({ id: s.id, kind, bbox });
    }
  }
  return boxes;
}

// ═════════════════════════════════════════════════════════════════
// Main extraction
// ═════════════════════════════════════════════════════════════════

export function extractMarkedDevices(
  layers: CellLayers | undefined,
  cellTypeId: string,
  umPerPx: number,
): AnalogDevice[] {
  resetDummyNets();
  let counter = 0;
  const devices: AnalogDevice[] = [];
  const markers = findMarkers(layers);
  const prefixMap: Record<string, string> = {
    bjt_npn: "Q", bjt_pnp: "Q",
    resistor: "R", capacitor: "C", diode: "D",
  };

  for (const marker of markers) {
    counter++;
    const devId = `analog_${marker.kind}_${counter}`;
    const prefix = prefixMap[marker.kind] ?? "X";

    switch (marker.kind) {
      // ── BJT / Diode-from-BJT ────────────────────────────────
      case "bjt_npn":
      case "bjt_pnp": {
        const collectors = shapesInside(layers, "collector", marker.bbox);
        let bases = shapesInside(layers, "base", marker.bbox);
        if (bases.length === 0) bases = shapesInside(layers, "bulk", marker.bbox);
        const emitters = shapesInside(layers, "emitter", marker.bbox);

        function terminalNet(terminalShapes: LayerShape[]): number {
          if (terminalShapes.length === 0) return -1;
          // Check for contact overlap → connected net
          const allContacts = (layers as Record<string, LayerShape[]>)?.["contact"] ?? [];
          for (const ts of terminalShapes) {
            const tb = shapeBbox(ts);
            if (!tb) continue;
            const hasContact = allContacts.some((c) => {
              const cb = shapeBbox(c);
              return cb && overlapArea(tb, cb) > 0;
            });
            if (hasContact) return nextNet();
          }
          return nextNet(); // still give it a net even without contact
        }

        // ── Diode from BJT without collector ───────────────────
        // npn_id/pnp_id + base + emitter but NO collector → diode.
        // Anode = base (PLUS), Cathode = emitter (MINUS).
        // AE/PE from base-emitter junction (same computation as BJT).
        if (collectors.length === 0 && bases.length > 0 && emitters.length > 0) {
          let totalAE = 0;
          const emitterCount = Math.max(emitters.length, 1);
          for (const emitS of emitters) {
            const eb = shapeBbox(emitS);
            if (!eb) { totalAE += 0; continue; }
            let emitterArea = 0;
            for (const baseS of bases) {
              const bb = shapeBbox(baseS);
              if (!bb) continue;
              const a = overlapArea(bb, eb);
              if (a > emitterArea) emitterArea = a;
            }
            totalAE += emitterArea;
          }
          const perFingerAE_um2 = totalAE / emitterCount * umPerPx * umPerPx;
          let peUm = 0;
          for (const emitS of emitters) {
            const eb = shapeBbox(emitS);
            if (!eb) continue;
            peUm += 2 * (eb.width + eb.height) * umPerPx;
          }
          // Both NPN and PNP base-emitter is always a PN junction.
          const diodeType = "pn" as const;

          devices.push({
            id: devId,
            kind: "diode",
            geometry: {
              area_um2: perFingerAE_um2,
              perimeter_um: peUm,
              multiplier: emitterCount,
              diodeType,
            },
            cellTypeId,
            instanceName: `${prefixMap.diode}${counter}`,
            modelName: "D_GEN",
            terminals: [
              { name: "PLUS", netId: terminalNet(bases), shapeIds: bases.map(s => s.id) },
              { name: "MINUS", netId: terminalNet(emitters), shapeIds: emitters.map(s => s.id) },
            ],
            bbox: marker.bbox,
            ...(marker.id ? { _markerShapeId: marker.id } : {}),
          });
          break; // done — don't fall through to BJT
        }

        // ── BJT ───────────────────────────────────────────────
        let totalAE = 0;
        const emitterCount = Math.max(emitters.length, 1);
        const isLpnp = emitters.length > 0 && bases.length === 0;
        if (isLpnp) {
          // LPnp: AE = raw emitter area.
          for (const emitS of emitters) {
            const eb = shapeBbox(emitS);
            if (!eb) continue;
            totalAE += eb.width * eb.height;
          }
        } else {
          // Standard BJT: AE = overlap(base, emitter).
          for (const emitS of emitters) {
            const eb = shapeBbox(emitS);
            if (!eb) { totalAE += 0; continue; }
            let emitterArea = 0;
            for (const baseS of bases) {
              const bb = shapeBbox(baseS);
              if (!bb) continue;
              const a = overlapArea(bb, eb);
              if (a > emitterArea) emitterArea = a;
            }
            totalAE += emitterArea;
          }
        }
        const perFingerAE_um2 = totalAE / emitterCount * umPerPx * umPerPx;

        // PE: for LPnp = emitter perimeter (inner edge of collector ring ≈
        // emitter perimeter). For NPN/VPNP stays 0 (not dominant).
        let peUm = 0;
        if (isLpnp || (bases.length > 0 && emitters.length > 0)) {
          for (const emitS of emitters) {
            const eb = shapeBbox(emitS);
            if (!eb) continue;
            peUm += 2 * (eb.width + eb.height) * umPerPx;
          }
        }

        devices.push({
          id: devId,
          kind: marker.kind,
          geometry: {
            AE_um2: perFingerAE_um2,
            PE_um: peUm,
            multiplier: emitterCount,
            totalAE_um2: totalAE * umPerPx * umPerPx,
            emitterFingers: Math.max(emitters.length, 1),
            bjtType: marker.kind === "bjt_npn" ? ("npn" as const) : ("pnp" as const),
          },
          cellTypeId,
          instanceName: `${prefix}${counter}`,
          modelName: marker.kind === "bjt_npn" ? "NPN_GEN" : "PNP_GEN",
          terminals: [
            { name: "C", netId: terminalNet(collectors), shapeIds: collectors.map(s => s.id) },
            { name: "B", netId: terminalNet(bases), shapeIds: bases.map(s => s.id) },
            { name: "E", netId: terminalNet(emitters), shapeIds: emitters.map(s => s.id) },
          ],
          bbox: marker.bbox,
          ...(marker.id ? { _markerShapeId: marker.id } : {}),
        });
        break;
      }

      // ── Resistor ─────────────────────────────────────────────
      // Body layer → resistor type mapping:
      //   poly     → "poly" (default polysilicon)
      //   base     → "pb"  (p base diffusion)
      //   emitter  → "npl" (n+ emitter = n+ diffusion)
      //   hsr      → "hsr" (ion implanted)
      //   film     → "film" (thin film)
      //   resistor_body → "poly" (backward compat, fallback)
      case "resistor": {
        const BODY_LAYERS: Array<{ layer: string; type: string }> = [
          { layer: "poly", type: "poly" },
          { layer: "polysilicon", type: "poly" },
          { layer: "base", type: "pb" },
          { layer: "emitter", type: "npl" },
          { layer: "hsr", type: "hsr" },
          { layer: "film", type: "film" },
          { layer: "resistor_body", type: "poly" },
        ];
        let bodyShapes: LayerShape[] = [];
        let resistorType = "poly";
        for (const bl of BODY_LAYERS) {
          const s = shapesInside(layers, bl.layer as any, marker.bbox);
          if (s.length > 0) {
            bodyShapes = s;
            resistorType = bl.type;
            break;
          }
        }

        const contacts = shapesInside(layers, "contact", marker.bbox);

        // Compute from polyline if lines exist, otherwise from bbox
        let L_um = 0, W_um = 0, squares = 0, corners = 0;
        const lines = bodyShapes.filter(s=>s.kind==="line") as Array<{kind:"line";x1:number;y1:number;x2:number;y2:number;width:number}>;
        if (lines.length > 0) {
          // Polyline mode: sum segment lengths, count corners
          let totalL = 0;
          W_um = (lines[0].width || 4) * umPerPx;
          let prevAngle: number|null = null;
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
            const segLen = Math.sqrt(dx*dx + dy*dy);
            totalL += segLen;
            if (i > 0) {
              const angle = Math.atan2(dy, dx);
              if (prevAngle != null && Math.abs(angle - prevAngle) > Math.PI/6) corners++;
              prevAngle = angle;
            } else {
              prevAngle = Math.atan2(dy, dx);
            }
          }
          L_um = totalL * umPerPx;
          squares = (totalL - corners * lines[0].width) / lines[0].width + 0.55 * corners;
        } else {
          // Bbox fallback
          W_um = marker.bbox.width * umPerPx;
          L_um = marker.bbox.height * umPerPx;
          squares = (W_um > 0 && L_um > 0) ? Math.max(L_um, W_um) / Math.min(L_um, W_um) : 0;
        }

        // ── Split contacts by body-INTERACT-ME1-INTERACT-contact ──
        // Contacts don't physically overlap the body polyline — they
        // connect via ME1 which overlaps the body.  Find ME1 shapes
        // intersecting the body, then find contacts inside those ME1
        // shapes.  Group contacts by UF-connected ME1 components.
        let plusContactIds: string[] = [];
        let minusContactIds: string[] = [];

        if (contacts.length >= 2 && bodyShapes.length > 0) {
          const bodyPolys = bodyShapes.map((s) => shapeToPolygon(s));
          const allMe1 = (layers as Record<string, LayerShape[] | undefined>)?.metal1 ?? [];
          // Find ME1 polygons intersecting the resistor body.
          const me1Hits: Array<{ idx: number; poly: Point[]; ctIds: Set<string> }> = [];
          for (let mi = 0; mi < allMe1.length; mi++) {
            const me1Poly = shapeToPolygon(allMe1[mi]);
            const hitsBody = bodyPolys.some((bp) => polygonsIntersect(bp, me1Poly));
            if (!hitsBody) continue;
            const ctIds = new Set(
              contacts
                .filter((c) => polygonsIntersect(me1Poly, shapeToPolygon(c)))
                .map((c) => c.id),
            );

            me1Hits.push({ idx: mi, poly: me1Poly, ctIds });
          }
          // Union-find: ME1 shapes that overlap each other are connected.
          const uf = new UnionFind(me1Hits.length);
          for (let i = 0; i < me1Hits.length; i++) {
            for (let j = i + 1; j < me1Hits.length; j++) {
              if (polygonsIntersect(me1Hits[i].poly, me1Hits[j].poly)) {
                uf.union(i, j);
              }
            }
          }
          // Group contact IDs by UF component.
          const compCts = new Map<number, Set<string>>();
          for (let i = 0; i < me1Hits.length; i++) {
            const r = uf.find(i);
            const set = compCts.get(r) ?? new Set();
            for (const id of me1Hits[i].ctIds) set.add(id);
            compCts.set(r, set);
          }
          const groups = [...compCts.values()].filter((s) => s.size > 0);

          if (groups.length >= 2) {
            // Compute body bbox once for axis determination.
            let bbox: Rect | null = null;
            for (const s of bodyShapes) {
              const b = shapeBbox(s);
              if (!b) continue;
              if (!bbox) { bbox = { ...b }; continue; }
              const x2 = Math.max(bbox.x + bbox.width, b.x + b.width);
              const y2 = Math.max(bbox.y + bbox.height, b.y + b.height);
              bbox.x = Math.min(bbox.x, b.x);
              bbox.y = Math.min(bbox.y, b.y);
              bbox.width = x2 - bbox.x;
              bbox.height = y2 - bbox.y;
            }
            if (bbox) {
              const sortByX = bbox.width >= bbox.height;
              groups.sort((a, b) => {
                // Position by first contact's centroid.
                const firstA = contacts.find((c) => a.has(c.id));
                const firstB = contacts.find((c) => b.has(c.id));
                const ba = firstA ? shapeBbox(firstA) : null;
                const bb = firstB ? shapeBbox(firstB) : null;
                if (!ba || !bb) return 0;
                return sortByX
                  ? ba.x + ba.width / 2 - (bb.x + bb.width / 2)
                  : ba.y + ba.height / 2 - (bb.y + bb.height / 2);
              });
              plusContactIds = [...groups[0]];
              minusContactIds = [...groups[1]];

            }
          }
        }
        if (plusContactIds.length === 0) {
          plusContactIds = contacts.map((c) => c.id);

        }
        if (minusContactIds.length === 0) {
          minusContactIds = contacts.map((c) => c.id);

        }

        devices.push({
          id: devId,
          kind: "resistor",
          geometry: {
            L_um,
            W_um,
            squares,
            resistance_ohms: squares * effectiveSheetR(resistorType as ResistorType, undefined),
            fingers: 1,
            multiplier: 1,
            shape: lines.length > 0 ? "meander" : "straight",
            resistorType: resistorType as any,
          },
          cellTypeId,
          instanceName: `${prefix}${counter}`,
          modelName: "RES_GEN",
          terminals: [
            { name: "PLUS", netId: plusContactIds.length > 0 ? nextNet() : -1, shapeIds: plusContactIds },
            { name: "MINUS", netId: minusContactIds.length > 0 ? nextNet() : -1, shapeIds: minusContactIds },
          ],
          bbox: marker.bbox,
          ...(marker.id ? { _markerShapeId: marker.id } : {}),
        });
        
        break;
      }

      // ── Capacitor ────────────────────────────────────────────
      case "capacitor": {
        const area = marker.bbox.width * marker.bbox.height * umPerPx * umPerPx;
        const capContacts = shapesInside(layers, "contact", marker.bbox);
        const capContactIds = capContacts.map(c => c.id);
        devices.push({
          id: devId,
          kind: "capacitor",
          geometry: {
            area_um2: area,
            perimeter_um: area > 0 ? Math.sqrt(area) * 4 : 0,
            capacitance_fF: area * 1,
            multiplier: 1,
            capType: "unknown",
          },
          cellTypeId,
          instanceName: `${prefix}${counter}`,
          modelName: "CAP_GEN",
          terminals: [
            { name: "PLUS", netId: nextNet(), shapeIds: capContactIds },
            { name: "MINUS", netId: nextNet(), shapeIds: capContactIds },
          ],
          bbox: marker.bbox,
          ...(marker.id ? { _markerShapeId: marker.id } : {}),
        });
        
        break;
      }

      // ── Diode (marker-based) ─────────────────────────────────
      case "diode": {
        const area = marker.bbox.width * marker.bbox.height * umPerPx * umPerPx;
        // Restrict contacts to those inside this marker's bbox so that
        // multiple diodes/resistors in the same cell don't share contacts.
        const diodeContacts = shapesInside(layers, "contact", marker.bbox);
        const diodeContactIds = diodeContacts.map(c => c.id);
        devices.push({
          id: devId,
          kind: "diode",
          geometry: {
            area_um2: area,
            perimeter_um: Math.sqrt(area) * 4,
            multiplier: 1,
            diodeType: "pn",
          },
          cellTypeId,
          instanceName: `${prefix}${counter}`,
          modelName: "D_GEN",
          terminals: [
            { name: "PLUS", netId: nextNet(), shapeIds: diodeContactIds },
            { name: "MINUS", netId: nextNet(), shapeIds: diodeContactIds },
          ],
          bbox: marker.bbox,
          ...(marker.id ? { _markerShapeId: marker.id } : {}),
        });
        break;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Geometric resistor detection (no res_id marker)
  // ══════════════════════════════════════════════════════════════
  // Pattern: body layer shape (poly, base, emitter, hsr, film)
  //   INTERACTs ME1, which INTERACTs contact.
  //   Two or more contact groups → resistor.
  //
  // Line shapes (polyline segments) are grouped by end-to-end
  // connectivity so multi-segment polylines form one resistor.
  // ─────────────────────────────────────────────────────────────
  const BODY_LAYERS_GEO: Array<{ layer: string; type: string }> = [
    { layer: "poly", type: "poly" },
    { layer: "polysilicon", type: "poly" },
    { layer: "base", type: "pb" },
    { layer: "emitter", type: "npl" },
    { layer: "hsr", type: "hsr" },
    { layer: "film", type: "film" },
    { layer: "resistor_body", type: "poly" },
  ];
  const allLayersRec = layers as Record<string, LayerShape[]>;

  // ── Helper: group connected line segments ────────────────────
  const TOL = 1; // 1px end-to-end tolerance
  function linesConnect(a: LayerShape, b: LayerShape): boolean {
    if (a.kind !== "line" || b.kind !== "line") return false;
    const la = a as any, lb = b as any;
    const ends = [
      [la.x1, la.y1], [la.x2, la.y2],
    ];
    const otherEnds = [
      [lb.x1, lb.y1], [lb.x2, lb.y2],
    ];
    for (const [ex, ey] of ends) {
      for (const [ox, oy] of otherEnds) {
        if (Math.hypot(ex - ox, ey - oy) <= TOL) return true;
      }
    }
    return false;
  }

  // Collect existing marker bboxes so we don't double-detect
  // body shapes (base/emitter) that belong to a BJT/diode.
  const markerBboxes = markers.map((m) => m.bbox);
  function insideMarker(bbox: Rect): boolean {
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    return markerBboxes.some(
      (mb) =>
        cx >= mb.x && cx <= mb.x + mb.width &&
        cy >= mb.y && cy <= mb.y + mb.height,
    );
  }

  for (const bl of BODY_LAYERS_GEO) {
    const bodyShapes = allLayersRec[bl.layer] ?? [];
    if (bodyShapes.length === 0) continue;

    // Split into line shapes and non-line shapes.
    const lines = bodyShapes.filter((s) => s.kind === "line");
    const other = bodyShapes.filter((s) => s.kind !== "line");

    // Group connected lines into polylines.
    const polylineGroups: LayerShape[][] = [];
    const assigned = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      if (assigned.has(lines[i].id)) continue;
      const group: LayerShape[] = [lines[i]];
      assigned.add(lines[i].id);
      let changed = true;
      while (changed) {
        changed = false;
        for (let j = 0; j < lines.length; j++) {
          if (assigned.has(lines[j].id)) continue;
          if (group.some((g) => linesConnect(g, lines[j]))) {
            group.push(lines[j]);
            assigned.add(lines[j].id);
            changed = true;
          }
        }
      }
      polylineGroups.push(group);
    }

    // Process each group (polyline or single non-line shape).
    const groupsToProcess: LayerShape[][] = [...polylineGroups];
    for (const s of other) groupsToProcess.push([s]);

    for (const group of groupsToProcess) {
      // Compute group bbox.
      let gBbox: Rect | null = null;
      for (const s of group) {
        const b = shapeBbox(s);
        if (!b) continue;
        if (!gBbox) { gBbox = { ...b }; continue; }
        const x2 = Math.max(gBbox.x + gBbox.width, b.x + b.width);
        const y2 = Math.max(gBbox.y + gBbox.height, b.y + b.height);
        gBbox.x = Math.min(gBbox.x, b.x);
        gBbox.y = Math.min(gBbox.y, b.y);
        gBbox.width = x2 - gBbox.x;
        gBbox.height = y2 - gBbox.y;
      }
      if (!gBbox) continue;

      // Skip if inside a BJT/cap/diode marker.
      if (insideMarker(gBbox)) continue;

      // ── Find ME1 shapes intersecting ANY shape in group ──────
      const groupPolys = group.map((s) => shapeToPolygon(s));
      const me1List = (allLayersRec.metal1 ?? []).filter((me1) => {
        const mp = shapeToPolygon(me1);
        return groupPolys.some((gp) => polygonsIntersect(gp, mp));
      });
      if (me1List.length < 2) continue;

      // ── UF: ME1 shapes that overlap are one component ────────
      const uf = new UnionFind(me1List.length);
      const me1Polys = me1List.map((m) => shapeToPolygon(m));
      for (let i = 0; i < me1List.length; i++) {
        for (let j = i + 1; j < me1List.length; j++) {
          if (polygonsIntersect(me1Polys[i], me1Polys[j])) uf.union(i, j);
        }
      }

      // ── Group contacts by ME1 UF component ───────────────────
      const allContactList = allLayersRec.contact ?? [];
      const compCts = new Map<number, Set<string>>();
      for (let mi = 0; mi < me1List.length; mi++) {
        const r = uf.find(mi);
        const set = compCts.get(r) ?? new Set();
        for (const ct of allContactList) {
          if (polygonsIntersect(me1Polys[mi], shapeToPolygon(ct)))
            set.add(ct.id);
        }
        compCts.set(r, set);
      }
      const groups = [...compCts.values()].filter((s) => s.size > 0);
      const contactCount = groups.reduce((acc, s) => acc + s.size, 0);


      if (groups.length < 2) continue;

      // ── Geometry (L/W/squares) using this group's shapes only ──
      let L_um = 0, W_um = 0, squares = 0, corners = 0;
      const lineSegs = group.filter(
        (s) => s.kind === "line",
      ) as Array<{
        kind: "line"; id: string; x1: number; y1: number;
        x2: number; y2: number; width: number;
      }>;
      if (lineSegs.length > 0) {
        // Polyline: sort into connected order for corner detection.
        const sorted: typeof lineSegs = [lineSegs[0]];
        const used = new Set([lineSegs[0].id]);
        while (sorted.length < lineSegs.length) {
          const last = sorted[sorted.length - 1];
          const next = lineSegs.find(
            (ls) =>
              !used.has(ls.id) &&
              (Math.hypot(last.x2 - ls.x1, last.y2 - ls.y1) <= TOL ||
               Math.hypot(last.x2 - ls.x2, last.y2 - ls.y2) <= TOL),
          );
          if (!next) break;
          sorted.push(next);
          used.add(next.id);
        }
        let totalL = 0;
        W_um = (sorted[0].width || 4) * umPerPx;
        let prevAngle: number | null = null;
        for (let i = 0; i < sorted.length; i++) {
          const l = sorted[i];
          const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
          const segLen = Math.sqrt(dx * dx + dy * dy);
          totalL += segLen;
          if (i > 0) {
            const angle = Math.atan2(dy, dx);
            if (prevAngle != null && Math.abs(angle - prevAngle) > Math.PI / 6) corners++;
            prevAngle = angle;
          } else {
            prevAngle = Math.atan2(dy, dx);
          }
        }
        L_um = totalL * umPerPx;
        squares = (totalL - corners * sorted[0].width) / sorted[0].width + 0.55 * corners;
      } else {
        // Non-line body (rect/polygon): use bbox.
        W_um = gBbox.width * umPerPx;
        L_um = gBbox.height * umPerPx;
        squares = W_um > 0 && L_um > 0 ? Math.max(L_um, W_um) / Math.min(L_um, W_um) : 0;
      }

      // ── Sort contact groups along body axis → PLUS/MINUS ─────
      const sortByX = gBbox.width >= gBbox.height;
      groups.sort((a, b) => {
        const firstA = [...a][0];
        const firstB = [...b][0];
        const ctA = allContactList.find((c) => c.id === firstA);
        const ctB = allContactList.find((c) => c.id === firstB);
        const ba = ctA ? shapeBbox(ctA) : null;
        const bb = ctB ? shapeBbox(ctB) : null;
        if (!ba || !bb) return 0;
        return sortByX
          ? ba.x + ba.width / 2 - (bb.x + bb.width / 2)
          : ba.y + ba.height / 2 - (bb.y + bb.height / 2);
      });

      const plusContactIds = [...groups[0]];
      const minusContactIds = [...groups[1]];
      // Include all body shapeIds for cell viewer overlay.
      const allBodyIds = group.map((s) => s.id);
      const plusTermIds = [...plusContactIds, ...allBodyIds];
      const minusTermIds = [...minusContactIds, ...allBodyIds];

      counter++;
      const devId = `analog_resistor_geo_${counter}`;
      const resistorType = bl.type;
      const shape = lineSegs.length > 0 ? "meander" : "straight";
      devices.push({
        id: devId,
        kind: "resistor",
        geometry: {
          L_um, W_um, squares,
          resistance_ohms: squares * effectiveSheetR(resistorType as ResistorType, undefined),
          fingers: 1, multiplier: 1,
          shape: shape as any,
          resistorType: resistorType as any,
        },
        cellTypeId,
        instanceName: `R${counter}`,
        modelName: "RES_GEN",
        terminals: [
          { name: "PLUS", netId: nextNet(), shapeIds: plusTermIds },
          { name: "MINUS", netId: nextNet(), shapeIds: minusTermIds },
        ],
        bbox: gBbox,
      });

    }
  }

  return devices;
}

// ── Diffusion splitting helpers (multi-finger MOS) ────────────────

/** Point → `key` for dedup. */
function ptKey(p: { x: number; y: number }): string {
  return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
}

/**
 * Split a diffusion polygon at gate polygons using Clipper2.
 *
 * Returns:
 *   - segments: N+1 polygon rings (Point[]) in left→right (or top→bottom)
 *     order along the diffusion's dominant axis
 *   - shapes: synthetic LayerPolygon shapes corresponding to each segment
 *
 * If Clipper2 is not loaded, returns null (caller falls back to old code).
 */
function splitDiffusionAtGates(
  bodyShape: LayerShape,
  gateShapes: LayerShape[],
  devId: string,
): { segments: Point[][]; shapes: LayerShape[] } | null {
  getClipper(); // ensure Clipper2 is initialized before use


  const diffPoly = shapeToPolygon(bodyShape);

  if (diffPoly.length < 3) return null;

  // Sort gates by position along the diffusion's dominant axis.
  // Determine axis: the dimension with larger span among gate centroids.
  const gCentroids = gateShapes.map((g) => {
    const gp = shapeToPolygon(g);
    let sx = 0, sy = 0;
    for (const pt of gp) {
      sx += pt.x;
      sy += pt.y;
    }
    const n = gp.length;
    return { poly: gp, cx: sx / n, cy: sy / n };
  });

  const xs = gCentroids.map((c) => c.cx);
  const ys = gCentroids.map((c) => c.cy);
  const xSpan = Math.max(...xs) - Math.min(...xs);
  const ySpan = Math.max(...ys) - Math.min(...ys);
  const sortByX = xSpan >= ySpan;

  const sortedGatePolys = [...gCentroids].sort((a, b) =>
    sortByX ? a.cx - b.cx : a.cy - b.cy,
  );


  // Iteratively cut: start with full diffusion, cut at each gate poly.
  // This gives deterministic ordering of pieces.

  let pieces: Point[][] = [diffPoly];
  for (const gp of sortedGatePolys) {
    const nextPieces: Point[][] = [];
    for (const piece of pieces) {
      // Check bbox-level overlap first to avoid unnecessary Clipper calls.
      const pb = polygonBounds(piece);
      const gb = polygonBounds(gp.poly);
      if (
        !pb ||
        !gb ||
        pb.x >= gb.x + gb.width ||
        pb.x + pb.width <= gb.x ||
        pb.y >= gb.y + gb.height ||
        pb.y + pb.height <= gb.y
      ) {
        nextPieces.push(piece);
        continue;
      }

      const diff = polygonDifference(piece, [gp.poly]);
      const before = nextPieces.length;
      for (const ring of diff) {
        const ringArea = ringSignedArea(ring);

        if (Math.abs(ringArea) < 1.0) continue; // discard noise (Clipper CW rings → negative area)
        nextPieces.push(ring);
      }

    }
    pieces = nextPieces;

  }

  if (pieces.length < 2) {

    return null; // shouldn't happen for fingers>1
  }

  // Sort pieces by centroid along the dominant axis.
  const withCentroid = pieces.map((poly, i) => {
    let sx = 0, sy = 0;
    for (const pt of poly) {
      sx += pt.x;
      sy += pt.y;
    }
    const n = poly.length;
    return { poly, cx: sx / n, cy: sy / n, idx: i };
  });
  withCentroid.sort((a, b) =>
    sortByX ? a.cx - b.cx : a.cy - b.cy,
  );

  // Build synthetic LayerShape polygons for each segment.
  const shapes: LayerShape[] = withCentroid.map((seg, i) => ({
    id: `${devId}_seg${i}`,
    kind: "polygon" as const,
    points: seg.poly.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })),
  }));


  return {
    segments: withCentroid.map((s) => s.poly),
    shapes,
  };
}

/**
 * Post-process: merge drain/source netIds across devices when they are
 * connected by metal (ME1 / ME2 + via1) inside the cell.
 *
 * Builds a union-find connectivity graph over metal shapes (ME1, ME2, via1,
 * contact) — the same pattern used by cell.ts Step 2 for digital extraction.
 * Each MOS device's D/S terminal is then matched to its overlapping contacts;
 * terminals whose contacts belong to the same metal component receive one
 * shared cell-level netId. The die-level pipeline (cellNetCache in
 * dieWideAnalog.ts) then resolves those to a single SPICE net.
 *
 * Does NOT affect gate terminals (already handled by polyGateNetMap) or
 * bulk terminals (handled separately with -2 sentinel).
 */
export function mergeMetalConnectedTerminals(
  devices: AnalogDevice[],
  allLayers: Record<string, LayerShape[]>,
): void {
  const me1   = allLayers["metal1"] ?? [];
  const me2   = allLayers["metal2"] ?? [];
  const via1  = allLayers["via1"] ?? [];
  const cts   = allLayers["contact"] ?? [];

  const metalShapes = [...me1, ...me2, ...via1, ...cts];
  if (metalShapes.length === 0) return;

  // Build polygon + bbox for every shape.
  const polyData = metalShapes.map((s) => ({
    id: s.id,
    poly: shapeToPolygon(s),
    bbox: polygonBounds(shapeToPolygon(s))!,
  }));

  // Index ranges for each layer within `metalShapes` (for bucket iteration).
  const ranges = [
    { start: 0, end: me1.length },                              // ME1
    { start: me1.length, end: me1.length + me2.length },         // ME2
    { start: me1.length + me2.length, end: me1.length + me2.length + via1.length }, // via1
    { start: me1.length + me2.length + via1.length, end: metalShapes.length }, // contact
  ];

  // ── Union-find: same-layer intersection ────────────────────────
  const uf = new UnionFind(metalShapes.length);
  for (const { start, end } of ranges) {
    for (let i = start; i < end; i++) {
      for (let j = i + 1; j < end; j++) {
        if (!rectsIntersect(polyData[i].bbox, polyData[j].bbox)) continue;
        if (polygonsIntersect(polyData[i].poly, polyData[j].poly)) {
          uf.union(i, j);
        }
      }
    }
  }

  // Contact ↔ ME1 bridge: contact overlaps ME1.
  const me1Start = 0, me1End = me1.length;
  const ctStart = ranges[3].start, ctEnd = ranges[3].end;
  for (let ci = ctStart; ci < ctEnd; ci++) {
    for (let mi = me1Start; mi < me1End; mi++) {
      if (!rectsIntersect(polyData[ci].bbox, polyData[mi].bbox)) continue;
      if (polygonsIntersect(polyData[ci].poly, polyData[mi].poly)) {
        uf.union(ci, mi);
      }
    }
  }

  // Via1 ↔ ME1 + Via1 ↔ ME2: via overlaps both metal layers.
  const me2Start = ranges[1].start, me2End = ranges[1].end;
  const viaStart = ranges[2].start, viaEnd = ranges[2].end;
  for (let vi = viaStart; vi < viaEnd; vi++) {
    for (let mi = me1Start; mi < me1End; mi++) {
      if (!rectsIntersect(polyData[vi].bbox, polyData[mi].bbox)) continue;
      if (polygonsIntersect(polyData[vi].poly, polyData[mi].poly)) {
        uf.union(vi, mi);
      }
    }
    for (let mi = me2Start; mi < me2End; mi++) {
      if (!rectsIntersect(polyData[vi].bbox, polyData[mi].bbox)) continue;
      if (polygonsIntersect(polyData[vi].poly, polyData[mi].poly)) {
        uf.union(vi, mi);
      }
    }
  }

  // Map: contact id → UF root.
  const contactRoot = new Map<string, number>();
  for (let i = ctStart; i < ctEnd; i++) {
    contactRoot.set(metalShapes[i].id, uf.find(i));
  }

  // ── Build shapeId → polygon lookup (layers + segment shapes) ──
  const shapePoly = new Map<string, Point[]>();
  for (const [, shapes] of Object.entries(allLayers)) {
    for (const s of shapes) {
      shapePoly.set(s.id, shapeToPolygon(s));
    }
  }
  for (const [, segShapes] of _segmentShapesCache) {
    for (const s of segShapes) {
      shapePoly.set(s.id, shapeToPolygon(s));
    }
  }

  // ── Pre-collect well, diffusion, poly shapes for bulk tap detection ─
  const nwells = allLayers["nwell"] ?? [];
  const pwells = allLayers["pwell"] ?? [];
  const wellShapes = [...nwells, ...pwells];
  const diffShapes = allLayers["diffusion"] ?? [];
  const polyShapes = allLayers["polysilicon"] ?? [];

  // ── For each candidate terminal, collect overlapping contacts' UF roots ─
  // Terminal → set of UF roots (contacts overlapping this terminal).
  // MOS D, S, B and resistor PLUS/MINUS are processed.
  // Other devices (BJT, cap, diode-marker) are resolved at die level.
  const termRoots = new Map<string, Set<number>>();
  for (const dev of devices) {
    if (dev.kind !== "mos" && dev.kind !== "resistor") continue;
    for (const term of dev.terminals) {
      if (dev.kind === "mos" && term.name !== "D" && term.name !== "S" && term.name !== "B") continue;
      if (dev.kind === "resistor" && term.name !== "PLUS" && term.name !== "MINUS") continue;

      // Find the terminal's source LayerShape by first shapeId.
      if (!term.shapeIds || term.shapeIds.length === 0) continue;
      const sId = term.shapeIds[0];
      if (!sId) continue;
      const tPoly = shapePoly.get(sId);
      if (!tPoly) continue;
      const tBbox = polygonBounds(tPoly);
      if (!tBbox) continue;

      const roots = new Set<number>();
      for (const ct of cts) {
        const ctPoly = shapePoly.get(ct.id);
        if (!ctPoly) continue;
        const ctB = polygonBounds(ctPoly);
        if (!ctB || !rectsIntersect(tBbox, ctB)) continue;
        if (!polygonsIntersect(tPoly, ctPoly)) continue;

        // For bulk terminal (B): exclude contacts also on diffusion (S/D)
        // or poly (gate) — those aren't well tap contacts.
        if (dev.kind === "mos" && term.name === "B") {
          const onDiff = diffShapes.some((d) => {
            const dp = shapePoly.get(d.id);
            return dp && polygonsIntersect(dp, ctPoly);
          });
          if (onDiff) continue;
          const onPoly = polyShapes.some((p) => {
            const pp = shapePoly.get(p.id);
            return pp && polygonsIntersect(pp, ctPoly);
          });
          if (onPoly) continue;
        }

        const root = contactRoot.get(ct.id);
        if (root !== undefined) roots.add(root);
      }

      if (roots.size > 0) {
        termRoots.set(`${dev.id}:${term.name}`, roots);
      }
    }
  }

  // ── Group terminals by UF component root ───────────────────────
  // If a terminal touches multiple components (unusual), its contacts
  // are electrically shorted → any of the roots works.
  // Map: root → list of (devId, termName).
  const rootToTerms = new Map<number, Array<{ devId: string; termName: string }>>();
  for (const [key, roots] of termRoots) {
    const root = [...roots][0]; // pick first root
    const sep = key.indexOf(":");
    const devId = key.slice(0, sep);
    const termName = key.slice(sep + 1);
    let arr = rootToTerms.get(root);
    if (!arr) { arr = []; rootToTerms.set(root, arr); }
    arr.push({ devId, termName });
  }



  // ── Assign a common netId to each component's terminals ────────
  const compNetId = new Map<number, number>();
  for (const [root, terms] of rootToTerms) {
    const netId = nextNet();
    compNetId.set(root, netId);
    for (const { devId, termName } of terms) {
      const dev = devices.find((d) => d.id === devId);
      if (!dev) continue;
      const term = dev.terminals.find((t) => t.name === termName);
      if (!term) continue;
      term.netId = netId;

    }
  }
}

/**
 * Well-based MOS detection — alternative to device_box + drain/gate/source/bulk
 * markers.  Infers PMOS/NMOS, bulk terminal, and geometry from:
 *
 *   1. nwell/pwell layers → determines transistor type (P/N) and bulk well
 *   2. diffusion overlapping the well → body region
 *   3. polysilicon crossing the diffusion → gate + S/D sub-regions
 *   4. contacts on the well → bulk net (positive netId); if no contact,
 *      bulk = -2 sentinel (die-wide pipeline falls back to VDD/GND)
 *   5. finger count = number of polys crossing one diffusion
 *   6. multiplier = number of separate diffusions with same well + poly pattern
 *
 * ALWAYS uses Clipper2 to split diffusion at gate polys (single-finger = 2 segments,
 * multi-finger = N+1 segments). If Clipper2 is unavailable, devices are skipped.
 * This ensures each D/S terminal references its own synthetic segment shape,
 * preventing mergeMetalConnectedTerminals from shorting D and S.
 *
 * Returns devices with D, G, S, B terminals (dummy net IDs — the die-wide
 * pipeline resolves real nets later).
 */
export function detectMOSFromLayers(
  layers: CellLayers | undefined,
  cellTypeId: string,
  umPerPx: number,
): AnalogDevice[] {
  if (!layers) return [];

  // Clipper2 is required for all MOS detection — we use it for both
  // poly gate net grouping and diffusion splitting. If unavailable,
  // skip MOS entirely; the caller shows a Clipper warning at the GUI level.
  if (!isClipperLoaded()) {
    console.warn(`[analog] detectMOSFromLayers: Clipper2 not loaded — cannot detect MOS devices`);
    return [];
  }

  // Reset segment shapes cache at the start of each cell-type extraction.
  // This prevents stale shapes from a previous cell type leaking into the
  // current one (device IDs are global-counter-based, but clearing is safer).
  _segmentShapesCache.clear();

  const devices: AnalogDevice[] = [];
  const allLayers = layers as Record<string, LayerShape[]>;

  const nwells = allLayers["nwell"] ?? [];
  const pwells = allLayers["pwell"] ?? [];
  const diffusions = allLayers["diffusion"] ?? [];
  const polys = allLayers["polysilicon"] ?? [];
  const contacts = allLayers["contact"] ?? [];

  // ═══ Poly gate net grouping ═══
  // Polysilicon shapes that physically connect (same shape or overlapping
  // polygons) should share one gate netId across all MOS devices they
  // gate. This matches real topology where a single poly polygon crosses
  // multiple diffusions — without the old hack of inventing fake contacts
  // and die-level wires to share the gate net.
  const polyGateNetMap = new Map<string, number>();



  if (polys.length > 0) {
    // Connected components via Clipper2 overlap test.
    // Poly shapes that physically intersect share one gate netId.
      const pp = polys.map((p) => ({ id: p.id, poly: shapeToPolygon(p) }));
      pp.forEach((p, i) => {
        const b = polygonBounds(p.poly)!;

      });
      const uf = new UnionFind(pp.length);
      let mergeCount = 0;
      for (let i = 0; i < pp.length; i++) {
        const bi = polygonBounds(pp[i].poly)!;
        for (let j = i + 1; j < pp.length; j++) {
          const bj = polygonBounds(pp[j].poly)!;
          if (!rectsIntersect(bi, bj)) continue;
          if (polygonsIntersect(pp[i].poly, pp[j].poly)) {

            uf.union(i, j);
            mergeCount++;
          }
        }
      }

      const compNets = new Map<number, number>();
      for (let i = 0; i < pp.length; i++) {
        const root = uf.find(i);
        if (!compNets.has(root)) compNets.set(root, nextNet());
        polyGateNetMap.set(pp[i].id, compNets.get(root)!);
      }
  }

  // Reverse map: gate netId → all poly shape IDs sharing that net.
  // Used to include connected poly shapes (e.g., shared poly bus) in
  // gate terminal shapeIds so the die viewer overlay highlights all
  // physical polys that belong to the same gate signal.
  const gateNetShapes = new Map<number, Set<string>>();
  for (const [polyId, netId] of polyGateNetMap) {
    let s = gateNetShapes.get(netId);
    if (!s) { s = new Set(); gateNetShapes.set(netId, s); }
    s.add(polyId);
  }
  function allPolyIdsForGateNet(netId: number): string[] {
    return [...(gateNetShapes.get(netId) ?? [])];
  }

  function gateNetFor(polyId: string): number {
    const net = polyGateNetMap.get(polyId);
    if (net !== undefined) return net;
    // Fallback (shouldn't happen since we pre-populated all polys):
    const newNet = nextNet();

    polyGateNetMap.set(polyId, newNet);
    return newNet;
  }

  const WELLS: Array<{ shapes: LayerShape[]; type: "pmos" | "nmos"; wellLabel: string }> = [
    { shapes: nwells, type: "pmos", wellLabel: "nwell" },
    { shapes: pwells, type: "nmos", wellLabel: "pwell" },
  ];

  let counter = 0;

  for (const { shapes: wellShapes, type: mosType, wellLabel } of WELLS) {
    for (const well of wellShapes) {
      const wellBox = shapeBbox(well);
      if (!wellBox) continue;

      // Find diffusions inside this well.
      const bodyDiffs = diffusions.filter((d) => {
        const db = shapeBbox(d);
        return db && overlapArea(wellBox, db) > 0;
      });

      for (const body of bodyDiffs) {
        const bodyBox = shapeBbox(body);
        if (!bodyBox) continue;

        // Find poly gates crossing this diffusion.
        const gates = polys.filter((p) => {
          const pb = shapeBbox(p);
          return pb && overlapArea(bodyBox, pb) > 0;
        });
        if (gates.length === 0) continue;



        // ── W/L from poly ∩ diffusion intersection ──────────
        // Each gate finger overlaps the diffusion; the intersection
        // polygon gives us the real channel dimensions.
        let totalIxW = 0;
        let ixL = 0;
        for (const gate of gates) {
          const gb = shapeBbox(gate);
          if (!gb) continue;
          const ix = intersectionBbox(bodyBox, gb);
          if (!ix) continue;
          totalIxW += Math.max(ix.width, ix.height);
          if (ixL === 0) ixL = Math.min(ix.width, ix.height);
        }
        const fingers = gates.length;
        const W_um = fingers > 0 ? (totalIxW / fingers) * umPerPx : 0;
        const L_um = ixL * umPerPx;

        counter++;
        const devId = `mos_well_${wellLabel}_${counter}`;

        // ── Bulk net from well contact ────────────────────────
        // If a contact shape exists on the well, the user drew a well tap.
        // Assign a positive netId (internal net).  If the die-level pipeline
        // finds no VDD/GND wire connected to this contact, it becomes a
        // unique 2000+ internal net — correct, because the user explicitly
        // placed a well tap and it's not tied to any supply.
        //
        // If NO contact on the well, the user omitted the well tap → sentinel
        // -2, which instructs the die-level pipeline to fall back to VDD/GND.
        let bulkNetId = -1;
        // A well tap contact must be INSIDE the well region but NOT
        // on any diffusion (S/D contact) and NOT on any polysilicon
        // (gate contact).  This is the classic LVS layer-exclusion
        // pattern: a contact belongs to the most specific layer set.
        const tapContacts = contacts.filter((c) => {
          const cb = shapeBbox(c);
          if (!cb || !overlapArea(wellBox, cb)) return false;
          // Reject if on diffusion — that's an S/D contact.
          if (bodyDiffs.some((d) => {
            const db = shapeBbox(d);
            return db && overlapArea(cb, db) > 0;
          })) return false;
          // Reject if on polysilicon — that's a gate contact.
          if (polys.some((p) => {
            const pb = shapeBbox(p);
            return pb && overlapArea(cb, pb) > 0;
          })) return false;
          return true; // contact on well only → well tap
        });
        const wellContact = tapContacts[0];
        if (wellContact) {
          bulkNetId = nextNet(); // user drew a well tap — internal net
        }
        if (bulkNetId < 0) {
          bulkNetId = -2; // no well tap → sentinel: resolve to VDD/GND at die level
        }

        // ── Clipper2 diffusion split (all MOS) ──────────────────
        // Use Clipper2 to physically cut the diffusion at every gate poly,
        // creating N+1 segments (N = gates/fingers). Each segment becomes
        // S/D for the adjacent gate. Shared segments between gates get
        // assigned to both D of the left and S of the right gate.
        // Single-finger (N=1) → 2 segments: seg[0]=S, seg[1]=D.

        const split = splitDiffusionAtGates(body, gates, devId);
        if (split && split.segments.length === fingers + 1) {
          const wellId = well.id;

          // Create one MOS per gate. Adjacent gates share a diffusion
          // segment: seg[i] = S for gate[i], seg[i+1] = D for gate[i].
          // This means seg[i+1] is BOTH D of gate[i] AND S of gate[i+1]
          // (shared diffusion region between two gates).
          // Cache segment shapes under each per-gate device's id so the
          // dieWideAnalog.ts pipeline can inject them into ctLayers.
          for (let gi = 0; gi < gates.length; gi++) {
            const gate = gates[gi];
            const gCounter = counter;
            const subDevId = `${devId}_finger${gi}`;
            _segmentShapesCache.set(subDevId, split.shapes);
            const segS = split.shapes[gi];      // S-side segment
            const segD = split.shapes[gi + 1];   // D-side segment

            const sN = nextNet();
            const dN = nextNet();
            const gN = gateNetFor(gate.id);

            const gShapeIds = allPolyIdsForGateNet(gN);
            const terminals: DeviceTerminal[] = [
              { name: "D", netId: dN, shapeIds: [segD.id] },
              { name: "G", netId: gN, shapeIds: gShapeIds },
              { name: "S", netId: sN, shapeIds: [segS.id] },
              { name: "B", netId: bulkNetId, shapeIds: [wellId] },
            ];

            // ── Per-sub-device gate poly centroid ──────────────────
            // Each finger has its own gate poly even when several fingers
            // share a poly run and one common well-tap contact. The
            // centroid gives every label a unique anchor and keeps them
            // from piling up on the same gate-tap point on the cell image
            // canvas. `bbox` is left at `bodyBox` (the whole diffusion)
            // because hit-tests, die-viewer body outline, and hierarchical
            // export all rely on the body extent, not the gate strip.
            let gateAnchor: { x: number; y: number } | undefined;
            {
              const gp = shapeToPolygon(gate);
              if (gp.length > 0) {
                let sx = 0, sy = 0;
                for (const pt of gp) { sx += pt.x; sy += pt.y; }
                gateAnchor = { x: sx / gp.length, y: sy / gp.length };
              }
            }

            const geometry: DeviceGeometryMOS = {
              L_um,
              W_um,
              fingers: 1,
              multiplier: 1,
              totalW_um: W_um,
              mosType,
            };

            devices.push({
              id: subDevId,
              kind: "mos",
              geometry,
              cellTypeId,
              instanceName: `M_${gCounter}`,
              modelName: mosType === "pmos" ? "PMOS" : "NMOS",
              terminals,
              bbox: bodyBox,
              ...(gateAnchor ? { _gateAnchor: gateAnchor } : {}),
            } as unknown as AnalogDevice);
            
          }
          counter++; // advance counter once for all sub-devices
        } else {
          // Clipper2 split failed — skip this device entirely.
          // Clipper2 must be loaded for MOS detection to work.
          console.warn(`[analog] detectMOSFromLayers: Clipper2 split failed for ${devId} ` +
            `(got ${split?.segments.length ?? 0} segments, expected ${fingers + 1}) — skipping`);
        }
      }
    }
  }

  // ── Multiplier detection ────────────────────────────────────
  // Group devices by well type + approximate W/L. Devices in the same
  // well region with matching geometry get multiplier > 1.
  const groups = new Map<string, AnalogDevice[]>();
  for (const d of devices) {
    const g = d.geometry as DeviceGeometryMOS;
    const key = `${g.mosType}_W${Math.round(g.W_um)}_L${g.L_um.toFixed(2)}`;
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }
  for (const [, list] of groups) {
    if (list.length > 1) {
      for (let i = 0; i < list.length; i++) {
        const g = list[i].geometry as DeviceGeometryMOS;
        g.multiplier = list.length;
        g.totalW_um = g.W_um * g.fingers * g.multiplier;
      }
    }
  }

  // Metal-connected D/S (MOS) and PLUS/MINUS (resistor) terminal
  // merging is handled in extractAnalogDevicesFromCellType (dieWideAnalog.ts)
  // on all devices together so inter-device connections work.

  return devices;
}

// ═════════════════════════════════════════════════════════════════
// Terminal contact resolution — shared between cell-level (RE Cell)
// and die-level (dieWideAnalog) pipelines.  Guarantees that the
// same contacts map to the same terminal names in both views.
// ═════════════════════════════════════════════════════════════════

interface TerminalDef {
  name: string;
  /** Layout layers to search for shapes of this terminal. */
  layers: string[];
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
  { name: "PLUS", layers: ["base", "bulk"], priority: 1 },
  { name: "MINUS", layers: ["emitter"], priority: 0 },
];

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

function terminalDefMap(kind: DeviceKind): Map<string, TerminalDef> {
  const defs = DEVICE_TERMINAL_DEFS[kind] ?? DEFAULT_2T_DEFS;
  const map = new Map<string, TerminalDef>();
  for (const d of defs) map.set(d.name, d);
  return map;
}

function defsHavePriority(defs: Map<string, TerminalDef>): boolean {
  for (const [, d] of defs) if (d.priority !== undefined) return true;
  return false;
}

function _shapeBounds(s: LayerShape): {x:number;y:number;width:number;height:number} | null {
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

function _centerOfShape(s: LayerShape): {x:number;y:number}|null {
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

function _contactTolerance(s: LayerShape): number {
  switch (s.kind) {
    case "rect": return Math.max(s.width, s.height) * 0.5;
    case "point": return s.size * 0.5;
    case "circle": return s.radius;
    case "polygon": {
      if (s.points.length === 0) return 2;
      let cx = 0, cy = 0;
      for (const p of s.points) { cx += p.x; cy += p.y; }
      cx /= s.points.length; cy /= s.points.length;
      let maxDist = 0;
      for (const p of s.points) {
        const d = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2);
        if (d > maxDist) maxDist = d;
      }
      return maxDist;
    }
    default: return 2;
  }
}

function _pointInShape(px: number, py: number, s: LayerShape): boolean {
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

/**
 * Resolve which contacts belong to which terminals for a single device.
 * Shared between RE Cell and die-wide pipelines for label consistency.
 */
export function resolveDeviceContacts(
  dev: AnalogDevice,
  ctLayers: Record<string, LayerShape[] | undefined>,
  cx: number, cy: number,
): {
  termPoints: Array<{x:number;y:number;name:string;contactId?:string}>;
  termContacts: Array<Array<{x:number;y:number;tol:number;contactId?:string}>>;
} {
  const defMap = terminalDefMap(dev.kind);
  const hasPri = defsHavePriority(defMap);
  const termContacts: Array<Array<{x:number;y:number;tol:number;contactId?:string}>> = dev.terminals.map(() => []);

  const allContactShapes = (ctLayers.contact ?? []) as LayerShape[];
  const cTis = new Map<string, Set<number>>();
  const cPos = new Map<string, {x:number;y:number;tol:number}>();

  const mosOtherLayers: string[] = [];
  for (const [key, d] of defMap) {
    if (key === "B") continue;
    for (const l of d.layers) {
      if (!mosOtherLayers.includes(l)) mosOtherLayers.push(l);
    }
  }

  for (const cs of allContactShapes) {
    const cc = _centerOfShape(cs as any);
    if (!cc) continue;

    const candidates: Array<{ti:number; pri:number}> = [];

    for (let ti = 0; ti < dev.terminals.length; ti++) {
      const termName = dev.terminals[ti].name;
      const termDef = defMap.get(termName);
      if (!termDef) continue;

      let matched = false;
      for (const layer of termDef.layers) {
        const shapes = ctLayers[layer] as LayerShape[] | undefined;
        if (!shapes) continue;

        for (const shape of shapes) {
          const termShapeIds = dev.terminals[ti].shapeIds;
          if (termShapeIds && termShapeIds.length > 0 && !termShapeIds.includes(shape.id)) continue;

          const isInside = _pointInShape(cc.x, cc.y, shape);
          if (isInside) {
            if (dev.kind === "mos" && termDef.name === "B") {
              const alsoOnOther = mosOtherLayers.some((otherLayer) => {
                const otherShapes = ctLayers[otherLayer] as LayerShape[] | undefined;
                return otherShapes?.some((s) => _pointInShape(cc.x, cc.y, s)) ?? false;
              });
              if (alsoOnOther) continue;
            }
            candidates.push({ ti, pri: termDef.priority ?? 999 });
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    }

    if (candidates.length === 0) continue;

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

    const cpTol = _contactTolerance(cs as any);
    const wx = cx + cc.x, wy = cy + cc.y;
    if (!cPos.has(cs.id)) cPos.set(cs.id, { x: wx, y: wy, tol: cpTol });
    const set = cTis.get(cs.id) ?? new Set<number>();
    for (const ti of selected) set.add(ti);
    cTis.set(cs.id, set);
  }

  const bySig = new Map<string, Array<{cid:string; cp:{x:number;y:number;tol:number}}>>();
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
      for (const { cid, cp } of contacts) {
        termContacts[termIndices[0]].push({ x: cp.x, y: cp.y, tol: cp.tol, contactId: cid });
      }
    } else {
      for (let ci = 0; ci < contacts.length; ci++) {
        const ti = termIndices[ci % termIndices.length];
        termContacts[ti].push({ x: contacts[ci].cp.x, y: contacts[ci].cp.y, tol: contacts[ci].cp.tol, contactId: contacts[ci].cid });
      }
    }
  }

  const termPoints: Array<{x:number;y:number;name:string;contactId?:string}> = [];
  for (let ti = 0; ti < termContacts.length; ti++) {
    for (const cp of termContacts[ti]) {
      const wr = Math.round(cp.x), hr = Math.round(cp.y);
      const already = termPoints.some((p) => Math.round(p.x) === wr && Math.round(p.y) === hr);
      if (!already) {
        termPoints.push({ x: cp.x, y: cp.y, name: dev.terminals[ti].name, contactId: cp.contactId });
      }
    }
  }

  return { termPoints, termContacts };
}

// ═════════════════════════════════════════════════════════════════
// D/S assignment: Bulk connection heuristic
// ═════════════════════════════════════════════════════════════════
// After mergeMetalConnectedTerminals, B (well tap) and D/S terminals
// have netIds from the metal UF component they belong to.
// If S.netId === B.netId → source is correctly assigned (S is on bulk).
// If D.netId === B.netId → swap D/S (D is actually the source terminal).
// If neither matches (or no well contact) → leave unchanged.

/**
 * Swap D and S terminals for a MOS device.  Exchanges netIds and shapeIds
 * so that the user-assigned (or heuristic-detected) drain/source roles
 * are reflected in the device data.
 */
function _swapDSTerminals(dev: AnalogDevice): void {
  const dIdx = dev.terminals.findIndex((t) => t.name === "D");
  const sIdx = dev.terminals.findIndex((t) => t.name === "S");
  if (dIdx < 0 || sIdx < 0) return;
  const tmp = { ...dev.terminals[dIdx] };
  dev.terminals[dIdx] = { ...dev.terminals[sIdx], name: "D" };
  dev.terminals[sIdx] = { ...tmp, name: "S" };
  // Mark that D/S went through resolution (not default positional).
  // Used by display code to show "D"/"S" instead of "S/D".
  (dev as any)._dsResolved = true;
  // Swap the displayed termPoint names so labels update immediately.
  const pts = (dev as any)._termPoints as
    Array<{x:number;y:number;name:string}> | undefined;
  if (pts) {
    for (const p of pts) {
      if (p.name === "D") p.name = "S";
      else if (p.name === "S") p.name = "D";
    }
  }
}

/**
 * Apply the bulk connection heuristic:
 * After mergeMetalConnectedTerminals, if S's metal component matches
 * B's (well tap) component, S stays S. If D's matches B, swap D/S.
 *
 * Safe to call even when no well contact exists (netId comparisons
 * are strict equality).
 */
export function applyBulkHeuristic(
  devices: AnalogDevice[],
): void {
  for (const dev of devices) {
    if (dev.kind !== "mos") continue;

    // Skip devices already resolved (force SOURCE or cell-level heuristic).
    // Die-level heuristic should not override user-defined assignments.
    if ((dev as any)._dsResolved === true) continue;

    const dTerm = dev.terminals.find((t) => t.name === "D");
    const sTerm = dev.terminals.find((t) => t.name === "S");
    const bTerm = dev.terminals.find((t) => t.name === "B");
    if (!dTerm || !sTerm || !bTerm) continue;

    // Both D and S must have positive netIds (resolved to metal components)
    // AND B must have a positive netId (well tap exists + connected to metal).
    if (dTerm.netId < 0 || sTerm.netId < 0 || bTerm.netId < 0) continue;

    // Skip if D and S already share a netId (shorted) — can't determine.
    if (dTerm.netId === sTerm.netId) continue;

    if (sTerm.netId === bTerm.netId) {
      // S is already on bulk — correct. Mark as resolved so display
      // shows "S" instead of "S/D".
      (dev as any)._dsResolved = true;
      continue;
    }

    if (dTerm.netId === bTerm.netId) {
      // D is on bulk — D should be S. Swap.
      _swapDSTerminals(dev);
    }
  }
}

// ═════════════════════════════════════════════════════════════════
// D/S assignment: Force SOURCE override (user-defined)
// ═════════════════════════════════════════════════════════════════
// The user can right-click a contact in RE Cell and mark it as "Force SOURCE".
// This pushes the contact's shape ID into cellType.forcedSourceContacts.
//
// After resolution, if a contact's termPoint is named "D" but its contactId
// is in the forced set, swap D/S for that device.
//
// Priority: force SOURCE > bulk heuristic > default "S/D".

/**
 * Apply user-defined force-source overrides.
 *
 * @param devices  Devices with _termPoints already populated from
 *                 resolveDeviceContacts.
 * @param forcedSourceIds  Set of contact shape IDs forced to be SOURCE.
 */
export function applySourceOverride(
  devices: AnalogDevice[],
  forcedSourceIds: Set<string> | undefined,
): void {
  if (!forcedSourceIds || forcedSourceIds.size === 0) return;

  for (const dev of devices) {
    if (dev.kind !== "mos") continue;

    const pts = (dev as any)._termPoints as
      Array<{x:number;y:number;name:string;contactId?:string}> | undefined;
    if (!pts || pts.length === 0) continue;

    // Check if any termPoint (D or S) has a contactId in the forced set.
    const forcedContactOnD = pts.some(
      (p) => p.name === "D" && p.contactId && forcedSourceIds.has(p.contactId),
    );
    const forcedContactOnS = pts.some(
      (p) => p.name === "S" && p.contactId && forcedSourceIds.has(p.contactId),
    );
    if (!forcedContactOnD && !forcedContactOnS) continue;

    if (forcedContactOnD && forcedContactOnS) {
      // Both set — conflicting (shouldn't happen, but guard).
      continue;
    }

    if (forcedContactOnD) {
      // User forced a contact that resolved to D — swap to make it S.
      _swapDSTerminals(dev);
    } else {
      // forcedContactOnS — user confirmed a contact that's already S.
      // Mark as resolved so display shows "S" and multi-finger propagates.
      (dev as any)._dsResolved = true;
    }
  }
}

// ═════════════════════════════════════════════════════════════════
// Multi-finger D/S propagation
// ═════════════════════════════════════════════════════════════════
// Multi-finger MOS devices share diffusion segments (seg[i] is D for gate i-1
// AND S for gate i). If one device gets resolved (force SOURCE or bulk
// heuristic), the S/D pattern must propagate to all devices in the group
// because segments always alternate: S, D, S, D, ...

/**
 * Propagate D/S resolution across multi-finger device groups.
 *
 * Algorithm:
 * 1. Find groups of MOS devices that share segment shape IDs (multi-finger chain)
 * 2. For each group with at least one resolved device (_dsResolved):
 *    a. Determine the alternating pattern from known assignments
 *    b. Propagate: if seg[i] = S → seg[i-1] = D, seg[i+1] = D, etc.
 *    c. Swap devices whose S-terminal doesn't match the pattern
 */
export function propagateMultiFingerDS(devices: AnalogDevice[]): void {
  // ── Find segment-sharing groups via UF ────────────────────────
  // Map: segmentShapeId → array of {dev, term}
  const segToTerms = new Map<string, Array<{dev: AnalogDevice; termName: string}>>();
  for (const dev of devices) {
    if (dev.kind !== "mos") continue;
    for (const term of dev.terminals) {
      if (term.name !== "D" && term.name !== "S") continue;
      if (!term.shapeIds) continue;
      for (const sid of term.shapeIds) {
        // Only segment shapes (created by Clipper2 for MOS)
        if (!sid.includes("_seg")) continue;
        let list = segToTerms.get(sid);
        if (!list) { list = []; segToTerms.set(sid, list); }
        list.push({ dev, termName: term.name });
      }
    }
  }

  // UF over device instances
  const uf = new UnionFind(devices.length);
  for (const [, terms] of segToTerms) {
    if (terms.length < 2) continue;
    // All devices sharing a segment are in the same multi-finger group
    const idx0 = devices.indexOf(terms[0].dev);
    for (let i = 1; i < terms.length; i++) {
      uf.union(idx0, devices.indexOf(terms[i].dev));
    }
  }

  // Group by UF root
  const groups = new Map<number, AnalogDevice[]>();
  for (let i = 0; i < devices.length; i++) {
    if (devices[i].kind !== "mos") continue;
    // Skip if no segment shapes (not multi-finger)
    const hasSeg = devices[i].terminals.some(
      (t) => (t.name === "D" || t.name === "S") &&
        t.shapeIds?.some((sid) => sid.includes("_seg")),
    );
    if (!hasSeg) continue;
    const root = uf.find(i);
    let list = groups.get(root);
    if (!list) { list = []; groups.set(root, list); }
    list.push(devices[i]);
  }

  // ── Propagate within each group ───────────────────────────────
  for (const [, groupDevices] of groups) {
    if (groupDevices.length < 2) continue; // not multi-finger

    const hasResolved = groupDevices.some(
      (d) => (d as any)._dsResolved === true,
    );
    if (!hasResolved) continue;

    // ── Parallel vs series detection ────────────────────────────
    // In a parallel multi-finger layout, non-adjacent segments share
    // a metal net (e.g., seg0 + seg2 both on source bus). In a series
    // (cascode) layout, each segment has its own net. Only propagate
    // the alternating S/D pattern for parallel layouts.
    // Check: do any two non-adjacent segments share a netId?
    let isParallel = false;
    const segNetIds = new Map<string, Set<number>>();
    for (const dev of groupDevices) {
      for (const t of dev.terminals) {
        if (t.name !== "D" && t.name !== "S") continue;
        if (t.netId < 0) continue;
        for (const sid of t.shapeIds ?? []) {
          if (!sid.includes("_seg")) continue;
          let set = segNetIds.get(sid);
          if (!set) { set = new Set(); segNetIds.set(sid, set); }
          set.add(t.netId);
        }
      }
    }
    // Collect sorted segments
    const allSegIds = new Set(segNetIds.keys());
    const sortedSegs = [...allSegIds].sort((a, b) => {
      const ai = parseInt(a.match(/_seg(\d+)$/)?.[1] ?? "0", 10);
      const bi = parseInt(b.match(/_seg(\d+)$/)?.[1] ?? "0", 10);
      return ai - bi;
    });
    if (sortedSegs.length < 2) continue;

    // Check non-adjacent pairs for shared netIds
    for (let i = 0; i < sortedSegs.length; i++) {
      for (let j = i + 2; j < sortedSegs.length; j++) {
        const netI = segNetIds.get(sortedSegs[i]);
        const netJ = segNetIds.get(sortedSegs[j]);
        if (netI && netJ) {
          for (const nid of netI) {
            if (netJ.has(nid)) {
              isParallel = true;
              break;
            }
          }
        }
        if (isParallel) break;
      }
      if (isParallel) break;
    }
    if (!isParallel) continue; // series layout — don't propagate

    // Collect known segment assignments from resolved devices
    const segAssignment = new Map<string, "S" | "D">();
    for (const dev of groupDevices) {
      if ((dev as any)._dsResolved !== true) continue;
      for (const term of dev.terminals) {
        if (term.name !== "D" && term.name !== "S") continue;
        for (const sid of term.shapeIds ?? []) {
          if (!sid.includes("_seg")) continue;
          // The segment is assigned to terminal term.name
          // If terminal is S → segment should be S, if D → segment is D
          if (!segAssignment.has(sid)) {
            segAssignment.set(sid, term.name as "S" | "D");
          }
        }
      }
    }

    if (segAssignment.size === 0) continue;

    // Propagate: alternate outward from known segments
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < sortedSegs.length; i++) {
        const cur = sortedSegs[i];
        const curVal = segAssignment.get(cur);
        if (!curVal) continue;
        const opposite: "S" | "D" = curVal === "S" ? "D" : "S";

        if (i > 0) {
          const prev = sortedSegs[i - 1];
          if (!segAssignment.has(prev)) {
            segAssignment.set(prev, opposite);
            changed = true;
          }
        }
        if (i < sortedSegs.length - 1) {
          const next = sortedSegs[i + 1];
          if (!segAssignment.has(next)) {
            segAssignment.set(next, opposite);
            changed = true;
          }
        }
      }
    }

    // Apply: for each device, check if its S-terminal segment matches pattern
    for (const dev of groupDevices) {
      const sTerm = dev.terminals.find((t) => t.name === "S");
      const dTerm = dev.terminals.find((t) => t.name === "D");
      if (!sTerm || !dTerm) continue;

      // Find which segment this device uses as S-side
      // In detectMOSFromLayers: S-side = seg[gi], D-side = seg[gi+1]
      // Excluding non-segment shapes (well/other)
      const sSegId = sTerm.shapeIds?.find(
        (sid) => sid.includes("_seg"),
      );
      if (!sSegId) continue;

      const expectedS = segAssignment.get(sSegId);
      if (!expectedS) continue;

      if (expectedS === "D") {
        // S-terminal is on a segment the pattern says should be D → swap.
        // Pattern stays unchanged — each device is checked independently.
        _swapDSTerminals(dev);
      }
      // If expectedS === "S", S-terminal is correct — no swap needed
    }

    // Mark ALL devices in the group as resolved after propagation.
    // Devices that didn't need a swap also get _dsResolved so the
    // display shows "S"/"D" instead of "S/D".
    for (const dev of groupDevices) {
      (dev as any)._dsResolved = true;
    }

    // ── Deduplicate termPoints within multi-finger group ───────
    // Shared segments (e.g., seg1 used by both Gate0 and Gate1) produce
    // multiple termPoints at the same contact position — one per device.
    // Remove duplicates: keep only the FIRST termPoint at each position.
    const seenPos = new Set<string>();
    for (const dev of groupDevices) {
      const pts = (dev as any)._termPoints as
        Array<{x:number;y:number;name:string}> | undefined;
      if (!pts) continue;
      for (let i = pts.length - 1; i >= 0; i--) {
        const key = `${Math.round(pts[i].x)},${Math.round(pts[i].y)}`;
        if (seenPos.has(key)) {
          pts.splice(i, 1); // duplicate — remove
        } else {
          seenPos.add(key);
        }
      }
    }
  }
}
