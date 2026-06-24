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
import { polygonBounds } from "../geometry";
import type { Point, Rect } from "../geometry";
import {
  getClipper,
  isClipperLoaded,
  polygonDifference,
  polygonInflate,
  polygonIntersection,
  ringSignedArea,
} from "./clipper";
import { shapeToPolygon } from "./common";
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
    res_id: "resistor",
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

        const contactIds = contacts.map(c => c.id);

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
            { name: "PLUS", netId: contacts.length > 0 ? nextNet() : -1, shapeIds: contactIds },
            { name: "MINUS", netId: contacts.length > 1 ? nextNet() : -1, shapeIds: contactIds },
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
  if (!isClipperLoaded()) {
    console.log(`[analog] splitDiffusionAtGates: Clipper NOT loaded, skip`);
    return null;
  }
  getClipper(); // safe after isClipperLoaded()
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
              const gN = nextNet();

              const terminals: DeviceTerminal[] = [
                { name: "D", netId: dN, shapeIds: [segD.id] },
                { name: "G", netId: gN, shapeIds: [gate.id] },
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

  return devices;
}
