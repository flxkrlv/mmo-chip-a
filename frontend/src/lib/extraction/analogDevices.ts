/**
 * analogDevices.ts — Analog/Mixed-Signal Device Detection (Phase 1)
 *
 * Detects BJT, JFET, resistors, capacitors, and diodes from annotated
 * layer geometry, computes SPICE parameters (W/L, AE, squares, etc.),
 * and produces AnalogDevice entries compatible with CDL/Spectre export.
 *
 * This runs alongside the existing CMOS extraction (cell.ts) — it does
 * NOT replace it. CMOS transistors are still handled by extractCell;
 * this module catches everything else.
 *
 * Detection strategy (per device type):
 *
 *   BJT (NPN):   nwell → p-base diffusion → n+ emitter diffusion + contacts
 *   BJT (PNP):   pwell | nwell → n-base → p+ emitter
 *   JFET (N):    p+ gate implant → n channel → metal contacts on channel ends
 *   JFET (P):    n+ gate → p channel
 *   Resistor:    poly/diff/well body with ≥2 contacts on opposite ends
 *   Capacitor:   two overlapping plates of different layers, NO contact between
 *   Diode:       single diffusion strip + contact, no poly crossing (else MOS)
 *
 * All geometry is in cell-local coordinates. Scaling to μm uses
 * DetectionContext.umPerPx.
 */

import type {
  AnalogDevice,
  AnnotationRect,
  DeviceGeometry,
  DeviceGeometryBJT,
  DeviceGeometryCapacitor,
  DeviceGeometryDiode,
  DeviceGeometryJFET,
  DeviceGeometryMOS,
  DeviceGeometryResistor,
  DeviceKind,
  DeviceTerminal,
  LayerShape,
  LayerType,
} from "shared";
import type { ExtractedNet, ExtractedShape, InferredDiffusion, Transistor } from "./cell";
import { polygonBounds, shapeToPolygon } from "./common";
import type { Point, Rect } from "../geometry";
import {
  pointInPolygon,
  rectsIntersect,
} from "../geometry";

// ── Context ──────────────────────────────────────────────────────

export interface DetectionContext {
  /** Cell-local shapes; may include user-drawn analog layers */
  shapes: ExtractedShape[];
  /** Original (user-drawn) transistor structures from CMOS pipeline */
  transistors: Transistor[];
  /** Original diffusions with inferred type */
  diffusions: InferredDiffusion[];
  /** Nets and connectivity */
  nets: ExtractedNet[];
  /** Scale: μm per pixel (from die metadata / user config) */
  umPerPx: number;
  /** User-set sheet resistance per resistor layer [Ω/□] */
  sheetR_ohms?: Record<string, number>;
  /** User-set capacitance density per cap layer [fF/μm²] */
  capDensity_fF?: Record<string, number>;
  /** Index shapes by layer for fast lookups */
  shapesByLayer: Record<string, ExtractedShape[]>;
}

// ── Geometry helpers (self-contained for analog use) ────────────

/** Compute the signed area of a polygon (positive = CCW). */
export function ringSignedArea(ring: ReadonlyArray<Point>): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  }
  return a / 2;
}

/** Compute the area of a polygon (always positive). */
export function shapeArea(polygon: ReadonlyArray<Point>): number {
  return Math.abs(ringSignedArea(polygon));
}

/** Compute the perimeter of a polygon. */
export function shapePerimeter(polygon: ReadonlyArray<Point>): number {
  let p = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    p += Math.hypot(polygon[i].x - polygon[j].x, polygon[i].y - polygon[j].y);
  }
  return p;
}

/**
 * Shape-to-polygon helper: extract the outer ring of any LayerShape.
 * Falls back to a rectangular ring for rect/circle/line/point.
 */
export function shapePolygon(s: LayerShape): Point[] {
  return shapeToPolygon(s);
}

/** Bounding box of a shape. */
export function shapeBbox(s: LayerShape): Rect | null {
  return polygonBounds(shapePolygon(s));
}

/**
 * Approximate the angle of a poly's longest axis (radians, 0-π).
 * Uses PCA: find the eigenvector of the covariance of the vertices.
 */
export function polygonPrincipalAngle(pts: ReadonlyArray<Point>): number {
  if (pts.length < 3) return 0;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let xx = 0, xy = 0, yy = 0;
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy;
    xx += dx * dx; xy += dx * dy; yy += dy * dy;
  }
  // angle of the first eigenvector = 0.5 * atan2(2*xy, xx - yy)
  return 0.5 * Math.atan2(2 * xy, xx - yy);
}

/**
 * Distance from a point to a line segment.
 */
function distToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

/**
 * Thin a polygon to a centerline by iteratively removing boundary vertices
 * that are safe to remove (the Ramer-Douglas-Peucker–like approach).
 *
 * For long rectangular resistor bodies this returns a single segment
 * [center-of-one-end, center-of-other-end]. For meanders it returns
 * the polyline mid-axis.
 *
 * Simple implementation: sample the polygon at even spacing,
 * find the medial axis by connecting midpoints of anti-podal edges.
 * For the prototype, we compute the average of the two
 * "long edges" of the oriented bounding box.
 */
export function bodyCenterline(poly: ReadonlyArray<Point>): Point[] {
  if (poly.length < 4) return poly;

  // Build edges with direction and midpoint.
  const edges: { len: number; mid: Point; ndx: number; ndy: number }[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const dx = poly[i].x - poly[j].x, dy = poly[i].y - poly[j].y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    edges.push({
      len,
      mid: { x: (poly[j].x + poly[i].x) / 2, y: (poly[j].y + poly[i].y) / 2 },
      ndx: dx / len, ndy: dy / len,
    });
  }
  if (edges.length < 2) return [...poly];

  // Find the pair of parallel edges that are FARTHEST apart (perpendicular distance).
  // These are the end-caps of the resistor body; the centerline connects their midpoints.
  let bestI = 0, bestJ = 1, bestDist = -1;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i], b = edges[j];
      // Parallel check: dot product of unit directions ≈ ±1
      const dot = a.ndx * b.ndx + a.ndy * b.ndy;
      if (Math.abs(dot) < 0.95) continue;
      // Perpendicular distance between the two midpoints
      // = cross product of (midB - midA) with unit direction
      const perpDist = Math.abs(
        -a.ndy * (b.mid.x - a.mid.x) + a.ndx * (b.mid.y - a.mid.y),
      );
      if (perpDist > bestDist) {
        bestDist = perpDist;
        bestI = i;
        bestJ = j;
      }
    }
  }

  return [
    { x: edges[bestI].mid.x, y: edges[bestI].mid.y },
    { x: edges[bestJ].mid.x, y: edges[bestJ].mid.y },
  ];
}

/**
 * Length of the centerline polyline.
 */
export function bodyCenterlineLength(line: Point[]): number {
  let len = 0;
  for (let i = 1; i < line.length; i++) {
    len += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
  }
  return len;
}

/**
 * Average width of a polygon perpendicular to its centerline.
 * W = 2 * area / length (for a rectilinear shape).
 */
export function bodyAvgWidth(poly: ReadonlyArray<Point>, cl: Point[]): number {
  const area = shapeArea(poly);
  if (area === 0) return 0;
  const clLen = bodyCenterlineLength(cl);
  if (clLen === 0) return 0;
  return area / clLen;
}

/**
 * Compute squares = L / W for a resistor body.
 */
export function computeSquares(L_um: number, W_um: number): number {
  if (W_um <= 0) return 0;
  return L_um / W_um;
}

/**
 * Count parallel gate fingers in a set of poly shapes crossing a diffusion.
 * A finger = a distinct poly segment that spans the diffusion's bounds.
 */
export function countFingers(
  diffPoly: ReadonlyArray<Point>,
  polys: ExtractedShape[],
): number {
  const dBounds = polygonBounds(diffPoly);
  if (!dBounds) return 1;
  return polys.filter((p) => {
    const pBounds = polygonBounds(p.polygon);
    return pBounds && rectsIntersect(pBounds, dBounds);
  }).length || 1;
}

/** Centroid (center of mass) of a polygon. */
export function polygonCentroid(pts: ReadonlyArray<Point>): Point {
  if (pts.length === 0) return { x: 0, y: 0 };
  let cx = 0, cy = 0, area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    area += a;
    cx += (pts[j].x + pts[i].x) * a;
    cy += (pts[j].y + pts[i].y) * a;
  }
  area = area / 2;
  if (Math.abs(area) < 1e-12) return { x: pts[0].x, y: pts[0].y };
  const f = 1 / (6 * area);
  return { x: cx * f, y: cy * f };
}

/**
 * Detect repetition count (multiplier) for identical parallel structures.
 * Looks for repeated instances of the same shape pattern along X or Y axis.
 * Returns 1 if only one instance detected.
 */
export function detectMultiplier(
  shapes: ExtractedShape[],
  axis: "x" | "y",
): number {
  if (shapes.length < 2) return 1;
  // Try to find repeating centroids with equal spacing
  const centroids = shapes.map((s) => polygonCentroid(s.polygon));
  const coord = axis === "x" ? (p: Point) => p.x : (p: Point) => p.y;
  const vals = centroids.map(coord).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < vals.length; i++) {
    const g = vals[i] - vals[i - 1];
    if (g > 0.5) gaps.push(g);
  }
  if (gaps.length < 1) return 1;
  // Most common gap
  const gapCounts = new Map<number, number>();
  for (const g of gaps) {
    const rounded = Math.round(g * 10) / 10;
    gapCounts.set(rounded, (gapCounts.get(rounded) ?? 0) + 1);
  }
  const commonGap = [...gapCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  // Count how many shapes are spaced by this gap
  let count = 1;
  let last = vals[0];
  for (let i = 1; i < vals.length; i++) {
    const diff = Math.abs(vals[i] - last - commonGap);
    if (diff < 0.5) {
      count++;
      last = vals[i];
    }
  }
  return count;
}

// ── Terminal helpers ─────────────────────────────────────────────

function makeTerminal(name: string, shapeIds: string[], netLookup: Map<string, number>): DeviceTerminal {
  const netId = shapeIds.length > 0
    ? (netLookup.get(shapeIds[0]) ?? -1)
    : -1;
  return { name, netId };
}

// ── Layer-indexing helper ────────────────────────────────────────

function buildLayerIndex(
  shapes: ExtractedShape[],
): Record<string, ExtractedShape[]> {
  const idx: Record<string, ExtractedShape[]> = {};
  for (const s of shapes) {
    const key = s.layer;
    if (!idx[key]) idx[key] = [];
    idx[key].push(s);
  }
  return idx;
}

function buildNetLookup(shapes: ExtractedShape[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of shapes) {
    if (s.netId >= 0) m.set(s.id, s.netId);
  }
  return m;
}

// ═════════════════════════════════════════════════════════════════
// Geometry parameter computation
// ═════════════════════════════════════════════════════════════════

/**
 * Compute MOS W/L from gate poly and diffusion sub-region geometry.
 *
 * L = width of poly gate where it crosses diffusion
 * W = width of diffusion along the gate edge (perpendicular to L)
 */
export function computeMOSParams(
  gatePoly: ReadonlyArray<Point>,
  diffSubRegion: ReadonlyArray<Point>,
  umPerPx: number,
): { W_um: number; L_um: number } {
  if (umPerPx <= 0) umPerPx = 1;

  const dBounds = polygonBounds(diffSubRegion);
  const gBounds = polygonBounds(gatePoly);
  if (!dBounds || !gBounds) return { W_um: 0, L_um: 0 };

  // Overlap bbox = intersection of the two bounding boxes
  const ox = Math.max(dBounds.x, gBounds.x);
  const oy = Math.max(dBounds.y, gBounds.y);
  const ox2 = Math.min(dBounds.x + dBounds.width, gBounds.x + gBounds.width);
  const oy2 = Math.min(dBounds.y + dBounds.height, gBounds.y + gBounds.height);
  if (ox >= ox2 || oy >= oy2) return { W_um: 0, L_um: 0 };

  // L = the gate dimension perpendicular to current flow
  // For a vertical gate spanning horizontal diffusion: L = gate width (X)
  // For a horizontal gate: L = gate height (Y)
  // We determine orientation from the longer axis of the OVERLAP region
  const ow = ox2 - ox, oh = oy2 - oy;

  let L_px: number, W_px: number;
  if (ow < oh) {
    // Gate runs vertically: L = gate width (X), W = diffusion height (Y) along gate
    L_px = ow;
    W_px = oh;
  } else {
    // Gate runs horizontally: L = gate height (Y), W = diffusion width (X)
    L_px = oh;
    W_px = ow;
  }

  // Attempt more accurate: measure the actual intersection polygon
  // For now, bbox intersection is sufficient for standard cell layouts.

  return {
    W_um: Math.max(W_px * umPerPx, 0.1),
    L_um: Math.max(L_px * umPerPx, 0.1),
  };
}

/**
 * Compute BJT emitter area from base and emitter polygons.
 * AE = intersection area of base diffusion and emitter diffusion.
 */
export function computeBJTParams(
  basePoly: ReadonlyArray<Point>,
  emitterPoly: ReadonlyArray<Point>,
  umPerPx: number,
): { AE_um2: number; PE_um: number } {
  if (umPerPx <= 0) umPerPx = 1;

  // For the prototype: approximate base-emitter overlap
  // by intersecting bounding boxes (refined with Clipper2 later)
  const bBounds = polygonBounds(basePoly);
  const eBounds = polygonBounds(emitterPoly);
  if (!bBounds || !eBounds) return { AE_um2: 0, PE_um: 0 };

  const ox = Math.max(bBounds.x, eBounds.x);
  const oy = Math.max(bBounds.y, eBounds.y);
  const ox2 = Math.min(bBounds.x + bBounds.width, eBounds.x + eBounds.width);
  const oy2 = Math.min(bBounds.y + bBounds.height, eBounds.y + eBounds.height);
  if (ox >= ox2 || oy >= oy2) return { AE_um2: 0, PE_um: 0 };

  const area_px2 = (ox2 - ox) * (oy2 - oy);
  const perim_px = 2 * ((ox2 - ox) + (oy2 - oy));

  return {
    AE_um2: area_px2 * umPerPx * umPerPx,
    PE_um: perim_px * umPerPx,
  };
}

/**
 * Compute resistor parameters from body polygon and contact positions.
 */
export function computeResistorParams(
  bodyPoly: ReadonlyArray<Point>,
  contacts: ReadonlyArray<ExtractedShape>,
  umPerPx: number,
  sheetR?: number,
): {
  L_um: number;
  W_um: number;
  squares: number;
  shape: string;
  resistance_ohms?: number;
  fingers: number;
} {
  if (umPerPx <= 0) umPerPx = 1;

  const cl = bodyCenterline(bodyPoly);
  const L_px = bodyCenterlineLength(cl);
  const W_px = bodyAvgWidth(bodyPoly, cl);
  const L_um = L_px * umPerPx;
  const W_um = W_px * umPerPx;
  const squares = computeSquares(L_um, W_um);
  const resistance_ohms = sheetR != null ? squares * sheetR : undefined;

  // Detect shape type from centerline: more than 1 segment => meander/serpentine
  const isMeander = cl.length > 2 || (cl.length === 2 &&
    Math.abs(cl[0].x - cl[1].x) < Math.abs(cl[0].y - cl[1].y) * 0.3);
  const shape = isMeander ? "meander" : "straight";

  // Fingers: body segments separated by contact-to-contact spacing
  const fingers = contacts.length > 2 ? Math.ceil(contacts.length / 2) : 1;

  return { L_um, W_um, squares, shape, resistance_ohms, fingers };
}

/**
 * Compute capacitor parameters from two overlapping plate polygons.
 */
export function computeCapacitorParams(
  plate1Poly: ReadonlyArray<Point>,
  plate2Poly: ReadonlyArray<Point>,
  umPerPx: number,
  density?: number,
): {
  area_um2: number;
  perimeter_um: number;
  capType: string;
  capacitance_fF?: number;
} {
  if (umPerPx <= 0) umPerPx = 1;

  const b1 = polygonBounds(plate1Poly);
  const b2 = polygonBounds(plate2Poly);
  if (!b1 || !b2) return { area_um2: 0, perimeter_um: 0, capType: "unknown" };

  const ox = Math.max(b1.x, b2.x);
  const oy = Math.max(b1.y, b2.y);
  const ox2 = Math.min(b1.x + b1.width, b2.x + b2.width);
  const oy2 = Math.min(b1.y + b1.height, b2.y + b2.height);
  if (ox >= ox2 || oy >= oy2) return { area_um2: 0, perimeter_um: 0, capType: "unknown" };

  const area_px2 = (ox2 - ox) * (oy2 - oy);
  const perim_px = 2 * ((ox2 - ox) + (oy2 - oy));
  const area_um2 = area_px2 * umPerPx * umPerPx;
  const perimeter_um = perim_px * umPerPx;
  const capType = "unknown"; // caller should set based on plate layers
  const capacitance_fF = density != null ? area_um2 * density : undefined;

  return { area_um2, perimeter_um, capType, capacitance_fF };
}

/**
 * Compute diode parameters from a junction polygon.
 */
export function computeDiodeParams(
  junctionPoly: ReadonlyArray<Point>,
  umPerPx: number,
): { area_um2: number; perimeter_um: number } {
  if (umPerPx <= 0) umPerPx = 1;
  const area_px2 = shapeArea(junctionPoly);
  const perim_px = shapePerimeter(junctionPoly);
  return {
    area_um2: area_px2 * umPerPx * umPerPx,
    perimeter_um: perim_px * umPerPx,
  };
}

// ═════════════════════════════════════════════════════════════════
// Device structure helpers
// ═════════════════════════════════════════════════════════════════

export interface DeviceMatch {
  kind: DeviceKind;
  geometry: DeviceGeometry;
  outlines: Record<string, Point[]>;
  terminals: Record<string, string[]>; // terminalName → shapeIds[]
  bbox: AnnotationRect;
}

let _deviceCounter = 0;
function nextDeviceId(kind: string): string {
  return `analog_${kind}_${++_deviceCounter}`;
}

function makeRectFromPoints(pts: ReadonlyArray<Point>): AnnotationRect {
  const b = polygonBounds(pts);
  return b ?? { x: 0, y: 0, width: 0, height: 0 };
}

function deviceGeometryK(geom: DeviceGeometry): DeviceKind {
  if ("mosType" in geom) return "mos";
  if ("bjtType" in geom) return geom.bjtType === "npn" ? "bjt_npn" : "bjt_pnp";
  if ("jfetType" in geom) return geom.jfetType === "njf" ? "jfet_n" : "jfet_p";
  if ("squares" in geom) return "resistor";
  if ("capType" in geom) return "capacitor";
  if ("diodeType" in geom) return "diode";
  return "unknown";
}

function matchToDevice(
  match: DeviceMatch,
  cellTypeId: string,
  netLookup: Map<string, number>,
  ctx: DetectionContext,
): AnalogDevice {
  const id = nextDeviceId(match.kind);
  const terminals = Object.entries(match.terminals).map(([name, shapeIds]) => ({
    name,
    netId: shapeIds.length > 0 ? (netLookup.get(shapeIds[0]) ?? -1) : -1,
  }));

  const outline = match.outlines.body ?? Object.values(match.outlines)[0] ?? [];
  const bbox = match.bbox;

  return {
    id,
    kind: match.kind,
    geometry: match.geometry,
    cellTypeId,
    instanceName: undefined, // assigned later by the netlister
    modelName: undefined,
    terminals,
    outline: outline.length > 0 ? outline : undefined,
    bbox,
  };
}

// ═════════════════════════════════════════════════════════════════
// Detectors
// ═════════════════════════════════════════════════════════════════

/**
 * Detect MOS transistors (complementary to cell.ts extraction).
 * Uses the existing transistor list and adds geometry parameters.
 */
export function detectMOS(
  shapes: ExtractedShape[],
  transistors: Transistor[],
  diffusions: InferredDiffusion[],
  ctx: DetectionContext,
): DeviceMatch[] {
  const matches: DeviceMatch[] = [];
  const byLayer = ctx.shapesByLayer;
  const polyShapes = (byLayer["polysilicon"] ?? []);
  const diffShapes = (byLayer["diffusion"] ?? []);

  for (const tx of transistors) {
    const gatePoly = polyShapes.find((s) => s.id === tx.gate.shapeId);
    const diffSubRegion = shapes.find((s) => s.id === tx.drain.shapeId || s.id === tx.source.shapeId);
    if (!gatePoly || !diffSubRegion) continue;

    const { W_um, L_um } = computeMOSParams(gatePoly.polygon, diffSubRegion.polygon, ctx.umPerPx);
    const mosType = tx.type === "pmos" ? "pmos" : tx.type === "nmos" ? "nmos" : "unknown";
    const fingers = countFingers(diffSubRegion.polygon, polyShapes);
    const multiplier = detectMultiplier(
      diffShapes.filter((d) => {
        const inf = diffusions.find((idf) => idf.shapeId === d.id);
        return inf && ((mosType === "pmos" && inf.type === "p") || (mosType === "nmos" && inf.type === "n"));
      }),
      "x",
    );

    const geometry: DeviceGeometryMOS = {
      L_um, W_um, fingers, multiplier,
      totalW_um: W_um * fingers * multiplier,
      mosType,
    };

    matches.push({
      kind: "mos",
      geometry,
      outlines: {
        body: diffSubRegion.polygon,
        gate: gatePoly.polygon,
      },
      terminals: {
        D: [tx.drain.shapeId],
        G: [tx.gate.shapeId],
        S: [tx.source.shapeId],
      },
      bbox: makeRectFromPoints(diffSubRegion.polygon),
    });
  }

  return matches;
}

/**
 * Detect BJT (NPN / PNP) transistors.
 *
 * NPN: nwell → p-base diffusion → n+ emitter diffusion + contacts.
 * PNP: pwell / nwell → n-base → p+ emitter.
 * We check for:
 *   1. A well (nwell or pwell)
 *   2. A "base" layer shape inside it
 *   3. An "emitter" layer shape inside the base
 * If layer annotations don't exist yet, fall back to heuristic:
 *   - nwell + p-diff (base) + n-diff (emitter) with contacts
 */
export function detectBJT(
  shapes: ExtractedShape[],
  ctx: DetectionContext,
): DeviceMatch[] {
  const matches: DeviceMatch[] = [];
  const byLayer = ctx.shapesByLayer;

  // Layer-annotated mode
  const nwells = byLayer["nwell"] ?? [];
  const pwells = byLayer["pwell"] ?? [];
  const bases = byLayer["base"] ?? [];
  const emitters = byLayer["emitter"] ?? [];
  const dns = byLayer["deep_nwell"] ?? [];
  const collectorSinkers = byLayer["collector_sinker"] ?? [];

  // If no dedicated base/emitter layers, fall back to diffusion-based detection
  const useLayerMode = bases.length > 0 && emitters.length > 0;

  if (useLayerMode) {
    // For each base, check if it overlaps an nwell (NPN) or pwell (PNP)
    for (const base of bases) {
      const baseBounds = polygonBounds(base.polygon);
      if (!baseBounds) continue;

      // Find emitters inside this base
      const emittersInside = emitters.filter((e) => {
        const eBounds = polygonBounds(e.polygon);
        return eBounds && rectsIntersect(eBounds, baseBounds);
      });

      if (emittersInside.length === 0) continue;

      // Determine NPN vs PNP from well
      const inNwell = nwells.some((w) => rectsIntersect(polygonBounds(w.polygon)!, baseBounds));
      const inPwell = pwells.some((w) => rectsIntersect(polygonBounds(w.polygon)!, baseBounds));
      const isNPN = inNwell || (!inPwell && dns.length > 0);
      const bjtType = isNPN ? "npn" as const : "pnp" as const;

      // Compute emitter area for each emitter
      for (let ei = 0; ei < emittersInside.length; ei++) {
        const emitter = emittersInside[ei];
        const { AE_um2, PE_um } = computeBJTParams(base.polygon, emitter.polygon, ctx.umPerPx);
        const emitterFingers = emittersInside.length;
        const multiplier = 1;

        const geometry: DeviceGeometryBJT = {
          AE_um2, PE_um, multiplier,
          totalAE_um2: AE_um2 * multiplier,
          emitterFingers, bjtType,
        };

        // Find collector — a shape inside the well but OUTSIDE the base.
        // Options: collector_sinker layer, or any n+ shape inside well but not in base.
        const collectorCandidates = [
          ...collectorSinkers.filter((s) => {
            const sb = polygonBounds(s.polygon);
            return sb && rectsIntersect(sb, baseBounds!) &&
              !rectsIntersect(sb, polygonBounds(base.polygon)!);
          }),
          ...emitters.filter((e) => {
            const eb = polygonBounds(e.polygon);
            const bb = polygonBounds(base.polygon);
            return eb && bb &&
              rectsIntersect(eb, baseBounds!) &&
              !rectsIntersect(eb, bb);
          }),
        ];
        const collectorId = collectorCandidates.length > 0
          ? collectorCandidates[0].id
          : `${base.id}_well_tap`;

        const collectorEmit = collectorCandidates.length > 0
          ? collectorCandidates[0].polygon
          : base.polygon;

        matches.push({
          kind: bjtType === "npn" ? "bjt_npn" : "bjt_pnp",
          geometry,
          outlines: {
            collector: collectorEmit,
            base: base.polygon,
            emitter: emitter.polygon,
          },
          terminals: {
            C: [collectorId],
            B: [base.id],
            E: [emitter.id],
          },
          bbox: makeRectFromPoints([...base.polygon, ...emitter.polygon]),
        });
      }
    }
  } else {
    // Diffusion-based heuristic: look for multiple diffusion types stacked
    // (e.g., p-diff inside nwell = base, n+ emitter inside that)
    // This is a simplified version — full implementation needs Clipper.
    for (const diff of (byLayer["diffusion"] ?? [])) {
      const dBounds = polygonBounds(diff.polygon);
      if (!dBounds) continue;

      // Check if this diffusion sits inside an nwell or well
      const insideNwell = nwells.some((w) => {
        const wb = polygonBounds(w.polygon);
        return wb && rectsIntersect(dBounds, wb);
      });

      if (insideNwell) {
        // This diffusion could be a base — check for smaller diffusions inside
        // (emitter fingers). For the prototype, we emit a single BJT
        const { AE_um2, PE_um } = computeBJTParams(diff.polygon, diff.polygon, ctx.umPerPx);
        const geometry: DeviceGeometryBJT = {
          AE_um2: AE_um2 * 0.5, PE_um, // rough estimate
          multiplier: 1,
          totalAE_um2: AE_um2 * 0.5,
          emitterFingers: 1,
          bjtType: "npn",
        };

        matches.push({
          kind: "bjt_npn",
          geometry,
          outlines: { collector: diff.polygon, base: diff.polygon, emitter: diff.polygon },
          terminals: { C: [diff.id], B: [diff.id], E: [diff.id] },
          bbox: makeRectFromPoints(diff.polygon),
        });
      }
    }
  }

  return matches;
}

/**
 * Detect JFET transistors.
 *
 * JFET: a gate diffusion that partially or fully surrounds a channel diffusion
 * of the opposite type. Gate contacts and channel-end contacts.
 *
 * N-JFET: p+ gate → n-channel
 * P-JFET: n+ gate → p-channel
 */
export function detectJFET(
  shapes: ExtractedShape[],
  ctx: DetectionContext,
): DeviceMatch[] {
  const matches: DeviceMatch[] = [];
  const byLayer = ctx.shapesByLayer;
  const jfetGates = byLayer["jfet_gate"] ?? [];
  const jfetChannels = byLayer["jfet_channel"] ?? [];

  if (jfetGates.length === 0 || jfetChannels.length === 0) return matches;

  for (const gate of jfetGates) {
    const gBounds = polygonBounds(gate.polygon);
    if (!gBounds) continue;

    // Find channel inside or adjacent to gate
    for (const channel of jfetChannels) {
      const cBounds = polygonBounds(channel.polygon);
      if (!cBounds) continue;
      if (!rectsIntersect(gBounds, cBounds)) continue;

      // Channel length = longest dimension of channel rect
      // Width = shorter dimension
      const L_px = Math.max(cBounds.width, cBounds.height);
      const W_px = Math.min(cBounds.width, cBounds.height);
      const L_um = L_px * ctx.umPerPx;
      const W_um = W_px * ctx.umPerPx;
      const fingers = 1;
      const multiplier = 1;

      const geometry: DeviceGeometryJFET = {
        W_um, L_um, fingers, multiplier,
        jfetType: "njf", // assume N-JFET (heuristic)
      };

      matches.push({
        kind: "jfet_n",
        geometry,
        outlines: { gate: gate.polygon, channel: channel.polygon },
        terminals: { G: [gate.id], D: [channel.id], S: [channel.id] },
        bbox: makeRectFromPoints([...gate.polygon, ...channel.polygon]),
      });
    }
  }

  return matches;
}

/**
 * Detect resistors from poly/diffusion/well bodies with contacts on two ends.
 *
 * Rules:
 *   1. The body layer is "resistor_body" if user-drawn, else "polysilicon" or
 *      "diffusion" or "nwell" / "pwell".
 *   2. At least two contact shapes must overlap the body near opposite ends.
 *   3. If the body is polysilicon AND it crosses a diffusion, it's a MOS gate
 *      and NOT a resistor — skip unless it also has contacts on ends.
 */
export function detectResistors(
  shapes: ExtractedShape[],
  ctx: DetectionContext,
): DeviceMatch[] {
  const matches: DeviceMatch[] = [];
  const byLayer = ctx.shapesByLayer;
  const netLookup = buildNetLookup(shapes);
  const seenBodyIds = new Set<string>();

  // Candidate body layers for resistors
  const bodyLayers: LayerType[] = ["resistor_body", "polysilicon", "diffusion", "nwell", "pwell"];
  const contacts = byLayer["contact"] ?? [];

  // Already-known transistor gate polys (from existing CMOS extraction)
  const gatePolyIds = new Set(ctx.transistors.map((t) => t.gate.shapeId));

  for (const layer of bodyLayers) {
    const bodies = byLayer[layer];
    if (!bodies || bodies.length === 0) continue;

    for (const body of bodies) {
      const bodyBounds = polygonBounds(body.polygon);
      if (!bodyBounds) continue;

      // Skip if it's a known MOS gate poly
      if (layer === "polysilicon" && gatePolyIds.has(body.id)) continue;

      // Find contacts touching the body
      const touchingContacts = contacts.filter((c) => {
        const cBounds = polygonBounds(c.polygon);
        return cBounds && rectsIntersect(cBounds, bodyBounds);
      });

      if (touchingContacts.length < 2) continue;

      const { L_um, W_um, squares, shape, resistance_ohms, fingers } =
        computeResistorParams(
          body.polygon,
          touchingContacts,
          ctx.umPerPx,
          ctx.sheetR_ohms?.[layer],
        );

      // Minimum squares filter: a real resistor is at least ~2 squares.
      // Below that it's likely a power rail, gate stub, or contact pad.
      if (squares < 2) continue;

      const geometry: DeviceGeometryResistor = {
        L_um, W_um, squares,
        sheetR_ohms: ctx.sheetR_ohms?.[layer],
        resistance_ohms,
        fingers,
        multiplier: 1,
        shape: shape as DeviceGeometryResistor["shape"],
      };

      const terminalIds = touchingContacts.map((c) => c.id);
      matches.push({
        kind: "resistor",
        geometry,
        outlines: { body: body.polygon },
        terminals: {
          PLUS: [terminalIds[0]],
          MINUS: [terminalIds[terminalIds.length - 1]],
        },
        bbox: makeRectFromPoints(body.polygon),
      });
    }
  }

  return matches;
}

/**
 * Detect capacitors from overlapping plate pairs.
 *
 * Rules:
 *   1. Two distinct layers overlap (e.g., "capacitor_bottom" + "capacitor_top")
 *   2. Or: polysilicon + polysilicon (PIP), metal + metal (MIM), or poly + diffusion (MOS)
 *   3. The overlapping layers must NOT share a common contact/via
 */
export function detectCapacitors(
  shapes: ExtractedShape[],
  ctx: DetectionContext,
): DeviceMatch[] {
  const matches: DeviceMatch[] = [];
  const byLayer = ctx.shapesByLayer;
  // Dedup by pair (bottom id + top id, normalized so lower id first)
  const seen = new Set<string>();

  // Cap plate layer groups
  const bottomLayers: LayerType[] = ["capacitor_bottom", "polysilicon", "metal1", "metal2",
    "metal3", "metal4", "metal5", "metal6", "diffusion"];
  const topLayers: LayerType[] = ["capacitor_top", "polysilicon", "metal1", "metal2",
    "metal3", "metal4", "metal5", "metal6"];

  for (const bLayer of bottomLayers) {
    const bottoms = byLayer[bLayer];
    if (!bottoms) continue;

    for (const tLayer of topLayers) {
      if (bLayer === tLayer) continue; // same layer = short, not cap
      const tops = byLayer[tLayer];
      if (!tops) continue;

      for (const bottom of bottoms) {
        const bBounds = polygonBounds(bottom.polygon);
        if (!bBounds) continue;

        for (const top of tops) {
          // Dedup: same physical shape pair regardless of layer order
          const pairKey = bottom.id < top.id ? `${bottom.id}_${top.id}` : `${top.id}_${bottom.id}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);

          const tBounds = polygonBounds(top.polygon);
          if (!tBounds) continue;
          if (!rectsIntersect(bBounds, tBounds)) continue;

          // Check they are NOT connected by a contact/via
          const contact = byLayer["contact"] ?? [];
          const via = byLayer["via1"] ?? [];
          const connectedByContact = [...contact, ...via].some((c) => {
            const cBounds = polygonBounds(c.polygon);
            return cBounds &&
              rectsIntersect(cBounds, bBounds) &&
              rectsIntersect(cBounds, tBounds);
          });
          if (connectedByContact) continue;

          const { area_um2, perimeter_um, capType, capacitance_fF } =
            computeCapacitorParams(
              bottom.polygon, top.polygon, ctx.umPerPx,
              ctx.capDensity_fF?.[`${bLayer}_${tLayer}`],
            );

          if (area_um2 <= 0) continue;

          const geometry: DeviceGeometryCapacitor = {
            area_um2, perimeter_um,
            capDensity_fF: ctx.capDensity_fF?.[`${bLayer}_${tLayer}`],
            capacitance_fF,
            multiplier: 1,
            capType: capType as DeviceGeometryCapacitor["capType"],
          };

          const layerKey = `${bLayer}_${tLayer}`;
          const determinedCapType =
            (bLayer === "polysilicon" && tLayer === "polysilicon") ? "pip" as const
            : (bLayer.startsWith("metal") && tLayer.startsWith("metal")) ? "mim" as const
            : (bLayer === "polysilicon" && tLayer === "diffusion") ? "mos" as const
            : "unknown";

          matches.push({
            kind: "capacitor",
            geometry: { ...geometry, capType: determinedCapType },
            outlines: { bottom: bottom.polygon, top: top.polygon },
            terminals: {
              PLUS: [bottom.id],
              MINUS: [top.id],
            },
            bbox: makeRectFromPoints([...bottom.polygon, ...top.polygon]),
          });
        }
      }
    }
  }

  return matches;
}

/**
 * Detect diodes from single-diffusion + contact (no poly gate).
 *
 * Rules:
 *   1. A diffusion shape with at least one contact
 *   2. No polysilicon crosses it (if so, it's a MOS transistor, not a diode)
 *   3. If a well of same type exists, it's a substrate diode
 */
export function detectDiodes(
  shapes: ExtractedShape[],
  ctx: DetectionContext,
): DeviceMatch[] {
  const matches: DeviceMatch[] = [];
  const byLayer = ctx.shapesByLayer;
  const diffShapes = byLayer["diffusion"] ?? [];
  const polyShapes = byLayer["polysilicon"] ?? [];
  const contacts = byLayer["contact"] ?? [];

  // Known transistor diffusion ids (already used by CMOS pipeline)
  const knownDiffIds = new Set(ctx.diffusions.map((d) => d.shapeId));

  for (const diff of diffShapes) {
    // Skip if already used by CMOS extraction
    if (knownDiffIds.has(diff.id)) continue;

    const dBounds = polygonBounds(diff.polygon);
    if (!dBounds) continue;

    // Must have at least one contact
    const touchingContact = contacts.some((c) => {
      const cBounds = polygonBounds(c.polygon);
      return cBounds && rectsIntersect(cBounds, dBounds);
    });
    if (!touchingContact) continue;

    // Must NOT have a poly gate crossing (would be MOS)
    const hasPolyGate = polyShapes.some((p) => {
      const pBounds = polygonBounds(p.polygon);
      return pBounds && rectsIntersect(pBounds, dBounds);
    });
    if (hasPolyGate) continue;

    const { area_um2, perimeter_um } = computeDiodeParams(diff.polygon, ctx.umPerPx);

    const geometry: DeviceGeometryDiode = {
      area_um2, perimeter_um,
      multiplier: 1,
      diodeType: "pn",
    };

    matches.push({
      kind: "diode",
      geometry,
      outlines: { junction: diff.polygon },
      terminals: {
        PLUS: [diff.id],
        MINUS: [diff.id],
      },
      bbox: makeRectFromPoints(diff.polygon),
    });
  }

  return matches;
}

// ═════════════════════════════════════════════════════════════════
// Orchestrator
// ═════════════════════════════════════════════════════════════════

/**
 * Run all analog device detectors on a cell type's context and return
 * AnalogDevice entries (with minimal instance names).
 */
export function detectAnalogDevices(
  shapes: ExtractedShape[],
  transistors: Transistor[],
  diffusions: InferredDiffusion[],
  nets: ExtractedNet[],
  cellTypeId: string,
  umPerPx: number,
  config?: { sheetR?: Record<string, number>; capDensity?: Record<string, number> },
): AnalogDevice[] {
  const byLayer = buildLayerIndex(shapes);
  const netLookup = buildNetLookup(shapes);

  const ctx: DetectionContext = {
    shapes, transistors, diffusions, nets,
    umPerPx,
    sheetR_ohms: config?.sheetR,
    capDensity_fF: config?.capDensity,
    shapesByLayer: byLayer,
  };

  // Reset counter for each run
  _deviceCounter = 0;

  const allMatches: DeviceMatch[] = [
    ...detectMOS(shapes, transistors, diffusions, ctx),
    ...detectBJT(shapes, ctx),
    ...detectJFET(shapes, ctx),
    ...detectResistors(shapes, ctx),
    ...detectCapacitors(shapes, ctx),
    ...detectDiodes(shapes, ctx),
  ];

  return allMatches.map((m) => matchToDevice(m, cellTypeId, netLookup, ctx));
}
