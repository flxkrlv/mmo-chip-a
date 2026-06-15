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
  DeviceGeometryMOS, DeviceKind, DeviceTerminal, LayerShape,
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
    lpnp_id: "bjt_pnp",
    vpnp: "unknown",
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
        // PNP: try "base" first, then "bulk" (user may have drawn base with bulk tool)
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

        // AE = overlap of emitter with base (standard BJT), or
        // emitter area (LPnp — no separate base, the gap IS the base).
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

        devices.push({
          id: devId,
          kind: "resistor",
          geometry: {
            L_um,
            W_um,
            squares,
            resistance_ohms: squares * 50,
            fingers: 1,
            multiplier: 1,
            shape: lines.length > 0 ? "meander" : "straight",
            resistorType: resistorType as any,
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

/**
 * Well-based MOS detection — alternative to device_box + drain/gate/source/bulk
 * markers.  Infers PMOS/NMOS, bulk terminal, and geometry from:
 *
 *   1. nwell/pwell layers → determines transistor type (P/N) and bulk well
 *   2. diffusion overlapping the well → body region
 *   3. polysilicon crossing the diffusion → gate + S/D sub-regions
 *   4. contacts on the well → bulk net (if no contact, bulk = VCC for nwell,
 *      GND for pwell)
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
  const vias = allLayers["via1"] ?? [];
  const metals1 = allLayers["metal1"] ?? [];

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

        const fingers = gates.length;
        const bw = bodyBox.width * umPerPx;
        const bh = bodyBox.height * umPerPx;
        const W_um = Math.max(bw, bh);
        const L_um = Math.min(bw, bh) / fingers; // shared diffusion, each gate shorter

        counter++;
        const devId = `mos_well_${wellLabel}_${counter}`;

        // ── Bulk net from well contact ────────────────────────
        // Check if any well shape overlaps a contact → follow to metal1.
        let bulkNetId = -1;
        const wellContact = contacts.find((c) => {
          const cb = shapeBbox(c);
          return cb && overlapArea(wellBox, cb) > 0;
        });
        if (wellContact) {
          const wcBox = shapeBbox(wellContact);
          // Check if well contact connects to metal1 (bulk net).
          const metalOverlap = metals1.find((m) => {
            const mb = shapeBbox(m);
            return mb && wcBox && overlapArea(mb, wcBox) > 0;
          });
          bulkNetId = metalOverlap ? nextNet() : -1;
          // Also check via1 (if contact → via → metal1)
          if (bulkNetId < 0) {
            const viaOverlap = vias.find((v) => {
              const vb = shapeBbox(v);
              return vb && wcBox && overlapArea(vb, wcBox) > 0;
            });
            if (viaOverlap) {
              const vmOverlap = metals1.find((m) => {
                const mb = shapeBbox(m);
                const vb = viaOverlap ? shapeBbox(viaOverlap) : null;
                return mb && vb && overlapArea(mb, vb) > 0;
              });
              if (vmOverlap) bulkNetId = nextNet();
            }
          }
        }
        // No well contact → default to VCC (nwell) or GND (pwell)
        if (bulkNetId < 0) {
          bulkNetId = -2; // sentinel: resolves to VCC/GND in wire matching
        }

        // ── S/D terminals ─────────────────────────────────────
        // We can't precisely split diffusion sub-regions here (that needs
        // Clipper2 in cell.ts). Instead use two dummy nets from contacts
        // on the diffusion — the die-wide wire matching will resolve them.
        const diffContacts = contacts.filter((c) => {
          const cb = shapeBbox(c);
          return cb && overlapArea(bodyBox, cb) > 0;
        });
        const sNet = diffContacts.length > 0 ? nextNet() : -1;
        const dNet = diffContacts.length > 1 ? nextNet() : -1;
        const gNet = nextNet();

        const terminals: DeviceTerminal[] = [
          { name: "D", netId: dNet },
          { name: "G", netId: gNet },
          { name: "S", netId: sNet },
          { name: "B", netId: bulkNetId },
        ];

        const geometry: DeviceGeometryMOS = {
          L_um,
          W_um,
          fingers,
          multiplier: 1, // updated below
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
