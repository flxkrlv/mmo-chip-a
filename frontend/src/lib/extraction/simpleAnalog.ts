/**
 * simpleAnalog.ts — Маркерная аналоговая детекция.
 *
 * Пользователь явно рисует слои-маркеры устройств.
 * Никакой Clipper2, никакой авто-детекции по геометрии.
 *
 * NPN:  npn_id + collector + base + emitter
 * MOS:  mos_id + drain + gate + source + bulk (W/L из bbox маркера)
 * RES:  res_id + contact×2
 * CAP:  cap_id + capacitor_bottom + capacitor_top
 * DIO:  diode_id
 */

import type {
  AnalogDevice, CellLayers, DeviceGeometry,
  DeviceKind, LayerShape,
} from "shared";
import { polygonBounds } from "../geometry";
import type { Rect } from "../geometry";

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
        const x1 = Math.min(s.x1, s.x2), x2 = Math.max(s.x1, s.x2);
        const y1 = Math.min(s.y1, s.y2), y2 = Math.max(s.y1, s.y2);
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
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
    mos_id: "mos",
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
    bjt_npn: "Q", bjt_pnp: "Q", mos: "M",
    resistor: "R", capacitor: "C", diode: "D",
  };

  for (const marker of markers) {
    counter++;
    const devId = `analog_${marker.kind}_${counter}`;
    const prefix = prefixMap[marker.kind] ?? "X";

    switch (marker.kind) {
      // ── BJT ──────────────────────────────────────────────────
      case "bjt_npn":
      case "bjt_pnp": {
        const collectors = shapesInside(layers, "collector", marker.bbox);
        const bases = shapesInside(layers, "base", marker.bbox);
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

        // AE = largest base×emitter overlap
        let maxAE = 0;
        for (const baseS of bases) {
          const bb = shapeBbox(baseS);
          if (!bb) continue;
          for (const emitS of emitters) {
            const eb = shapeBbox(emitS);
            if (!eb) continue;
            maxAE = Math.max(maxAE, overlapArea(bb, eb));
          }
        }
        const ae_um2 = maxAE * umPerPx * umPerPx;

        devices.push({
          id: devId,
          kind: marker.kind,
          geometry: {
            AE_um2: ae_um2,
            PE_um: 0,
            multiplier: 1,
            totalAE_um2: ae_um2,
            emitterFingers: Math.max(emitters.length, 1),
            bjtType: marker.kind === "bjt_npn" ? ("npn" as const) : ("pnp" as const),
          },
          cellTypeId,
          instanceName: `${prefix}${counter}`,
          modelName: "NPN_GEN",
          terminals: [
            { name: "C", netId: terminalNet(collectors) },
            { name: "B", netId: terminalNet(bases) },
            { name: "E", netId: terminalNet(emitters) },
          ],
          bbox: marker.bbox,
        });
        break;
      }

      // ── MOS ──────────────────────────────────────────────────
      case "mos": {
        const drains = shapesInside(layers, "drain", marker.bbox);
        const gates = shapesInside(layers, "gate", marker.bbox);
        const sources = shapesInside(layers, "source", marker.bbox);
        const bulks = shapesInside(layers, "bulk", marker.bbox);

        // W/L from marker bbox: W=width of the gate area, L=height
        const bw = marker.bbox.width * umPerPx;
        const bh = marker.bbox.height * umPerPx;
        const W_um = Math.max(bw, bh);
        const L_um = Math.min(bw, bh);

        function tNet(ts: LayerShape[]): number {
          return ts.length > 0 ? nextNet() : -1;
        }

        devices.push({
          id: devId,
          kind: "mos",
          geometry: {
            L_um,
            W_um,
            fingers: 1,
            multiplier: 1,
            totalW_um: W_um,
            mosType: "unknown",
          },
          cellTypeId,
          instanceName: `${prefix}${counter}`,
          modelName: "CMOS_GEN",
          terminals: [
            { name: "D", netId: tNet(drains) },
            { name: "G", netId: tNet(gates) },
            { name: "S", netId: tNet(sources) },
            { name: "B", netId: tNet(bulks) },
          ],
          bbox: marker.bbox,
        });
        break;
      }

      // ── Resistor ─────────────────────────────────────────────
      case "resistor": {
        const contacts = shapesInside(layers, "contact", marker.bbox);
        const W = marker.bbox.width * umPerPx;
        const L = marker.bbox.height * umPerPx;
        const squares = (W > 0 && L > 0) ? Math.max(L, W) / Math.min(L, W) : 0;

        devices.push({
          id: devId,
          kind: "resistor",
          geometry: {
            L_um: Math.max(L, W),
            W_um: Math.min(L, W),
            squares,
            resistance_ohms: squares * 50,
            fingers: 1,
            multiplier: 1,
            shape: "straight",
          },
          cellTypeId,
          instanceName: `${prefix}${counter}`,
          modelName: "RES_GEN",
          terminals: [
            { name: "PLUS", netId: contacts.length > 0 ? nextNet() : -1 },
            { name: "MINUS", netId: contacts.length > 1 ? nextNet() : -1 },
          ],
          bbox: marker.bbox,
        });
        break;
      }

      // ── Capacitor ────────────────────────────────────────────
      case "capacitor": {
        const area = marker.bbox.width * marker.bbox.height * umPerPx * umPerPx;
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
            { name: "PLUS", netId: nextNet() },
            { name: "MINUS", netId: nextNet() },
          ],
          bbox: marker.bbox,
        });
        break;
      }

      // ── Diode ────────────────────────────────────────────────
      case "diode": {
        const area = marker.bbox.width * marker.bbox.height * umPerPx * umPerPx;
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
            { name: "PLUS", netId: nextNet() },
            { name: "MINUS", netId: nextNet() },
          ],
          bbox: marker.bbox,
        });
        break;
      }
    }
  }
  return devices;
}
