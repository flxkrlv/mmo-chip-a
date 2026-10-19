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
  LayerShape
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
  collectorWidth: 1.0
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
      L_um: 2
    }
  },
  {
    id: "pnp",
    label: "PNP",
    hint: "vertical PNP bipolar transistor",
    defaults: {
      kind: "bjt",
      bjtType: "pnp",
      fingers: 1,
      W_um: 2,
      L_um: 2
    }
  },
  {
    id: "lpnp",
    label: "LPNP",
    hint: "lateral PNP bipolar transistor",
    defaults: {
      kind: "bjt",
      bjtType: "lpnp",
      fingers: 1,
      W_um: 2,
      L_um: 2
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

/** A one-line summary of a device, e.g. "PMOS W=10 L=1 N=2". */
export function analogPcellSummary(spec: AnalogPcellSpec): string {
  const p = spec.params;
  const n = Math.max(1, Math.round(p.fingers));
  if (p.kind === "mos") {
    const bulk = p.bulk === "tap" ? " bulk tap" : "";
    return `${p.mosType.toUpperCase()} W=${round(p.W_um)} L=${round(p.L_um)} N=${n}${bulk}`;
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

/**
 * Lay a device out. `idPrefix` names the shapes (the caller passes the
 * cell type's id, so every shape id is unique inside the type).
 */
export function buildAnalogPcell(spec: AnalogPcellSpec, idPrefix: string): AnalogPcellLayout {
  const error = validateAnalogSpec(spec);
  if (error) throw new Error(error);
  return spec.params.kind === "mos"
    ? buildMos(spec, idPrefix)
    : buildBjt(spec, idPrefix);
}

/** The MOS template: a diffusion strip cut by the gate bars. */
function buildMos(spec: AnalogPcellSpec, idPrefix: string): AnalogPcellLayout {
  const p = spec.params as AnalogLibMosParams;
  const r = spec.rules;
  const k = spec.scale;

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

  // ── The well (nwell for pmos, pwell for nmos) ─────────────────────
  const wellLayer = p.mosType === "pmos" ? "nwell" : "pwell";
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
      (top) * k,
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

  // ── The well tap (bulk) ───────────────────────────────────────────
  let bottom = W + r.wellMargin;
  if (p.bulk === "tap") {
    const tcs = Math.min(r.contactSize, r.wellMargin * 0.8);
    // Keep the tap's metal pad clear of the source/drain pads.
    const clearance = Math.max(0.2, (contactPad - tcs) / 2 - W / 2 + 0.1);
    const tcy = (W + clearance + tcs / 2) * k;
    const tcx = (strip / 2) * k;
    contacts.push(rect(`${idPrefix}:ct:bulk`, tcx - (tcs * k) / 2, tcy - (tcs * k) / 2, tcs * k, tcs * k));
    metal1.push(
      rect(
        `${idPrefix}:m1:bulk`,
        tcx - (tcs + 2 * pad) * k * 0.5,
        tcy - (tcs + 2 * pad) * k * 0.5,
        (tcs + 2 * pad) * k,
        (tcs + 2 * pad) * k
      )
    );
    bottom = W + clearance + tcs + r.wellMargin;
  }

  layers.contact = contacts;
  layers.metal1 = metal1;

  // The well encloses everything: the strap on top, the tap below.
  layers[wellLayer] = [
    rect(
      `${idPrefix}:${wellLayer}`,
      -r.wellMargin * k,
      (top - r.wellMargin) * k,
      (strip + 2 * r.wellMargin) * k,
      (bottom + r.wellMargin - (top - r.wellMargin)) * k
    )
  ];

  const cropRect: AnnotationRect = {
    x: 0,
    y: 0,
    width: (strip + 2 * r.wellMargin) * k,
    height: (bottom + r.wellMargin - (top - r.wellMargin)) * k
  };

  return { layers, cropRect, summary: analogPcellSummary(spec) };
}

/** The BJT template: an emitter block inside a base, next to a collector. */
function buildBjt(spec: AnalogPcellSpec, idPrefix: string): AnalogPcellLayout {
  const p = spec.params as AnalogLibBjtParams;
  const r = spec.rules;
  const k = spec.scale;

  const W = p.W_um;
  const L = p.L_um;
  const N = Math.max(1, Math.round(p.fingers));
  const gap = r.spacing;
  const isLpnp = p.bjtType === "lpnp";

  // The emitter block: N stripes separated by `gap`.
  const emitterWidth = N * W + (N - 1) * gap;
  const layers: CellLayers = {};

  const emitters: LayerShape[] = [];
  for (let i = 0; i < N; i++) {
    const x = i * (W + gap);
    emitters.push(rect(`${idPrefix}:emitter:${i}`, x * k, 0, W * k, L * k));
  }
  layers.emitter = emitters;

  // The base surrounds the emitters — an LPnp has none (its emitter area
  // is the raw emitter rectangle).
  const baseX0 = -r.baseMargin;
  const baseX1 = emitterWidth + r.baseMargin;
  if (!isLpnp) {
    layers.base = [
      rect(
        `${idPrefix}:base`,
        baseX0 * k,
        -r.baseMargin * k,
        (baseX1 - baseX0) * k,
        (L + 2 * r.baseMargin) * k
      )
    ];
  }

  // The collector sits next to the base (lateral for an LPnp).
  const collectorX0 = baseX1;
  const collectorX1 = collectorX0 + r.collectorWidth;
  layers.collector = [
    rect(
      `${idPrefix}:collector`,
      collectorX0 * k,
      -r.baseMargin * k,
      (collectorX1 - collectorX0) * k,
      (L + 2 * r.baseMargin) * k
    )
  ];

  // Contacts: one per emitter stripe, one on the collector, one on the
  // base (only where there is a base).
  const cs = Math.min(r.contactSize, Math.min(W, L) * 0.8);
  const pad = r.metal1Pad;
  const contacts: LayerShape[] = [];
  const metal1: LayerShape[] = [];

  for (let i = 0; i < N; i++) {
    const cx = (i * (W + gap) + W / 2) * k;
    const cy = (L / 2) * k;
    contacts.push(rect(`${idPrefix}:ct:e${i}`, cx - (cs * k) / 2, cy - (cs * k) / 2, cs * k, cs * k));
    metal1.push(
      rect(`${idPrefix}:m1:e${i}`, cx - (cs + 2 * pad) * k * 0.5, cy - (cs + 2 * pad) * k * 0.5, (cs + 2 * pad) * k, (cs + 2 * pad) * k)
    );
  }

  const ccx = ((collectorX0 + collectorX1) / 2) * k;
  const ccy = (L / 2) * k;
  contacts.push(rect(`${idPrefix}:ct:c`, ccx - (cs * k) / 2, ccy - (cs * k) / 2, cs * k, cs * k));
  metal1.push(
    rect(`${idPrefix}:m1:c`, ccx - (cs + 2 * pad) * k * 0.5, ccy - (cs + 2 * pad) * k * 0.5, (cs + 2 * pad) * k, (cs + 2 * pad) * k)
  );

  if (!isLpnp) {
    // The base contact sits in the base margin, clear of the emitters.
    const bcx = (baseX0 + r.baseMargin / 2) * k;
    const bcy = (L / 2) * k;
    contacts.push(rect(`${idPrefix}:ct:b`, bcx - (cs * k) / 2, bcy - (cs * k) / 2, cs * k, cs * k));
    metal1.push(
      rect(`${idPrefix}:m1:b`, bcx - (cs + 2 * pad) * k * 0.5, bcy - (cs + 2 * pad) * k * 0.5, (cs + 2 * pad) * k, (cs + 2 * pad) * k)
    );
  }

  layers.contact = contacts;
  layers.metal1 = metal1;

  // The marker layer names the device; the extractor reads the collector,
  // base and emitter shapes inside it.
  const markerLayer = p.bjtType === "npn" ? "npn_id" : p.bjtType === "pnp" ? "pnp_id" : "lpnp_id";
  const markerPad = Math.max(r.baseMargin, 0.2);
  layers[markerLayer] = [
    rect(
      `${idPrefix}:${markerLayer}`,
      (baseX0 - markerPad) * k,
      (-r.baseMargin - markerPad) * k,
      (collectorX1 - baseX0 + 2 * markerPad) * k,
      (L + 2 * r.baseMargin + 2 * markerPad) * k
    )
  ];

  const width = (collectorX1 - baseX0 + 2 * markerPad) * k;
  const height = (L + 2 * r.baseMargin + 2 * markerPad) * k;

  return {
    layers,
    cropRect: { x: 0, y: 0, width, height },
    summary: analogPcellSummary(spec)
  };
}
