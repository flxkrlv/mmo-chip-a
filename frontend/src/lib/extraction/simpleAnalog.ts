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
 *   single-finger:  one device per diffusion
 *   multi-finger:   Clipper2 diff split → N devices (one per gate)
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
 * Clipper2 diffusion splitting for multi-finger MOS. The die-level pipeline
 * (dieWideAnalog.ts) reads these shapes and injects them into ctLayers so
 * resolveDeviceContacts can find the correct segment polygons.
 */
const _segmentShapesCache = new Map<string, LayerShape[]>();
export function consumeSegmentShapes(
  deviceId: string,
): LayerShape[] {
  const shapes = _segmentShapesCache.get(deviceId) ?? [];
  _segmentShapesCache.delete(deviceId);
  return shapes;
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
        console.log(`[analog] resistor ${marker.id}: ${contacts.length} contacts, ${bodyShapes.length} body (${lines.length} lines)`);
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
            console.log(`[analog]   ME1[${mi}] ${allMe1[mi].id}: hits body, ctIds=[${[...ctIds].join(",")}]`);
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
          console.log(`[analog]   ME1 groups: ${groups.length}`);
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
              console.log(`[analog]   split OK: PLUS=${plusContactIds.join(",")}  MINUS=${minusContactIds.join(",")}`);
            }
          }
        }
        if (plusContactIds.length === 0) {
          plusContactIds = contacts.map((c) => c.id);
          console.log(`[analog]   FALLBACK: all ${contacts.length} contacts → PLUS`);
        }
        if (minusContactIds.length === 0) {
          minusContactIds = contacts.map((c) => c.id);
          console.log(`[analog]   FALLBACK: all ${contacts.length} contacts → MINUS`);
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

  // Collect existing marker bboxes so we don't double-detect BJT layers.
  const markerBboxes = markers.map((m) => m.bbox);
  function insideMarker(bbox: Rect): boolean {
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    return markerBboxes.some(
      (mb) =>
        cx >= mb.x &&
        cx <= mb.x + mb.width &&
        cy >= mb.y &&
        cy <= mb.y + mb.height,
    );
  }

  for (const bl of BODY_LAYERS_GEO) {
    const bodyShapes = allLayersRec[bl.layer] ?? [];
    for (const bodyShape of bodyShapes) {
      const bodyBbox = shapeBbox(bodyShape);
      if (!bodyBbox) continue;

      // Skip body shapes that belong to a BJT/cap/diode marker area.
      if (insideMarker(bodyBbox)) continue;

      // ── Find ME1 shapes intersecting this body ────────────────
      const bodyPoly = shapeToPolygon(bodyShape);
      const me1List = (allLayersRec.metal1 ?? []).filter((me1) =>
        polygonsIntersect(bodyPoly, shapeToPolygon(me1)),
      );
      if (me1List.length < 2) continue;

      // Build UF: ME1 shapes that overlap are connected.
      const uf = new UnionFind(me1List.length);
      const me1Polys = me1List.map((m) => shapeToPolygon(m));
      for (let i = 0; i < me1List.length; i++) {
        for (let j = i + 1; j < me1List.length; j++) {
          if (polygonsIntersect(me1Polys[i], me1Polys[j])) uf.union(i, j);
        }
      }

      // Group contacts by UF component.
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
      console.log(
        `[analog] geo-resistor body ${bodyShape.id}: ${groups.length} ME1 groups, ${contactCount} contacts`,
      );
      if (groups.length < 2) continue;

      // ── Geometry (L/W/squares) ────────────────────────────────
      let L_um = 0,
        W_um = 0,
        squares = 0,
        corners = 0;
      const lines = bodyShapes.filter(
        (s) => s.kind === "line",
      ) as Array<{
        kind: "line";
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        width: number;
      }>;
      if (lines.length > 0) {
        let totalL = 0;
        W_um = (lines[0].width || 4) * umPerPx;
        let prevAngle: number | null = null;
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          const dx = l.x2 - l.x1,
            dy = l.y2 - l.y1;
          const segLen = Math.sqrt(dx * dx + dy * dy);
          totalL += segLen;
          if (i > 0) {
            const angle = Math.atan2(dy, dx);
            if (
              prevAngle != null &&
              Math.abs(angle - prevAngle) > Math.PI / 6
            )
              corners++;
            prevAngle = angle;
          } else {
            prevAngle = Math.atan2(dy, dx);
          }
        }
        L_um = totalL * umPerPx;
        squares =
          (totalL - corners * lines[0].width) / lines[0].width +
          0.55 * corners;
      } else {
        W_um = bodyBbox.width * umPerPx;
        L_um = bodyBbox.height * umPerPx;
        squares =
          W_um > 0 && L_um > 0
            ? Math.max(L_um, W_um) / Math.min(L_um, W_um)
            : 0;
      }

      // ── Sort groups along body axis to assign PLUS/MINUS ─────
      const sortByX = bodyBbox.width >= bodyBbox.height;
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
      // Include body shapeId in terminals so cell viewer overlay
      // highlights the resistor body.
      const plusTermIds = [...plusContactIds, bodyShape.id];
      const minusTermIds = [...minusContactIds, bodyShape.id];

      counter++;
      const devId = `analog_resistor_geo_${counter}`;
      const resistorType = bl.type;
      devices.push({
        id: devId,
        kind: "resistor",
        geometry: {
          L_um,
          W_um,
          squares,
          resistance_ohms:
            squares *
            effectiveSheetR(resistorType as ResistorType, undefined),
          fingers: 1,
          multiplier: 1,
          shape: lines.length > 0 ? "meander" : "straight",
          resistorType: resistorType as any,
        },
        cellTypeId,
        instanceName: `R${counter}`,
        modelName: "RES_GEN",
        terminals: [
          {
            name: "PLUS",
            netId: nextNet(),
            shapeIds: plusTermIds,
          },
          {
            name: "MINUS",
            netId: nextNet(),
            shapeIds: minusTermIds,
          },
        ],
        bbox: bodyBbox,
      });
      console.log(
        `[analog] geo-resistor ${devId}: PLUS=${plusContactIds.join(",")} MINUS=${minusContactIds.join(",")}`,
      );
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
  console.log(`[analog] splitDiffusionAtGates: ${gateShapes.length} gates for ${devId}`);

  const diffPoly = shapeToPolygon(bodyShape);
  console.log(`[analog]  diffPoly pts=${diffPoly.length}, bbox=${JSON.stringify(polygonBounds(diffPoly))}`);
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
  console.log(`[analog]  sorted gates: ${sortedGatePolys.map((g,i) => `${i}:(${g.cx.toFixed(1)},${g.cy.toFixed(1)})`).join(", ")}`);

  // Iteratively cut: start with full diffusion, cut at each gate poly.
  // This gives deterministic ordering of pieces.
  console.log(`[analog]  starting diffPoly pts=${diffPoly.length}, area=${ringSignedArea(diffPoly).toFixed(2)}`);
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
      console.log(`[analog]   piece bbox=${JSON.stringify(pb)}, gate bbox=${JSON.stringify(gb)}`);
      const diff = polygonDifference(piece, [gp.poly]);
      const before = nextPieces.length;
      for (const ring of diff) {
        const ringArea = ringSignedArea(ring);
        console.log(`[analog]   diff ring area=${ringArea.toFixed(2)}, pts=${ring.length}`);
        if (Math.abs(ringArea) < 1.0) continue; // discard noise (Clipper CW rings → negative area)
        nextPieces.push(ring);
      }
      console.log(`[analog]   => ${nextPieces.length - before} pieces kept of ${diff.length} diff rings`);
    }
    pieces = nextPieces;
    console.log(`[analog]   after gate: ${pieces.length} pieces`);
  }

  if (pieces.length < 2) {
    console.log(`[analog] splitDiffusionAtGates: got ${pieces.length} pieces, need >=2`);
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

  console.log(`[analog] splitDiffusionAtGates: ${shapes.length} segments created`);
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

  // ── For each candidate terminal, collect overlapping contacts' UF roots ─
  // Terminal → set of UF roots (contacts overlapping this terminal).
  // Only MOS D/S and resistor PLUS/MINUS are processed.
  // Other devices (BJT, cap, diode-marker) are resolved at die level.
  const termRoots = new Map<string, Set<number>>();
  for (const dev of devices) {
    // MOS: merge D and S terminals (gate handled by polyGateNetMap, bulk by -2)
    // Resistor: merge PLUS and MINUS (shapeIds now split spatially)
    if (dev.kind !== "mos" && dev.kind !== "resistor") continue;
    for (const term of dev.terminals) {
      if (dev.kind === "mos" && term.name !== "D" && term.name !== "S") continue;
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

  console.log(`[analog] mergeMetalConnectedTerminals: ${rootToTerms.size} metal component(s)`);

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
      console.log(`[analog]  merge: ${devId}.${termName} → net=${netId}`);
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
 * Returns devices with D, G, S, B terminals (dummy net IDs — the die-wide
 * pipeline resolves real nets later).
 */
export function detectMOSFromLayers(
  layers: CellLayers | undefined,
  cellTypeId: string,
  umPerPx: number,
): AnalogDevice[] {
  if (!layers) return [];
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

  console.log(`[analog] polyGateNetMap: ${polys.length} polys, clipperLoaded=${isClipperLoaded()}`);

  if (polys.length > 0) {
    // Connected components via Clipper2 overlap test.
    // Poly shapes that physically intersect share one gate netId.
      const pp = polys.map((p) => ({ id: p.id, poly: shapeToPolygon(p) }));
      pp.forEach((p, i) => {
        const b = polygonBounds(p.poly)!;
        console.log(`[analog]  poly[${i}] id=${p.id} bbox=(${b.x.toFixed(1)},${b.y.toFixed(1)},${b.width.toFixed(1)},${b.height.toFixed(1)})`);
      });
      const uf = new UnionFind(pp.length);
      let mergeCount = 0;
      for (let i = 0; i < pp.length; i++) {
        const bi = polygonBounds(pp[i].poly)!;
        for (let j = i + 1; j < pp.length; j++) {
          const bj = polygonBounds(pp[j].poly)!;
          if (!rectsIntersect(bi, bj)) continue;
          if (polygonsIntersect(pp[i].poly, pp[j].poly)) {
            console.log(`[analog]  MERGE poly[${i}](${pp[i].id}) ↔ poly[${j}](${pp[j].id})`);
            uf.union(i, j);
            mergeCount++;
          }
        }
      }
      console.log(`[analog]  merged ${mergeCount} pairs into ${new Set(Array.from({length:pp.length},(_,i)=>uf.find(i))).size} component(s)`);
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
    console.log(`[analog]  gateNetFor FALLBACK polyId=${polyId} → new net=${newNet}`);
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

        console.log(`[analog]  body ${body.id}: ${gates.length} gate(s): ${gates.map(g=>`${g.id}`).join(", ")} → gateNets: ${gates.map(g=>polyGateNetMap.get(g.id)).join(", ")}`);

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

        // ── Multi-finger split (fingers > 1) ─────────────────
        // Use Clipper2 to physically cut the diffusion at gate polys,
        // creating N+1 segments. Each segment becomes S/D for the
        // adjacent gate; shared segments between gates are assigned to
        // both D of the left gate and S of the right gate.
        if (fingers > 1) {
          console.log(`[analog] detectMOSFromLayers: ${fingers} fingers for ${devId}, body=${body.id}`);
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
              });
            }
            counter++; // advance counter once for all sub-devices
          } else {
            console.log(`[analog] detectMOSFromLayers: Clipper split failed (got ${split?.segments.length ?? 0} segments, expected ${fingers + 1}), fallback to single device`);
            // Clipper split failed (not loaded or unexpected result) →
            // fall through to single-device fallback below.
            // ── S/D terminals (single-device fallback) ─────────────
            const diffContacts = contacts.filter((c) => {
              const cb = shapeBbox(c);
              return cb && overlapArea(bodyBox, cb) > 0;
            });
            const sNet = diffContacts.length > 0 ? nextNet() : -1;
            const dNet = diffContacts.length > 1 ? nextNet() : -1;
            const gNet = nextNet();

            const gateIds = gates.map(g => g.id);
            const bodyId = body.id;
            const wellId = well.id;

            const terminals: DeviceTerminal[] = [
              { name: "D", netId: dNet, shapeIds: [bodyId] },
              { name: "G", netId: gNet, shapeIds: gateIds },
              { name: "S", netId: sNet, shapeIds: [bodyId] },
              { name: "B", netId: bulkNetId, shapeIds: [wellId] },
            ];

            const geometry: DeviceGeometryMOS = {
              L_um,
              W_um,
              fingers,
              multiplier: 1,
              totalW_um: W_um * fingers,
              mosType,
            };

            devices.push({
              id: devId,
              kind: "mos",
              geometry,
              cellTypeId,
              instanceName: `M_${counter}`,
              modelName: mosType === "pmos" ? "PMOS" : "NMOS",
              terminals,
              bbox: bodyBox,
            });
            counter++;
          }
        } else {
          // ── S/D terminals (single-finger MOS) ────────────────
          const diffContacts = contacts.filter((c) => {
            const cb = shapeBbox(c);
            return cb && overlapArea(bodyBox, cb) > 0;
          });
          const sNet = diffContacts.length > 0 ? nextNet() : -1;
          const dNet = diffContacts.length > 1 ? nextNet() : -1;
          const gNet = gateNetFor(gates[0].id);

          const gateIds = gates.map(g => g.id);
          const bodyId = body.id;
          const wellId = well.id;

          const gShapeIds = [...new Set([...gateIds, ...allPolyIdsForGateNet(gNet)])];
          const terminals: DeviceTerminal[] = [
            { name: "D", netId: dNet, shapeIds: [bodyId] },
            { name: "G", netId: gNet, shapeIds: gShapeIds },
            { name: "S", netId: sNet, shapeIds: [bodyId] },
            { name: "B", netId: bulkNetId, shapeIds: [wellId] },
          ];

          const geometry: DeviceGeometryMOS = {
            L_um,
            W_um,
            fingers,
            multiplier: 1,
            totalW_um: W_um * fingers,
            mosType,
          };

          devices.push({
            id: devId,
            kind: "mos",
            geometry,
            cellTypeId,
            instanceName: `M_${counter}`,
            modelName: mosType === "pmos" ? "PMOS" : "NMOS",
            terminals,
            bbox: bodyBox,
          });
          counter++;
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

  // Debug: итоговые device gate nets
  console.log(`[analog] detectMOSFromLayers: ${devices.length} devices total`);
  for (const d of devices) {
    const gTerm = d.terminals.find((t) => t.name === "G");
    const sTerm = d.terminals.find((t) => t.name === "S");
    const dTerm = d.terminals.find((t) => t.name === "D");
    console.log(`[analog]   ${d.instanceName ?? d.id}: G=${gTerm?.netId ?? "?"} S=${sTerm?.netId ?? "?"} D=${dTerm?.netId ?? "?"}`);
  }

  return devices;
}
