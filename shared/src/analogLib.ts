// ─────────────────────────────────────────────────────────────────────
// Analog library — parametric device templates ("PCells").
//
// The library holds standard devices (pmos / nmos / npn / pnp / lpnp)
// that are laid out from parameters instead of being drawn by hand:
// W/L (or the emitter size), the finger count, the bulk connection and
// the scale (pixels per micrometre). The result is an ordinary cell type
// with layer shapes, so the cell extractor sees the same device it would
// see in a hand-drawn cell — and the user can still edit the shapes.
//
// Geometry conventions (they match what the extractor expects):
//  * the channel of a MOS is the *intersection* of a gate poly and the
//    diffusion, so the diffusion strip runs along the gate-to-gate axis
//    and the gate bars cross it;
//  * a multi-finger MOS shares one diffusion strip, cut at every gate —
//    the extractor splits the strip the same way (one segment per S/D);
//  * the gate fingers are joined by a poly strap so that they share one
//    gate net (the extractor groups overlapping polys).
//
// The library unit is 1 µm. `scale` is the number of pixels one library
// unit (one micrometre) takes on the die.
// ─────────────────────────────────────────────────────────────────────

import type {
  AnalogLibBjtParams,
  AnalogLibBulk,
  AnalogLibMosParams,
  AnalogLibParams,
  AnalogLibRules,
  AnalogLibTemplate,
  AnalogParamsFor,
  AnalogPcellSpec,
  AnnotationRect,
  CellLayers,
  ForcedDiffusionType,
  LayerRect,
  LayerShape,
  LayerType
} from "./types.js";

export type {
  AnalogLibBulk,
  AnalogLibBjtParams,
  AnalogLibMosParams,
  AnalogLibParams,
  AnalogLibRules,
  AnalogLibTemplate,
  AnalogPcellSpec
} from "./types.js";

/**
 * The design rules the templates are laid out with [µm]. They are part of
 * the stored spec, so a device regenerated later comes out identical.
 */
export const DEFAULT_ANALOG_LIB_RULES: AnalogLibRules = {
  spacing: 1.0,
  polyOverhang: 0.5,
  polyStrap: 0.4,
  contactSize: 0.4,
  metal1Pad: 0.3,
  wellMargin: 1.0,
  baseMargin: 0.5,
  collectorWidth: 1.0,
  lpnpEmitterCollectorGap: 0.8,
  lpnpCollectorBaseGap: 0.8,
  lpnpCollectorWidth: 1.0,
  npnEmitterBaseGap: 1.0,
  npnEmitterCollectorGap: 2.0,
  npnCollectorWidth: 1.5
};

/** A laid-out device: the layers and the box they live in (die pixels). */
export interface AnalogPcellLayout {
  /** The device's layer shapes. */
  layers: CellLayers;
  /** The device's box, origin-relative. */
  cropRect: AnnotationRect;
  /** A one-line human summary, e.g. "PMOS W=10 L=1 N=2". */
  summary: string;
}

// ── Templates ─────────────────────────────────────────────────────────

export interface AnalogLibTemplateInfo {
  id: AnalogLibTemplate;
  /** Short name shown in the UI. */
  label: string;
  /** What the device is, in one line. */
  hint: string;
  /** The default parameters of a freshly picked template. */
  defaults: AnalogLibParams;
}

export const ANALOG_LIB_TEMPLATES: AnalogLibTemplateInfo[] = [
  {
    id: "pmos",
    label: "PMOS",
    hint: "p-channel MOS in an n-well",
    defaults: {
      kind: "mos",
      mosType: "pmos",
      fingers: 1,
      multiplier: 1,
      multiplierGap_um: 1.0,
      W_um: 10,
      L_um: 1,
      bulk: "none"
    }
  },
  {
    id: "nmos",
    label: "NMOS",
    hint: "n-channel MOS in a p-well",
    defaults: {
      kind: "mos",
      mosType: "nmos",
      fingers: 1,
      multiplier: 1,
      multiplierGap_um: 1.0,
      W_um: 10,
      L_um: 1,
      bulk: "none"
    }
  },
  {
    id: "npn",
    label: "NPN",
    hint: "vertical NPN bipolar transistor",
    defaults: {
      kind: "bjt",
      bjtType: "npn",
      fingers: 1,
      W_um: 2,
      L_um: 2,
      emitterBaseGap_um: 1.0,
      emitterCollectorGap_um: 2.0,
      baseContactSide: "left"
    }
  },
  {
    id: "lpnp",
    label: "LPNP",
    hint: "lateral PNP: p+ emitter in an n-base, p+ collector ring around it",
    defaults: {
      kind: "bjt",
      bjtType: "lpnp",
      fingers: 1,
      W_um: 2,
      L_um: 2,
      emitterCollectorGap_um: 0.8,
      collectorBaseGap_um: 0.8,
      baseContactSide: "left"
    }
  }
];

export function analogLibTemplate(id: AnalogLibTemplate): AnalogLibTemplateInfo | undefined {
  return ANALOG_LIB_TEMPLATES.find((t) => t.id === id);
}

// ── Parameter helpers ────────────────────────────────────────────────

/** The parameters a template starts with. */
export function defaultAnalogParams<T extends AnalogLibTemplate>(
  template: T
): AnalogParamsFor<T> {
  const info = analogLibTemplate(template);
  if (!info) throw new Error(`unknown analog template "${template}"`);
  return { ...info.defaults } as AnalogParamsFor<T>;
}

/** The template a parameter set belongs to. */
export function analogTemplateOf(params: AnalogLibParams): AnalogLibTemplate {
  return params.kind === "mos" ? params.mosType : params.bjtType;
}

/** Why the parameters can't be laid out — null when they can. */
export function validateAnalogParams(params: AnalogLibParams): string | null {
  if (!Number.isFinite(params.W_um) || params.W_um <= 0) return "W must be greater than 0";
  if (!Number.isFinite(params.L_um) || params.L_um <= 0) return "L must be greater than 0";
  if (!Number.isInteger(params.fingers) || params.fingers < 1) return "fingers must be at least 1";
  if (params.kind === "mos") {
    if (!Number.isInteger(params.multiplier) || params.multiplier < 1)
      return "multiplier must be at least 1";
    if (!Number.isFinite(params.multiplierGap_um) || params.multiplierGap_um < 0)
      return "the multiplier gap must not be negative";
  }
  return null;
}

/** Why the spec can't be laid out — null when it can. */
export function validateAnalogSpec(spec: AnalogPcellSpec): string | null {
  if (!Number.isFinite(spec.scale) || spec.scale <= 0) return "scale must be greater than 0";
  const paramsError = validateAnalogParams(spec.params);
  if (paramsError) return paramsError;
  for (const [key, value] of Object.entries(spec.rules)) {
    if (!Number.isFinite(value) || value <= 0) return `rule "${key}" must be greater than 0`;
  }
  return null;
}

/** A one-line summary of a device, e.g. "PMOS W=10 L=1 N=2 x3". */
export function analogPcellSummary(spec: AnalogPcellSpec): string {
  const p = spec.params;
  const n = Math.max(1, Math.round(p.fingers));
  if (p.kind === "mos") {
    const bulk = p.bulk === "tap" ? " bulk tap" : "";
    const mult = Math.max(1, Math.round(p.multiplier));
    return (
      `${p.mosType.toUpperCase()} W=${round(p.W_um)} L=${round(p.L_um)} N=${n}` +
      (mult > 1 ? ` x${mult}` : "") +
      bulk
    );
  }
  return `${p.bjtType.toUpperCase()} W=${round(p.W_um)} L=${round(p.L_um)} N=${n}`;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ── Layout ────────────────────────────────────────────────────────────

/** Rounds a pixel coordinate so the stored shapes stay tidy. */
function q(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function rect(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra?: Partial<LayerRect>
): LayerRect {
  return {
    id,
    kind: "rect",
    x: q(x),
    y: q(y),
    width: q(Math.max(width, 0)),
    height: q(Math.max(height, 0)),
    ...extra
  };
}

/** The bounding box of a shape, in its own units. */
function shapeBounds(s: LayerShape): { x: number; y: number; w: number; h: number } | null {
  switch (s.kind) {
    case "rect":
      return { x: s.x, y: s.y, w: s.width, h: s.height };
    case "point":
      return { x: s.x - s.size / 2, y: s.y - s.size / 2, w: s.size, h: s.size };
    case "circle":
      return { x: s.x - s.radius, y: s.y - s.radius, w: s.radius * 2, h: s.radius * 2 };
    case "line":
      return {
        x: Math.min(s.x1, s.x2),
        y: Math.min(s.y1, s.y2),
        w: Math.abs(s.x2 - s.x1),
        h: Math.abs(s.y2 - s.y1)
      };
    case "polygon": {
      if (s.points.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of s.points) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
  }
}

/** A shape moved by (dx, dy). */
function translateShape(s: LayerShape, dx: number, dy: number): LayerShape {
  switch (s.kind) {
    case "rect":
      return { ...s, x: q(s.x + dx), y: q(s.y + dy) };
    case "point":
      return { ...s, x: q(s.x + dx), y: q(s.y + dy) };
    case "circle":
      return { ...s, x: q(s.x + dx), y: q(s.y + dy) };
    case "line":
      return { ...s, x1: q(s.x1 + dx), y1: q(s.y1 + dy), x2: q(s.x2 + dx), y2: q(s.y2 + dy) };
    case "polygon":
      return { ...s, points: s.points.map((p) => ({ x: q(p.x + dx), y: q(p.y + dy) })) };
  }
}

/**
 * Fit the device into its cell: the layers are moved so that the content
 * starts at the cell's origin, and the cell's box is the content's own
 * bounds. A device therefore sits exactly inside its cell — nothing sticks
 * out over the cell edge.
 */
function fitToCell(layers: CellLayers): { layers: CellLayers; cropRect: AnnotationRect } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shapes of Object.values(layers)) {
    for (const s of shapes ?? []) {
      const b = shapeBounds(s);
      if (!b) continue;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
  }
  if (!Number.isFinite(minX)) {
    return { layers, cropRect: { x: 0, y: 0, width: 0, height: 0 } };
  }
  const dx = -minX;
  const dy = -minY;
  const out: CellLayers = {};
  for (const [layer, shapes] of Object.entries(layers) as Array<[LayerType, LayerShape[] | undefined]>) {
    if (shapes) out[layer] = shapes.map((s) => translateShape(s, dx, dy));
  }
  return {
    layers: out,
    cropRect: { x: 0, y: 0, width: q(maxX - minX), height: q(maxY - minY) }
  };
}

/**
 * Lay a device out. `idPrefix` names the shapes (the caller passes the
 * cell type's id, so every shape id is unique inside the type).
 */
export function buildAnalogPcell(spec: AnalogPcellSpec, idPrefix: string): AnalogPcellLayout {
  const error = validateAnalogSpec(spec);
  if (error) throw new Error(error);
  if (spec.params.kind === "mos") return buildMos(spec, idPrefix);
  return spec.params.bjtType === "lpnp" ? buildLpnp(spec, idPrefix) : buildNpn(spec, idPrefix);
}

/**
 * One MOS structure: a diffusion strip cut by the gate bars, with its
 * contacts. The multiplier lays several of these side by side.
 */
function mosStructure(
  p: AnalogLibMosParams,
  r: AnalogLibRules,
  k: number,
  idPrefix: string
): { layers: CellLayers; width: number } {
  const L = p.L_um;
  const W = p.W_um;
  const N = Math.max(1, Math.round(p.fingers));
  const sd = r.spacing;

  // The diffusion strip: N gates of length L, separated and flanked by
  // N+1 source/drain regions of `sd`.
  const strip = N * L + (N + 1) * sd;
  const gateX = (i: number) => sd + i * (L + sd);

  const cs = Math.min(r.contactSize, sd * 0.8);
  const pad = r.metal1Pad;
  const contactPad = cs + 2 * pad;

  const layers: CellLayers = {};
  const top = -(r.polyOverhang + r.polyStrap);

  // ── The gate bars and their poly strap ────────────────────────────
  const polys: LayerShape[] = [];
  for (let i = 0; i < N; i++) {
    polys.push(rect(`${idPrefix}:poly:g${i}`, gateX(i) * k, -r.polyOverhang * k, L * k, (W + r.polyOverhang) * k));
  }
  // The strap joins the fingers, so they share one gate net.
  const strapOverlap = Math.max(0.1, r.polyStrap * 0.25);
  polys.push(
    rect(
      `${idPrefix}:poly:strap`,
      gateX(0) * k,
      top * k,
      (gateX(N - 1) + L - gateX(0)) * k,
      (r.polyStrap + strapOverlap) * k
    )
  );
  layers.polysilicon = polys;

  // ── The diffusion strip ───────────────────────────────────────────
  const forced: ForcedDiffusionType = p.mosType === "pmos" ? "p" : "n";
  layers.diffusion = [rect(`${idPrefix}:diff`, 0, 0, strip * k, W * k, { forcedType: forced })];

  // ── Contacts: one per source/drain region, one on the gate strap ──
  const contacts: LayerShape[] = [];
  const metal1: LayerShape[] = [];

  const sdRegions: Array<{ x0: number; x1: number }> = [];
  for (let j = 0; j <= N; j++) {
    const x0 = j === 0 ? 0 : gateX(j - 1) + L;
    const x1 = j === N ? strip : gateX(j);
    sdRegions.push({ x0, x1 });
  }
  for (let j = 0; j < sdRegions.length; j++) {
    const { x0, x1 } = sdRegions[j];
    const cx = ((x0 + x1) / 2) * k;
    const cy = (W / 2) * k;
    contacts.push(rect(`${idPrefix}:ct:sd${j}`, cx - (cs * k) / 2, cy - (cs * k) / 2, cs * k, cs * k));
    metal1.push(
      rect(`${idPrefix}:m1:sd${j}`, cx - (contactPad * k) / 2, cy - (contactPad * k) / 2, contactPad * k, contactPad * k)
    );
  }

  // The gate contact sits on the strap, clear of the diffusion.
  const strapH = r.polyStrap + strapOverlap;
  const gcs = Math.min(r.contactSize, strapH * 0.8);
  const gcx = ((gateX(0) + gateX(N - 1) + L) / 2) * k;
  const gcy = (top + strapH / 2) * k;
  contacts.push(rect(`${idPrefix}:ct:g`, gcx - (gcs * k) / 2, gcy - (gcs * k) / 2, gcs * k, gcs * k));
  metal1.push(
    rect(
      `${idPrefix}:m1:g`,
      gcx - (gcs + 2 * pad) * k * 0.5,
      gcy - (gcs + 2 * pad) * k * 0.5,
      (gcs + 2 * pad) * k,
      (gcs + 2 * pad) * k
    )
  );

  layers.contact = contacts;
  layers.metal1 = metal1;

  return { layers, width: strip };
}

/** The MOS template: one or more structures side by side in a well. */
function buildMos(spec: AnalogPcellSpec, idPrefix: string): AnalogPcellLayout {
  const p = spec.params as AnalogLibMosParams;
  const r = spec.rules;
  const k = spec.scale;

  const W = p.W_um;
  const M = Math.max(1, Math.round(p.multiplier));
  const gap = p.multiplierGap_um;

  // ── The structures of the multiplier, side by side ─────────────────
  const layers: CellLayers = {};
  let x = 0;
  let strip = 0;
  for (let m = 0; m < M; m++) {
    const one = mosStructure(p, r, k, `${idPrefix}:m${m}`);
    for (const [layer, shapes] of Object.entries(one.layers) as Array<
      [LayerType, LayerShape[] | undefined]
    >) {
      if (!shapes) continue;
      const moved = x === 0 ? shapes : shapes.map((s) => translateShape(s, x * k, 0));
      layers[layer] = [...(layers[layer] ?? []), ...moved];
    }
    x += one.width + gap;
    strip = x - gap;
  }

  const top = -(r.polyOverhang + r.polyStrap);
  const cs = Math.min(r.contactSize, r.spacing * 0.8);
  const pad = r.metal1Pad;
  const contactPad = cs + 2 * pad;

  // ── The well tap (bulk) ───────────────────────────────────────────
  let bottom = W + r.wellMargin;
  if (p.bulk === "tap") {
    const tcs = Math.min(r.contactSize, r.wellMargin * 0.8);
    // Keep the tap's metal pad clear of the source/drain pads.
    const clearance = Math.max(0.2, (contactPad - tcs) / 2 - W / 2 + 0.1);
    const tcy = (W + clearance + tcs / 2) * k;
    const tcx = (strip / 2) * k;
    layers.contact = [
      ...(layers.contact ?? []),
      rect(`${idPrefix}:ct:bulk`, tcx - (tcs * k) / 2, tcy - (tcs * k) / 2, tcs * k, tcs * k)
    ];
    layers.metal1 = [
      ...(layers.metal1 ?? []),
      rect(
        `${idPrefix}:m1:bulk`,
        tcx - (tcs + 2 * pad) * k * 0.5,
        tcy - (tcs + 2 * pad) * k * 0.5,
        (tcs + 2 * pad) * k,
        (tcs + 2 * pad) * k
      )
    ];
    bottom = W + clearance + tcs + r.wellMargin;
  }

  // The well encloses everything: the strap on top, the tap below.
  const wellLayer = p.mosType === "pmos" ? "nwell" : "pwell";
  layers[wellLayer] = [
    rect(
      `${idPrefix}:${wellLayer}`,
      -r.wellMargin * k,
      (top - r.wellMargin) * k,
      (strip + 2 * r.wellMargin) * k,
      (bottom + r.wellMargin - (top - r.wellMargin)) * k
    )
  ];

  const fitted = fitToCell(layers);
  return { layers: fitted.layers, cropRect: fitted.cropRect, summary: analogPcellSummary(spec) };
}

/** The vertical BJT: an emitter block inside a base, next to a collector. */
function buildNpn(spec: AnalogPcellSpec, idPrefix: string): AnalogPcellLayout {
  const p = spec.params as AnalogLibBjtParams;
  const r = spec.rules;
  const k = spec.scale;

  const W = p.W_um;
  const L = p.L_um;
  const N = Math.max(1, Math.round(p.fingers));
  const gap = r.spacing;

  // The distances around the emitter: the base's margin, and how far the
  // collector is moved away from the emitter.
  const baseGap = p.emitterBaseGap_um ?? r.npnEmitterBaseGap;
  const collectorGap = p.emitterCollectorGap_um ?? r.npnEmitterCollectorGap;
  const collectorW = r.npnCollectorWidth;
  const side = p.baseContactSide ?? "left";

  // The emitter block: N stripes separated by `gap`.
  const emitterWidth = N * W + (N - 1) * gap;
  const layers: CellLayers = {};

  const emitters: LayerShape[] = [];
  for (let i = 0; i < N; i++) {
    const x = i * (W + gap);
    emitters.push(rect(`${idPrefix}:emitter:${i}`, x * k, 0, W * k, L * k));
  }
  layers.emitter = emitters;

  // The base surrounds the emitters with its margin.
  const baseX0 = -baseGap;
  const baseX1 = emitterWidth + baseGap;
  layers.base = [
    rect(
      `${idPrefix}:base`,
      baseX0 * k,
      -baseGap * k,
      (baseX1 - baseX0) * k,
      (L + 2 * baseGap) * k
    )
  ];

  // The collector sits off to the side, `collectorGap` from the emitter.
  const collectorX0 = emitterWidth + collectorGap;
  const collectorX1 = collectorX0 + collectorW;
  layers.collector = [
    rect(
      `${idPrefix}:collector`,
      collectorX0 * k,
      -baseGap * k,
      (collectorX1 - collectorX0) * k,
      (L + 2 * baseGap) * k
    )
  ];

  // Contacts: one per emitter stripe, one on the collector, one on the
  // base — the base contact on the side the user picked.
  const cs = Math.min(r.contactSize, Math.min(W, L) * 0.8);
  const pad = r.metal1Pad;
  const contacts: LayerShape[] = [];
  const metal1: LayerShape[] = [];

  const contactAt = (id: string, cx: number, cy: number, size: number) => {
    contacts.push(rect(`${idPrefix}:ct:${id}`, cx - (size * k) / 2, cy - (size * k) / 2, size * k, size * k));
    metal1.push(
      rect(
        `${idPrefix}:m1:${id}`,
        cx - (size + 2 * pad) * k * 0.5,
        cy - (size + 2 * pad) * k * 0.5,
        (size + 2 * pad) * k,
        (size + 2 * pad) * k
      )
    );
  };

  for (let i = 0; i < N; i++) {
    contactAt(`e${i}`, (i * (W + gap) + W / 2) * k, (L / 2) * k, cs);
  }
  contactAt("c", ((collectorX0 + collectorX1) / 2) * k, (L / 2) * k, cs);

  // The base contact sits in the base's margin, on the chosen side.
  const bcs = Math.min(cs, baseGap * 0.8);
  const bx =
    side === "left"
      ? baseX0 + baseGap / 2
      : side === "right"
        ? baseX1 - baseGap / 2
        : emitterWidth / 2;
  const by =
    side === "top"
      ? -baseGap + baseGap / 2
      : side === "bottom"
        ? L + baseGap - baseGap / 2
        : L / 2;
  contactAt("b", bx * k, by * k, bcs);

  layers.contact = contacts;
  layers.metal1 = metal1;

  // The marker layer names the device; the extractor reads the collector,
  // base and emitter shapes inside it.
  const markerPad = Math.max(baseGap, 0.2);
  layers.npn_id = [
    rect(
      `${idPrefix}:npn_id`,
      (baseX0 - markerPad) * k,
      (-baseGap - markerPad) * k,
      (collectorX1 - baseX0 + 2 * markerPad) * k,
      (L + 2 * baseGap + 2 * markerPad) * k
    )
  ];

  const fitted = fitToCell(layers);
  return { layers: fitted.layers, cropRect: fitted.cropRect, summary: analogPcellSummary(spec) };
}

/**
 * The lateral PNP: a p+ emitter in an n-base, a p+ collector ring around
 * it, and a base contact in the base material beside the ring.
 *
 * The base of a lateral PNP is the n region the emitter and the collector
 * sit in, so it is laid out as the `bulk` layer — that is the terminal the
 * extractor resolves the base contact against.
 */
function buildLpnp(spec: AnalogPcellSpec, idPrefix: string): AnalogPcellLayout {
  const p = spec.params as AnalogLibBjtParams;
  const r = spec.rules;
  const k = spec.scale;

  const W = p.W_um;
  const L = p.L_um;
  const N = Math.max(1, Math.round(p.fingers));
  const gap = r.spacing;
  const ecGap = p.emitterCollectorGap_um ?? r.lpnpEmitterCollectorGap;
  const cbGap = p.collectorBaseGap_um ?? r.lpnpCollectorBaseGap;
  const cw = r.lpnpCollectorWidth;
  const side = p.baseContactSide ?? "left";

  // The emitter block: N stripes side by side.
  const emitterWidth = N * W + (N - 1) * gap;
  const layers: CellLayers = {};

  const emitters: LayerShape[] = [];
  for (let i = 0; i < N; i++) {
    const x = i * (W + gap);
    emitters.push(rect(`${idPrefix}:emitter:${i}`, x * k, 0, W * k, L * k));
  }
  layers.emitter = emitters;

  // The collector: a ring around the emitter, `ecGap` away from it.
  const ringX0 = -ecGap;
  const ringX1 = emitterWidth + ecGap;
  const ringY0 = -ecGap;
  const ringY1 = L + ecGap;
  const outX0 = ringX0 - cw;
  const outX1 = ringX1 + cw;
  const outY0 = ringY0 - cw;
  const outY1 = ringY1 + cw;
  layers.collector = [
    // top and bottom bars of the ring
    rect(`${idPrefix}:collector:t`, outX0 * k, outY0 * k, (outX1 - outX0) * k, cw * k),
    rect(`${idPrefix}:collector:b`, outX0 * k, (outY1 - cw) * k, (outX1 - outX0) * k, cw * k),
    // left and right bars of the ring
    rect(`${idPrefix}:collector:l`, outX0 * k, ringY0 * k, cw * k, (ringY1 - ringY0) * k),
    rect(`${idPrefix}:collector:r`, (outX1 - cw) * k, ringY0 * k, cw * k, (ringY1 - ringY0) * k)
  ];

  // The base: the n region around the collector ring, `cbGap` clear of it.
  const baseX0 = outX0 - cbGap;
  const baseX1 = outX1 + cbGap;
  const baseY0 = outY0 - cbGap;
  const baseY1 = outY1 + cbGap;
  layers.bulk = [
    rect(
      `${idPrefix}:bulk`,
      baseX0 * k,
      baseY0 * k,
      (baseX1 - baseX0) * k,
      (baseY1 - baseY0) * k
    )
  ];

  // Contacts: one per emitter stripe, one on the collector ring, one on
  // the base — the base contact on the side the user picked.
  const cs = Math.min(r.contactSize, Math.min(W, L) * 0.8);
  const pad = r.metal1Pad;
  const contacts: LayerShape[] = [];
  const metal1: LayerShape[] = [];
  const contactAt = (id: string, cx: number, cy: number, size: number) => {
    contacts.push(rect(`${idPrefix}:ct:${id}`, cx - (size * k) / 2, cy - (size * k) / 2, size * k, size * k));
    metal1.push(
      rect(
        `${idPrefix}:m1:${id}`,
        cx - (size + 2 * pad) * k * 0.5,
        cy - (size + 2 * pad) * k * 0.5,
        (size + 2 * pad) * k,
        (size + 2 * pad) * k
      )
    );
  };

  for (let i = 0; i < N; i++) {
    contactAt(`e${i}`, (i * (W + gap) + W / 2) * k, (L / 2) * k, cs);
  }
  // The collector contact sits on the ring's bottom bar.
  contactAt("c", ((ringX0 + ringX1) / 2) * k, (outY1 - cw / 2) * k, Math.min(cs, cw * 0.8));
  // The base contact sits in the base material, on the chosen side.
  const bcs = Math.min(cs, cbGap * 0.8);
  const bx =
    side === "left"
      ? baseX0 + cbGap / 2
      : side === "right"
        ? baseX1 - cbGap / 2
        : emitterWidth / 2;
  const by =
    side === "top"
      ? baseY0 + cbGap / 2
      : side === "bottom"
        ? baseY1 - cbGap / 2
        : L / 2;
  contactAt("b", bx * k, by * k, bcs);

  layers.contact = contacts;
  layers.metal1 = metal1;

  // The marker names the device; it encloses every shape of it.
  const markerPad = Math.max(cbGap, 0.2);
  layers.lpnp_id = [
    rect(
      `${idPrefix}:lpnp_id`,
      (baseX0 - markerPad) * k,
      (baseY0 - markerPad) * k,
      (baseX1 - baseX0 + 2 * markerPad) * k,
      (baseY1 - baseY0 + 2 * markerPad) * k
    )
  ];

  const fitted = fitToCell(layers);
  return { layers: fitted.layers, cropRect: fitted.cropRect, summary: analogPcellSummary(spec) };
}
