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
  LayerShape, SpiceConfig, WireLayer,
} from "shared";
import { extractMarkedDevices, detectMOSFromLayers, consumeSegmentShapes, mergeMetalConnectedTerminals, resolveDeviceContacts, applyBulkHeuristic, applySourceOverride, propagateMultiFingerDS } from "../lib/extraction/simpleAnalog";
import { isClipperLoaded } from "../lib/extraction/clipper";
import { generateSpiceNetlist } from "../lib/export/spice";

// ═════════════════════════════════════════════════════════════════
// Wire-to-terminal matching
// ═════════════════════════════════════════════════════════════════

/** Check if any wire segment passes within `tol` px of a point. */
function matchWireToPoint(
  nets: AnnotationNet[],
  px:number, py:number, tol:number,
  netIdMap: Map<string,number>,
  nextId: {v:number},
  allowedLayer?: WireLayer,
): number|null {
  const tol2 = tol*tol;
  for (const net of nets) {
    for (const edge of net.edges) {
      const a = net.nodes.find(n=>n.id===edge.from);
      const b = net.nodes.find(n=>n.id===edge.to);
      if (!a||!b) continue;
      // Layer check: if allowedLayer is set and edge has a defined layer,
      // it must match.  Undefined layer (legacy) is allowed regardless.
      if (allowedLayer && edge.layer && edge.layer !== allowedLayer) continue;
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
  const all = [...well, ...marker];
  mergeMetalConnectedTerminals(all, cellType.layers as Record<string, LayerShape[]>);

  // ── Build ctLayers with injected segment shapes ────────────────
  // resolveDeviceContacts needs the Clipper2 diffusion segments so it
  // can match D/S contacts to the correct segment polygon (shapeIds).
  // Without injection, the segment shapes aren't visible and contacts
  // landing on them won't resolve to the right terminal.
  // This is the same injection the die-level pipeline does per-instance.
  const ctLayersBase = cellType.layers as Record<string, LayerShape[] | undefined>;
  const segShapeIds = new Set<string>();
  const allSegShapes: LayerShape[] = [];
  for (const dev of all) {
    if (dev.id.startsWith("mos_well_")) {
      for (const s of consumeSegmentShapes(dev.id)) {
        if (!segShapeIds.has(s.id)) {
          segShapeIds.add(s.id);
          allSegShapes.push(s);
        }
      }
    }
  }
  const ctLayers = allSegShapes.length > 0
    ? {
        ...ctLayersBase,
        diffusion: [
          ...((ctLayersBase.diffusion ?? []) as LayerShape[]),
          ...allSegShapes,
        ],
      }
    : ctLayersBase;

  // Resolve contact-to-terminal mapping for every device.
  // This populates _termPoints used by both RE Cell and die viewer overlays.
  // At cell level (cx=0,cy=0) — the die-level pipeline re-resolves with
  // the instance offset, but terminal NAMES are identical.
  for (const dev of all) {
    const { termPoints } = resolveDeviceContacts(dev, ctLayers, 0, 0);
    (dev as any)._termPoints = termPoints;
  }

  // ── D/S assignment: bulk heuristic, then force SOURCE override ──
  // Priority: force SOURCE > bulk heuristic > default "S/D".
  // Run bulk heuristic FIRST so source override can correct any
  // mis-assignment if the user explicitly marked a contact.
  applyBulkHeuristic(all);
  const forcedSourceSet = cellType.forcedSourceContacts?.length
    ? new Set(cellType.forcedSourceContacts)
    : undefined;
  applySourceOverride(all, forcedSourceSet);
  // Propagate across multi-finger groups (S/D always alternate)
  propagateMultiFingerDS(all);

  return all;
}

// ═════════════════════════════════════════════════════════════════
// Device-level warnings
// ═════════════════════════════════════════════════════════════════

/**
 * Detect device-level electrical warnings: shorted pins,
 * polarity mismatches, floating terminals, dummy passives.
 */
function detectDeviceWarnings(
  devices: AnalogDevice[],
  namedNets: Map<number, string>,
  spiceConfig?: SpiceConfig,
): string[] {
  const w: string[] = [];

  // Resolve power net ids by name
  const vddNames = [
    spiceConfig?.vdd ?? "VDD",
    "VCC", "vcc", "VDD", "vdd",
  ];
  const gndNames = [
    spiceConfig?.gnd ?? "GND",
    "VSS", "vss", "GND", "gnd",
  ];

  function netName(id: number): string {
    return namedNets.get(id) ?? `NET${id}`;
  }

  for (const d of devices) {
    const inst = d.instanceName ?? d.id;
    const terms = new Map(d.terminals.map((t) => [t.name, t]));

    // ── Helper: short check ──────────────────────────────
    function isShort(nameA: string, nameB: string): boolean {
      const a = terms.get(nameA);
      const b = terms.get(nameB);
      return a !== undefined && b !== undefined && a.netId === b.netId;
    }

    // ── 2T devices (resistor, capacitor) ─────────────────
    if (d.kind === "resistor" || d.kind === "capacitor") {
      if (isShort("PLUS", "MINUS")) {
        w.push(`[INFO] ${inst} (${d.kind}): both pins shorted — dummy ${d.kind}`);
      }
      continue;
    }

    // ── Diode ────────────────────────────────────────────
    if (d.kind === "diode" || d.kind === "zener" || d.kind === "schottky") {
      if (isShort("PLUS", "MINUS")) {
        w.push(`[WARN] ${inst} (${d.kind}): anode=PLUS and cathode=MINUS are shorted`);
      }
      continue;
    }

    // ── BJT ──────────────────────────────────────────────
    if (d.kind === "bjt_npn" || d.kind === "bjt_pnp") {
      const bjtType = (d.geometry as any).bjtType ?? "unknown";

      // C=E → error (shorted transistor)
      if (isShort("C", "E")) {
        w.push(`[WARN] ${inst} (${d.kind}): collector and emitter shorted (same net ${netName(terms.get("C")!.netId)})`);
      }

      // E=B → strange (diode-connected is C=B, which is normal)
      if (isShort("E", "B")) {
        w.push(`[WARN] ${inst} (${d.kind}): emitter and base shorted (same net ${netName(terms.get("E")!.netId)})`);
      }

      // Polarity
      const eNet = terms.get("E")?.netId;
      if (eNet != null) {
        const eName = netName(eNet);
        if (bjtType === "npn" && vddNames.includes(eName)) {
          w.push(`[WARN] ${inst} (NPN): emitter on VDD (${eName}) — will not work`);
        }
        if (bjtType === "pnp" && gndNames.includes(eName)) {
          w.push(`[WARN] ${inst} (PNP): emitter on GND (${eName}) — will not work`);
        }
      }

      // Floating base
      const bNet = terms.get("B")?.netId;
      if (bNet != null && bNet >= 2000) {
        w.push(`[INFO] ${inst} (${d.kind}): base is floating (no connection)`);
      }

      continue;
    }

    // ── MOS ──────────────────────────────────────────────
    if (d.kind === "mos") {
      const mosType = (d.geometry as any).mosType ?? "unknown";

      // D=S → shorted transistor
      if (isShort("D", "S")) {
        w.push(`[WARN] ${inst} (${mosType.toUpperCase()}): drain and source shorted (same net ${netName(terms.get("D")!.netId)})`);
      }

      // D=B — we don't reliably know which is D vs S, so this might
      // actually be source=bulk (normal). Flag as INFO only.
      if (isShort("D", "B")) {
        w.push(`[INFO] ${inst} (${mosType.toUpperCase()}): D and bulk shorted (same net ${netName(terms.get("D")!.netId)}) — may be normal (source=bulk)`);
      }

      // Polarity: both D and S on the same supply suggests wrong type
      const dNet = terms.get("D")?.netId;
      const sNet = terms.get("S")?.netId;
      if (dNet != null && sNet != null && dNet === sNet) {
        const bothName = netName(dNet);
        if (mosType === "nmos" && (vddNames.includes(bothName))) {
          w.push(`[WARN] ${inst} (NMOS): both D and S on VDD (${bothName}) — possibly wrong type (should be PMOS?)`);
        }
        if (mosType === "pmos" && (gndNames.includes(bothName))) {
          w.push(`[WARN] ${inst} (PMOS): both D and S on GND (${bothName}) — possibly wrong type (should be NMOS?)`);
        }
      }

      // D/S not resolved (default positional, "S/D" shown)
      if ((d as any)._dsResolved !== true) {
        w.push(`[INFO] ${inst} (${mosType.toUpperCase()}): D/S not resolved — defaulting to positional assignment. Use force SOURCE or bulk connection to assign.`);
      }

      // Floating gate
      const gNet = terms.get("G")?.netId;
      if (gNet != null && gNet >= 2000) {
        w.push(`[INFO] ${inst} (${mosType.toUpperCase()}): gate is floating (no connection)`);
      }

      continue;
    }
  }

  return w;
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
  /** Net IDs that correspond to die-level IO pins (from ann.pins) */
  ioNetIds: Set<number>;
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

            // 2) Wire name check (case-insensitive, broader than step 1)
            // Scan ALL nets for a case-insensitive match against the supply name.
            // This catches wires named "gnd", "GND!", "gnd_1", etc.
            if (foundNetId == null) {
              for (const n of nets) {
                if (!n.name) continue;
                const lo = n.name.toLowerCase().replace(/[^a-z0-9]/g, "");
                if (targetNames.some(t => lo === t.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
                  if (!netIdMap.has(n.id)) netIdMap.set(n.id, nextNetId.v++);
                  foundNetId = netIdMap.get(n.id)!;
                  break;
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

            return {...t, netId: cachedDieNet};
          }
          const contacts = termContacts[ti];
          // contacts.length === 0 — no contact centers
          for (const cp of contacts) {
            // Only ME1 wires can connect to device contacts.
            // ME2+ requires a via (drawn on die viewer) to bridge up.
            const wid = matchWireToPoint(nets, cp.x, cp.y, cp.tol ?? 10, netIdMap, nextNetId, "metal1");
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

  // Collect die-level IO pin net IDs (used by netlist2svg to limit port count)
  const ioNetIds = new Set<number>();
  const pins = ann.pins ?? [];
  for (const pin of pins) {
    const netId = matchWireToPoint(nets, pin.x, pin.y, 10, netIdMap, nextNetId);
    if (netId != null) {
      ioNetIds.add(netId);
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

  // ── Device-level warnings ──────────────────────────────────
  // Check for shorted pins, polarity mismatches, floating terminals.
  // ── Re-apply D/S resolution at die level ─────────────────────
  // Cell-level mergeMetalConnectedTerminals only catches metal connections
  // WITHIN the cell. Die-level annotation wires connecting B to D/S are
  // only resolved after wire matching above. Re-run so die-level
  // connections also determine D/S assignment.
  applyBulkHeuristic(allDevices);
  propagateMultiFingerDS(allDevices);

  const devWarn = detectDeviceWarnings(allDevices, namedNets, _spiceConfig);
  warnings.push(...devWarn);

  return { devices: allDevices, namedNets, netIdMap, warnings, ioNetIds };
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
