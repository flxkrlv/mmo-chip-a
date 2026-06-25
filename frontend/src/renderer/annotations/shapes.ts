import type {
  CellLayers,
  LayerCircle,
  LayerLine,
  LayerPoint,
  LayerPolygon,
  LayerRect,
  LayerShape,
  LayerType
} from "shared";
import { withAlpha } from "../../lib/color";
import { COLOR_LABEL, COLOR_LAYER, LAYER_FILL_OPACITY } from "./style";
import type { TileBounds } from "../types";

/** Stable paint order so layer shading composites consistently. */
export const LAYER_DRAW_ORDER: LayerType[] = [
  // Substrate / wells (drawn first, lowest)
  "deep_nwell",
  "buried_layer",
  "nwell",
  "pwell",
  // Silicon active layers
  "diffusion",
  "base",
  "emitter",
  "collector_sinker",
  "jfet_gate",
  "jfet_channel",
  "resistor_body",
  "hsr",
  "film",
  "polysilicon",
  // Capacitor plates
  "capacitor_bottom",
  "capacitor_top",
  // Interconnect
  "metal1",
  "metal2",
  "metal3",
  "metal4",
  "metal5",
  "metal6",
  // Vias / contacts (topmost)
  "contact",
  "via1",
  // Auxiliary
  "wire_hitbox",
  "device_box",
  // Analog marker layers (topmost — most visible)
  "npn_id",
  "pnp_id",
  "lpnp_id",
  "vpnp",
  "res_id",
  "cap_id",
  "diode_id",
  "collector",
  "bulk"
];

/** Stroke width (CSS px) for shape outlines — kept screen-constant by
 *  dividing by `bounds.zoom` at draw time. Matches the old SVG-based
 *  implementation's `strokeWidth=1.5` for rect/circle/polygon and `=1` for
 *  via points. */
const OUTLINE_PX_BODY = 1.5;
const OUTLINE_PX_POINT = 1;
/** Below-this (world) point size: clamp the via-point square so it stays
 *  visible at low zoom without snapping to subpixels. */
const POINT_MIN_HALF_PX = 1.5;

export interface DrawShapeOptions {
  /** Paint the shape's outline on top of its fill. Default `true`. The line
   *  shape is the exception — lines are stroke-only by definition, so this
   *  flag is ignored there (`line` always draws). Pages that just want a
   *  translucent layer fill (die viewer, merge cells) pass `false` to skip
   *  outlines on rect / point / circle / polygon. */
  outline?: boolean;
}

/** Draw a single cell-layer shape in local (cell) coords. Caller is expected
 *  to have set `fillStyle` to a semi-translucent layer-fill colour and
 *  `strokeStyle` to the opaque base colour (see `applyShapeStyle`). Stroke
 *  line widths are screen-constant. */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: LayerShape,
  bounds: TileBounds,
  options: DrawShapeOptions = {}
): void {
  const outline = options.outline !== false;
  switch (shape.kind) {
    case "rect":
      return drawShapeRect(ctx, shape, bounds, outline);
    case "line":
      return drawShapeLine(ctx, shape, bounds);
    case "point":
      return drawShapePoint(ctx, shape, bounds, outline);
    case "circle":
      return drawShapeCircle(ctx, shape, bounds, outline);
    case "polygon":
      return drawShapePolygon(ctx, shape, bounds, outline);
  }
}

function drawShapeRect(
  ctx: CanvasRenderingContext2D,
  r: LayerRect,
  bounds: TileBounds,
  outline: boolean
): void {
  ctx.fillRect(r.x, r.y, r.width, r.height);
  if (!outline) return;
  const prev = ctx.lineWidth;
  ctx.lineWidth = OUTLINE_PX_BODY / bounds.zoom;
  ctx.strokeRect(r.x, r.y, r.width, r.height);
  ctx.lineWidth = prev;
}

function drawShapeLine(
  ctx: CanvasRenderingContext2D,
  l: LayerLine,
  bounds: TileBounds
): void {
  const prev = ctx.lineWidth;
  const prevCap = ctx.lineCap;
  ctx.lineWidth = Math.max(l.width, 0.5 / bounds.zoom);
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(l.x1, l.y1);
  ctx.lineTo(l.x2, l.y2);
  ctx.stroke();
  ctx.lineWidth = prev;
  ctx.lineCap = prevCap;
}

function drawShapePoint(
  ctx: CanvasRenderingContext2D,
  p: LayerPoint,
  bounds: TileBounds,
  outline: boolean
): void {
  // Via points render as a filled square — easier to read against round die
  // imagery than a circle, and matches the rectangular via geometry below.
  const half = Math.max(p.size / 2, POINT_MIN_HALF_PX / bounds.zoom);
  const side = half * 2;
  ctx.fillRect(p.x - half, p.y - half, side, side);
  if (!outline) return;
  const prev = ctx.lineWidth;
  ctx.lineWidth = OUTLINE_PX_POINT / bounds.zoom;
  ctx.strokeRect(p.x - half, p.y - half, side, side);
  ctx.lineWidth = prev;
}

function drawShapeCircle(
  ctx: CanvasRenderingContext2D,
  c: LayerCircle,
  bounds: TileBounds,
  outline: boolean
): void {
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
  ctx.fill();
  if (!outline) return;
  const prev = ctx.lineWidth;
  ctx.lineWidth = OUTLINE_PX_BODY / bounds.zoom;
  ctx.stroke();
  ctx.lineWidth = prev;
}

function drawShapePolygon(
  ctx: CanvasRenderingContext2D,
  p: LayerPolygon,
  bounds: TileBounds,
  outline: boolean
): void {
  if (p.points.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(p.points[0].x, p.points[0].y);
  for (let i = 1; i < p.points.length; i++) ctx.lineTo(p.points[i].x, p.points[i].y);
  ctx.closePath();
  ctx.fill();
  if (!outline) return;
  const prev = ctx.lineWidth;
  const prevJoin = ctx.lineJoin;
  ctx.lineWidth = OUTLINE_PX_BODY / bounds.zoom;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.lineWidth = prev;
  ctx.lineJoin = prevJoin;
}

/** Set fill (layer colour + per-layer alpha) and stroke (opaque) for `layer`,
 *  honouring `shape.label` overrides. Shared by `drawCellLayers` and any
 *  caller that wants to paint a single shape in its canonical style without
 *  re-implementing the colour-resolution rules. */
export function applyShapeStyle(
  ctx: CanvasRenderingContext2D,
  layer: LayerType,
  shape: LayerShape
): void {
  const base =
    (shape.label && COLOR_LABEL[shape.label]) ?? COLOR_LAYER[layer];
  ctx.fillStyle = withAlpha(base, LAYER_FILL_OPACITY[layer]);
  ctx.strokeStyle = base;
}

// ── Multi-layer rendering ─────────────────────────────────────────────

export interface DrawCellLayersOptions {
  /** Per-layer visibility filter. Return true to skip a layer. Omitted ⇒
   *  every layer with at least one shape gets drawn. */
  isHidden?: (layer: LayerType) => boolean;
  /** Per-shape hook called just before each shape is drawn. Return:
   *   • the same shape  → draw it unchanged
   *   • a different shape → draw the replacement (live drag previews)
   *   • null              → skip the shape entirely
   *  Omitted ⇒ draw every shape as-is. */
  replaceShape?: (
    layer: LayerType,
    shape: LayerShape
  ) => LayerShape | null;
  /** Paint shape outlines on top of fills? Default `true`. Pages where the
   *  cell is one of many on screen (die viewer, merge cells) typically pass
   *  `false` so the layer fills read as soft territory markers rather than
   *  individually-outlined geometry. The RE canvas keeps outlines on so
   *  each individual annotation reads as a discrete edit. */
  outline?: boolean;
  /** Optional per-layer alpha multiplier (0..1). Return `undefined` to use
   *  the default alpha for the layer. Used for the resistor body opacity
   *  slider in the RE cell page. */
  layerAlpha?: (layer: LayerType) => number | undefined;
}

/**
 * Paint every cell-layer in `layers` in stable draw order, with the canonical
 * per-layer style (`COLOR_LAYER` + `LAYER_FILL_OPACITY`, with `shape.label`
 * overrides via `COLOR_LABEL`). One source of truth for "how a cell's
 * annotations look on screen" — every page (die viewer, merge cells, RE)
 * routes its cell-layer drawing through here so a palette / paint-order
 * change only has to land in one place.
 *
 * The caller owns the transform (translate / rotate / scale to the cell's
 * local frame); this helper only resolves the per-shape style and dispatches
 * `drawShape`.
 */
/**
 * Group line shapes by connected component (shared endpoints) so each
 * group forms a continuous path that can be drawn with a single lineWidth.
 */
function groupConnectedLines(lines: LayerLine[]): LayerLine[][] {
  if (lines.length === 0) return [];
  const adj = new Map<string, Set<string>>();
  for (const l of lines) adj.set(l.id, new Set());
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      const share =
        (a.x1 === b.x1 && a.y1 === b.y1) ||
        (a.x1 === b.x2 && a.y1 === b.y2) ||
        (a.x2 === b.x1 && a.y2 === b.y1) ||
        (a.x2 === b.x2 && a.y2 === b.y2);
      if (share) {
        adj.get(a.id)!.add(b.id);
        adj.get(b.id)!.add(a.id);
      }
    }
  }
  const visited = new Set<string>();
  const groups: LayerLine[][] = [];
  const byId = new Map(lines.map((l) => [l.id, l]));
  for (const l of lines) {
    if (visited.has(l.id)) continue;
    const comp: LayerLine[] = [];
    const queue = [l.id];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const line = byId.get(id);
      if (line) comp.push(line);
      for (const n of adj.get(id) ?? []) if (!visited.has(n)) queue.push(n);
    }
    if (comp.length > 0) groups.push(comp);
  }
  return groups;
}

export function drawCellLayers(
  ctx: CanvasRenderingContext2D,
  layers: CellLayers | undefined,
  bounds: TileBounds,
  options: DrawCellLayersOptions = {}
): void {
  if (!layers) return;
  const { isHidden, replaceShape, outline, layerAlpha } = options;
  const shapeOpts: DrawShapeOptions = { outline };
  for (const layer of LAYER_DRAW_ORDER) {
    if (isHidden?.(layer)) continue;
    const shapes = layers[layer];
    if (!shapes || shapes.length === 0) continue;

    // Group "line" shapes into a continuous path so corners join cleanly
    // with lineJoin=round without lineCap artifacts at the path ends.
    const lines = shapes.filter((s): s is LayerLine => s.kind === "line");
    const nonLines = shapes.filter(s => s.kind !== "line");
    if (lines.length > 0) {
      // Group lines by connected component so each continuous path is
      // drawn with its own line-width.
      const alphaOv = layerAlpha?.(layer);
      const groups = groupConnectedLines(lines);
      for (const group of groups) {
        const w = (group[0] as any).width;
        const lineWidth = Math.max(w ?? 4, 0.5);

        if (alphaOv !== undefined) {
          ctx.save();
          ctx.globalAlpha = alphaOv;
        }
        applyShapeStyle(ctx, layer, group[0]);
        ctx.lineWidth = lineWidth;
        ctx.lineCap = "butt";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(group[0].x1, group[0].y1);
        ctx.lineTo(group[0].x2, group[0].y2);
        for (let i = 1; i < group.length; i++) {
          const prev = group[i - 1];
          const cur = group[i];
          if (cur.x1 === prev.x2 && cur.y1 === prev.y2) {
            ctx.lineTo(cur.x2, cur.y2);
          } else {
            ctx.moveTo(cur.x1, cur.y1);
            ctx.lineTo(cur.x2, cur.y2);
          }
        }
        ctx.stroke();
        if (alphaOv !== undefined) ctx.restore();
      }
    }
    for (const s of nonLines) {
      const out = replaceShape ? replaceShape(layer, s) : s;
      if (!out) continue;
      applyShapeStyle(ctx, layer, out);
      drawShape(ctx, out, bounds, shapeOpts);
    }
  }
}

