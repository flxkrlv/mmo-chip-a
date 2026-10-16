import sharp from "sharp";
import type { DieAnnotations, LayerShape, MetalStack } from "shared";
import { listManifests } from "../api/overlayImages.js";
import { cellDieRect, renderDieCrop } from "../api/tiles.js";
import type { DieRecord } from "../types.js";
import { num, str, ToolInputError } from "./mcpToolKit.js";

/**
 * Server-side "screenshot" for MCP clients: the die crop (optionally with an
 * overlay) with annotations drawn on top as SVG, composited by sharp. The look
 * follows the die viewer's defaults (per-layer wire colors from the metal
 * stack, cell type colors, dashed floorplans…) but is not pixel-identical —
 * the GUI renderer lives in the browser. Everything is drawn in output-pixel
 * space so line widths and text stay readable at any zoom.
 */

export const RENDER_LAYERS = [
  "wires",
  "vias",
  "cells",
  "pins",
  "floorplans",
  "comments",
  "rulers",
  "netLabels",
  "analogLayers",
  "guides"
] as const;
export type RenderLayer = (typeof RENDER_LAYERS)[number];
const DEFAULT_LAYERS: RenderLayer[] = ["wires", "vias", "cells", "pins", "floorplans", "comments", "rulers"];

export type Mark =
  | { kind: "box"; x: number; y: number; width: number; height: number; label?: string; color?: string }
  | { kind: "circle"; x: number; y: number; radius: number; label?: string; color?: string }
  | { kind: "arrow"; x1: number; y1: number; x2: number; y2: number; label?: string; color?: string }
  | { kind: "polyline"; points: { x: number; y: number }[]; label?: string; color?: string }
  | { kind: "label"; x: number; y: number; text: string; color?: string };

export interface RenderSpec {
  rect: { left: number; top: number; width: number; height: number };
  maxSize: number;
  overlayId?: string;
  layers: Set<RenderLayer>;
  highlight: Set<string>;
  dimOthers: boolean;
  marks: Mark[];
  legend: boolean;
}

// Die-viewer defaults (frontend/src/renderer/annotations/style.ts).
const NET_COLOR = "#2e97ff";
const CELL_COLOR = "#ffffff";
const VIA_COLOR = "rgba(130, 214, 166, 0.85)";
const POLY_COLOR = "#fb923c";
const NET_WORLD_WIDTH = 10;
const VIA_WORLD_SIZE = 6;
const HIGHLIGHT = "#ffe600";
const MARK_COLOR = "#ff2bd6";
const PIN_COLOR = "#f59e0b";
const COMMENT_COLOR = "#facc15";
const RULER_COLOR = "#fde047";
const GUIDE_COLOR = "#22d3ee";

// ─── JSON schema + argument parsing (shared by the render tool and the
//     comment `image` attachment) ────────────────────────────────────

const coord = { type: "number" };
export const renderSpecSchemaProperties = {
  x: { type: "number", description: "Region left (die pixels, default 0)" },
  y: { type: "number", description: "Region top (die pixels, default 0)" },
  width: { type: "number", description: "Region width (die pixels, default: to the right edge)" },
  height: { type: "number", description: "Region height (die pixels, default: to the bottom edge)" },
  maxSize: { type: "integer", minimum: 128, maximum: 2048, description: "Max output long side in pixels (default 1024)" },
  overlayId: { type: "string", description: "Overlay image id (get_die_info) to composite under the annotations" },
  layers: {
    type: "array",
    items: { type: "string", enum: [...RENDER_LAYERS] },
    description: `What to draw (default: ${DEFAULT_LAYERS.join(", ")})`
  },
  highlight: {
    type: "array",
    items: { type: "string" },
    description:
      "Ids to emphasize in yellow: nets, net nodes / segments, cells, cell types (all their cells), pins, vias, " +
      "floorplan regions, comments, rulers"
  },
  dimOthers: { type: "boolean", description: "Fade everything not highlighted (default: true when highlighting)" },
  marks: {
    type: "array",
    description:
      "Extra drawing for this image only (not stored as annotations), in die pixels: " +
      "{kind:'box',x,y,width,height}, {kind:'circle',x,y,radius}, {kind:'arrow',x1,y1,x2,y2}, " +
      "{kind:'polyline',points:[{x,y}]}, {kind:'label',x,y,text}; optional label and color (#rrggbb) on each",
    items: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["box", "circle", "arrow", "polyline", "label"] },
        x: coord, y: coord, width: coord, height: coord, radius: coord,
        x1: coord, y1: coord, x2: coord, y2: coord,
        points: { type: "array", items: { type: "object", properties: { x: coord, y: coord } } },
        text: { type: "string" },
        label: { type: "string" },
        color: { type: "string" }
      },
      required: ["kind"]
    }
  },
  legend: { type: "boolean", description: "Draw a wire-layer color legend (default true)" }
};

function markColor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new ToolInputError(`mark "color" must be a #rrggbb hex color`);
  }
  return value;
}

function parseMark(raw: unknown, i: number): Mark {
  const m = raw as Record<string, unknown>;
  if (!m || typeof m !== "object") throw new ToolInputError(`marks[${i}] must be an object`);
  const label = str(m, "label", true);
  const color = markColor(m.color);
  const extra = { ...(label ? { label } : {}), ...(color ? { color } : {}) };
  switch (m.kind) {
    case "box":
      return { kind: "box", x: num(m, "x"), y: num(m, "y"), width: num(m, "width"), height: num(m, "height"), ...extra };
    case "circle":
      return { kind: "circle", x: num(m, "x"), y: num(m, "y"), radius: num(m, "radius"), ...extra };
    case "arrow":
      return { kind: "arrow", x1: num(m, "x1"), y1: num(m, "y1"), x2: num(m, "x2"), y2: num(m, "y2"), ...extra };
    case "polyline": {
      if (!Array.isArray(m.points) || m.points.length < 2) {
        throw new ToolInputError(`marks[${i}].points needs at least 2 {x, y}`);
      }
      const points = m.points.map((p) => ({ x: num(p as Record<string, unknown>, "x"), y: num(p as Record<string, unknown>, "y") }));
      return { kind: "polyline", points, ...extra };
    }
    case "label":
      return { kind: "label", x: num(m, "x"), y: num(m, "y"), text: str(m, "text"), ...(color ? { color } : {}) };
    default:
      throw new ToolInputError(`marks[${i}].kind must be box, circle, arrow, polyline or label`);
  }
}

export async function parseRenderSpec(
  dataRoot: string,
  record: DieRecord,
  args: Record<string, unknown>
): Promise<RenderSpec> {
  const x = Math.max(0, Math.round(num(args, "x", true) ?? 0));
  const y = Math.max(0, Math.round(num(args, "y", true) ?? 0));
  if (x >= record.width || y >= record.height) {
    throw new ToolInputError(`Region starts outside the die (${record.width}×${record.height} px)`);
  }
  const width = Math.min(Math.round(num(args, "width", true) ?? record.width - x), record.width - x);
  const height = Math.min(Math.round(num(args, "height", true) ?? record.height - y), record.height - y);
  if (width <= 0 || height <= 0) throw new ToolInputError(`Region must have a positive width and height`);
  const maxSize = Math.min(2048, Math.max(128, Math.round(num(args, "maxSize", true) ?? 1024)));

  const overlayId = str(args, "overlayId", true);
  if (overlayId && !(await listManifests(dataRoot, record.id)).some((o) => o.id === overlayId)) {
    throw new ToolInputError(`No overlay image with id ${overlayId} (see get_die_info)`);
  }

  let layers = DEFAULT_LAYERS;
  if (args.layers !== undefined) {
    if (!Array.isArray(args.layers) || args.layers.some((l) => !(RENDER_LAYERS as readonly unknown[]).includes(l))) {
      throw new ToolInputError(`"layers" must be a list of: ${RENDER_LAYERS.join(", ")}`);
    }
    layers = args.layers as RenderLayer[];
  }
  if (args.highlight !== undefined && (!Array.isArray(args.highlight) || args.highlight.some((h) => typeof h !== "string"))) {
    throw new ToolInputError(`"highlight" must be a list of ids`);
  }
  const highlight = new Set((args.highlight as string[] | undefined) ?? []);
  if (args.marks !== undefined && !Array.isArray(args.marks)) throw new ToolInputError(`"marks" must be an array`);
  const marks = ((args.marks as unknown[] | undefined) ?? []).map(parseMark);
  const dimOthers = typeof args.dimOthers === "boolean" ? args.dimOthers : highlight.size > 0;
  const legend = typeof args.legend === "boolean" ? args.legend : true;

  return { rect: { left: x, top: y, width, height }, maxSize, overlayId, layers: new Set(layers), highlight, dimOthers, marks, legend };
}

// ─── Rendering ──────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const f = (v: number) => (Math.round(v * 10) / 10).toString();
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function text(x: number, y: number, value: string, opts: { size?: number; color?: string; anchor?: string; opacity?: number } = {}) {
  return (
    `<text x="${f(x)}" y="${f(y)}" font-size="${opts.size ?? 11}" fill="${opts.color ?? "#fff"}"` +
    ` text-anchor="${opts.anchor ?? "start"}"${opts.opacity !== undefined ? ` opacity="${opts.opacity}"` : ""}` +
    ` font-family="DejaVu Sans, Arial, Helvetica, sans-serif" stroke="#000" stroke-width="3"` +
    ` stroke-linejoin="round" paint-order="stroke">${esc(value)}</text>`
  );
}

function hashColor(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 80%, 60%)`;
}

export interface RenderResult {
  jpeg: Buffer;
  width: number;
  height: number;
  region: { x: number; y: number; width: number; height: number };
  diePixelsPerOutputPixel: number;
  /** Comment pins are numbered in the image; this maps numbers back. */
  commentNumbers: { n: number; commentId: string; text: string }[];
  wireLayerColors: Record<string, string>;
}

export async function renderAnnotated(params: {
  dataRoot: string;
  record: DieRecord;
  annotations: DieAnnotations;
  stack: MetalStack;
  spec: RenderSpec;
}): Promise<RenderResult> {
  const { record, annotations, stack, spec } = params;
  const r = spec.rect;
  const crop = await renderDieCrop({
    dataRoot: params.dataRoot,
    dieId: record.id,
    record,
    key: "mcp",
    rect: r,
    minPx: spec.maxSize,
    overlaySourceId: spec.overlayId
  });
  const base = await sharp(crop.path)
    .resize({ width: spec.maxSize, height: spec.maxSize, fit: "inside", withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });
  const W = base.info.width;
  const H = base.info.height;
  const sx = W / r.width;
  const sy = H / r.height;
  const s = (sx + sy) / 2;
  const X = (x: number) => (x - r.left) * sx;
  const Y = (y: number) => (y - r.top) * sy;
  const margin = 40 / s;
  const inView = (x0: number, y0: number, x1: number, y1: number) =>
    Math.max(x0, x1) >= r.left - margin &&
    Math.min(x0, x1) <= r.left + r.width + margin &&
    Math.max(y0, y1) >= r.top - margin &&
    Math.min(y0, y1) <= r.top + r.height + margin;

  const hl = spec.highlight;
  const anyHl = hl.size > 0;
  const fade = (on: boolean) => (anyHl && spec.dimOthers && !on ? ` opacity="0.3"` : "");
  const layers = spec.layers;
  const wireW = clamp(NET_WORLD_WIDTH * s, 1.5, 6);
  const metalColor = new Map<string, string>(stack.metals.map((m) => [m.layer, m.color]));
  metalColor.set("poly", POLY_COLOR);
  const usedWireLayers = new Map<string, string>();
  const wireColor = (layer: string | undefined) => {
    const key = layer ?? "unknown";
    const color = (layer && metalColor.get(layer)) || NET_COLOR;
    usedWireLayers.set(key, color);
    return color;
  };

  const under: string[] = []; // highlight halos, drawn first
  const out: string[] = [];
  const labels: string[] = []; // on top of geometry

  // Analog layers / guides first: background context.
  if (layers.has("analogLayers")) {
    for (const [layer, shapes] of Object.entries(annotations.analogLayers ?? {})) {
      const color = hashColor(layer);
      for (const shape of (shapes ?? []) as LayerShape[]) {
        const on = hl.has(shape.id);
        const svg = shapeSvg(shape, X, Y, s, color, inView);
        if (svg) out.push(`<g${fade(on)}>${svg}</g>`);
      }
    }
  }
  if (layers.has("guides")) {
    for (const g of annotations.guides ?? []) {
      if (g.kind === "line") {
        const line =
          g.axis === "x"
            ? `x1="${f(X(g.pos))}" y1="0" x2="${f(X(g.pos))}" y2="${H}"`
            : `x1="0" y1="${f(Y(g.pos))}" x2="${W}" y2="${f(Y(g.pos))}"`;
        out.push(`<line ${line} stroke="${GUIDE_COLOR}" stroke-width="1" stroke-dasharray="6 4"${fade(hl.has(g.id))}/>`);
      } else if (inView(g.x1, g.y1, g.x2, g.y2)) {
        out.push(
          `<line x1="${f(X(g.x1))}" y1="${f(Y(g.y1))}" x2="${f(X(g.x2))}" y2="${f(Y(g.y2))}" stroke="${GUIDE_COLOR}" stroke-width="1" stroke-dasharray="6 4"${fade(hl.has(g.id))}/>`
        );
      }
    }
  }

  if (layers.has("floorplans")) {
    for (const region of annotations.floorplanRegions ?? []) {
      const pts =
        region.kind === "rect" && region.geometry.length >= 2
          ? [
              region.geometry[0],
              { x: region.geometry[1].x, y: region.geometry[0].y },
              region.geometry[1],
              { x: region.geometry[0].x, y: region.geometry[1].y }
            ]
          : region.geometry;
      if (pts.length < 2) continue;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      if (!inView(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))) continue;
      const on = hl.has(region.id);
      const d = pts.map((p) => `${f(X(p.x))},${f(Y(p.y))}`).join(" ");
      if (on) under.push(`<polygon points="${d}" fill="none" stroke="${HIGHLIGHT}" stroke-width="6" opacity="0.6"/>`);
      out.push(
        `<polygon points="${d}" fill="none" stroke="${esc(region.color)}" stroke-width="2.2" stroke-dasharray="7 4"${fade(on)}/>`
      );
      if (region.name) {
        labels.push(text(X(Math.min(...xs)) + 4, Y(Math.min(...ys)) + 14, region.name, { size: 12, color: region.color, opacity: anyHl && spec.dimOthers && !on ? 0.4 : undefined }));
      }
    }
  }

  if (layers.has("cells")) {
    const types = new Map(annotations.cellTypes.map((ct) => [ct.id, ct]));
    for (const cell of annotations.cells) {
      const ct = types.get(cell.cellTypeId);
      if (!ct) continue;
      const box = cellDieRect(cell, ct.cropRect.width, ct.cropRect.height);
      if (!inView(box.x, box.y, box.x + box.width, box.y + box.height)) continue;
      const on = hl.has(cell.id) || hl.has(ct.id);
      const color = ct.color ?? CELL_COLOR;
      const rect = `x="${f(X(box.x))}" y="${f(Y(box.y))}" width="${f(box.width * sx)}" height="${f(box.height * sy)}"`;
      if (on) under.push(`<rect ${rect} fill="none" stroke="${HIGHLIGHT}" stroke-width="5" opacity="0.7"/>`);
      out.push(`<rect ${rect} fill="${esc(color)}" fill-opacity="0.08" stroke="${esc(color)}" stroke-width="1.2"${fade(on)}/>`);
      if (box.width * sx >= 36 && box.height * sy >= 14) {
        labels.push(text(X(box.x) + 3, Y(box.y) + 11, clip(ct.name, Math.floor((box.width * sx) / 6.5)), { size: 10, color, opacity: anyHl && spec.dimOthers && !on ? 0.4 : undefined }));
      }
    }
  }

  if (layers.has("wires") || layers.has("netLabels")) {
    for (const net of annotations.nets) {
      const byId = new Map(net.nodes.map((n) => [n.id, n]));
      const netOn = hl.has(net.id);
      const paths = new Map<string, { d: string[]; on: boolean; layer: string | undefined }>();
      let longest: { len: number; x: number; y: number } | null = null;
      for (const e of net.edges) {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b || !inView(a.x, a.y, b.x, b.y)) continue;
        const on = netOn || hl.has(e.id);
        const key = `${e.layer ?? ""}|${on ? 1 : 0}`;
        const group = paths.get(key) ?? { d: [], on, layer: e.layer };
        group.d.push(`M${f(X(a.x))} ${f(Y(a.y))}L${f(X(b.x))} ${f(Y(b.y))}`);
        paths.set(key, group);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (!longest || len > longest.len) longest = { len, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
      if (layers.has("wires")) {
        for (const { d, on, layer } of paths.values()) {
          const path = d.join("");
          if (on) {
            under.push(`<path d="${path}" stroke="#000" stroke-width="${f(wireW + 6)}" stroke-linecap="round" fill="none" opacity="0.7"/>`);
            under.push(`<path d="${path}" stroke="${HIGHLIGHT}" stroke-width="${f(wireW + 3)}" stroke-linecap="round" fill="none"/>`);
          }
          out.push(`<path d="${path}" stroke="${esc(wireColor(layer))}" stroke-width="${f(wireW)}" stroke-linecap="round" fill="none"${fade(on)}/>`);
        }
        // Junctions (3+ segments) and highlighted vertices.
        const degree = new Map<string, number>();
        for (const e of net.edges) {
          degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
          degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
        }
        for (const n of net.nodes) {
          if (!inView(n.x, n.y, n.x, n.y)) continue;
          if (hl.has(n.id)) {
            out.push(`<circle cx="${f(X(n.x))}" cy="${f(Y(n.y))}" r="${f(wireW + 5)}" fill="none" stroke="${HIGHLIGHT}" stroke-width="2.5"/>`);
          } else if ((degree.get(n.id) ?? 0) >= 3 && paths.size) {
            out.push(`<circle cx="${f(X(n.x))}" cy="${f(Y(n.y))}" r="${f(wireW * 0.9)}" fill="#fff"${fade(netOn)}/>`);
          }
        }
      }
      if (layers.has("netLabels") && longest && net.name) {
        labels.push(text(X(longest.x), Y(longest.y) - wireW - 2, net.name, { size: 10, anchor: "middle", opacity: anyHl && spec.dimOthers && !netOn ? 0.4 : undefined }));
      }
    }
  }

  if (layers.has("vias")) {
    const viaColor = new Map(stack.vias.map((v) => [v.id, v.color]));
    const viaR = clamp((VIA_WORLD_SIZE / 2) * s * 1.6, 2.5, 7);
    for (const a of annotations.annotations ?? []) {
      if (a.class !== "point_via" && a.class !== "irregular_via") continue;
      const on = hl.has(a.id);
      const color = a.color ?? (a.layer && viaColor.get(a.layer)) ?? VIA_COLOR;
      if (a.geometry.kind === "point") {
        const { x, y } = a.geometry;
        if (!inView(x, y, x, y)) continue;
        if (on) under.push(`<circle cx="${f(X(x))}" cy="${f(Y(y))}" r="${f(viaR + 4)}" fill="${HIGHLIGHT}"/>`);
        out.push(`<circle cx="${f(X(x))}" cy="${f(Y(y))}" r="${f(viaR)}" fill="${esc(color)}" stroke="#000" stroke-width="1"${fade(on)}/>`);
      } else if (a.geometry.kind === "polygon") {
        const pts = a.geometry.points;
        if (!pts.some((p) => inView(p.x, p.y, p.x, p.y))) continue;
        out.push(`<polygon points="${pts.map((p) => `${f(X(p.x))},${f(Y(p.y))}`).join(" ")}" fill="${esc(color)}" stroke="#000" stroke-width="1"${fade(on)}/>`);
      }
    }
  }

  if (layers.has("pins")) {
    for (const pin of annotations.pins ?? []) {
      if (!inView(pin.x, pin.y, pin.x, pin.y)) continue;
      const on = hl.has(pin.id);
      const cx = X(pin.x);
      const cy = Y(pin.y);
      if (on) under.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="11" fill="${HIGHLIGHT}"/>`);
      out.push(`<rect x="${f(cx - 5)}" y="${f(cy - 5)}" width="10" height="10" transform="rotate(45 ${f(cx)} ${f(cy)})" fill="${PIN_COLOR}" stroke="#000" stroke-width="1"${fade(on)}/>`);
      labels.push(text(cx + 9, cy + 4, `${pin.pin}${pin.name ? ` ${pin.name}` : ""}`, { size: 11, color: PIN_COLOR, opacity: anyHl && spec.dimOthers && !on ? 0.4 : undefined }));
    }
  }

  if (layers.has("rulers")) {
    for (const ruler of annotations.rulers ?? []) {
      if (!inView(ruler.x1, ruler.y1, ruler.x2, ruler.y2)) continue;
      const on = hl.has(ruler.id);
      out.push(`<line x1="${f(X(ruler.x1))}" y1="${f(Y(ruler.y1))}" x2="${f(X(ruler.x2))}" y2="${f(Y(ruler.y2))}" stroke="${on ? HIGHLIGHT : RULER_COLOR}" stroke-width="1.8"${fade(on)}/>`);
      const length = ruler.lengthUm > 0 ? `${ruler.lengthUm.toFixed(2)} µm` : `${Math.round(ruler.lengthPx)} px`;
      labels.push(text(X((ruler.x1 + ruler.x2) / 2), Y((ruler.y1 + ruler.y2) / 2) - 5, `${ruler.name ? `${ruler.name}: ` : ""}${length}`, { size: 11, color: RULER_COLOR, anchor: "middle" }));
    }
  }

  const commentNumbers: RenderResult["commentNumbers"] = [];
  if (layers.has("comments")) {
    (annotations.comments ?? []).forEach((c, i) => {
      if (!inView(c.x, c.y, c.x, c.y)) return;
      const n = i + 1;
      commentNumbers.push({ n, commentId: c.id, text: c.text });
      const on = hl.has(c.id);
      const cx = X(c.x);
      const cy = Y(c.y);
      if (on) under.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="13" fill="${HIGHLIGHT}"/>`);
      out.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="9" fill="${COMMENT_COLOR}" stroke="#000" stroke-width="1.2"${fade(on)}/>`);
      labels.push(`<text x="${f(cx)}" y="${f(cy + 3.5)}" font-size="10" font-weight="bold" fill="#000" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif">${n}</text>`);
      labels.push(text(cx + 13, cy + 4, clip(c.text.replace(/\s+/g, " "), 40), { size: 11, color: COMMENT_COLOR, opacity: anyHl && spec.dimOthers && !on ? 0.4 : undefined }));
    });
  }

  for (const mark of spec.marks) labels.push(markSvg(mark, X, Y, sx, sy));

  if (spec.legend && layers.has("wires") && usedWireLayers.size) {
    const entries = [...usedWireLayers.entries()].sort(([a], [b]) => a.localeCompare(b));
    const h = entries.length * 15 + 8;
    const top = H - h - 6;
    labels.push(`<rect x="6" y="${top}" width="92" height="${h}" rx="4" fill="#000" fill-opacity="0.6"/>`);
    entries.forEach(([layer, color], i) => {
      const y = top + 12 + i * 15;
      labels.push(`<line x1="13" y1="${y - 4}" x2="31" y2="${y - 4}" stroke="${esc(color)}" stroke-width="4" stroke-linecap="round"/>`);
      labels.push(text(37, y, layer, { size: 10 }));
    });
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    under.join("") + out.join("") + labels.join("") +
    `</svg>`;
  const jpeg = await sharp(base.data)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();

  return {
    jpeg,
    width: W,
    height: H,
    region: { x: r.left, y: r.top, width: r.width, height: r.height },
    diePixelsPerOutputPixel: Number((r.width / W).toFixed(4)),
    commentNumbers,
    wireLayerColors: Object.fromEntries(usedWireLayers)
  };
}

function shapeSvg(
  shape: LayerShape,
  X: (x: number) => number,
  Y: (y: number) => number,
  s: number,
  color: string,
  inView: (x0: number, y0: number, x1: number, y1: number) => boolean
): string | null {
  const stroke = `fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="1.2"`;
  switch (shape.kind) {
    case "rect":
      if (!inView(shape.x, shape.y, shape.x + shape.width, shape.y + shape.height)) return null;
      return `<rect x="${f(X(shape.x))}" y="${f(Y(shape.y))}" width="${f(shape.width * s)}" height="${f(shape.height * s)}" ${stroke}/>`;
    case "line":
      if (!inView(shape.x1, shape.y1, shape.x2, shape.y2)) return null;
      return `<line x1="${f(X(shape.x1))}" y1="${f(Y(shape.y1))}" x2="${f(X(shape.x2))}" y2="${f(Y(shape.y2))}" stroke="${color}" stroke-opacity="0.6" stroke-width="${f(Math.max(1, shape.width * s))}" stroke-linecap="square"/>`;
    case "point":
      if (!inView(shape.x, shape.y, shape.x, shape.y)) return null;
      return `<circle cx="${f(X(shape.x))}" cy="${f(Y(shape.y))}" r="${f(Math.max(2, (shape.size / 2) * s))}" ${stroke}/>`;
    case "circle":
      if (!inView(shape.x - shape.radius, shape.y - shape.radius, shape.x + shape.radius, shape.y + shape.radius)) return null;
      return `<circle cx="${f(X(shape.x))}" cy="${f(Y(shape.y))}" r="${f(Math.max(2, shape.radius * s))}" ${stroke}/>`;
    case "polygon": {
      if (!shape.points.some((p) => inView(p.x, p.y, p.x, p.y))) return null;
      return `<polygon points="${shape.points.map((p) => `${f(X(p.x))},${f(Y(p.y))}`).join(" ")}" ${stroke}/>`;
    }
  }
}

function markSvg(mark: Mark, X: (x: number) => number, Y: (y: number) => number, sx: number, sy: number): string {
  const color = mark.color ?? MARK_COLOR;
  const halo = (shape: string) =>
    shape.replace("/>", ` stroke="#000" stroke-width="6" stroke-opacity="0.55" fill="none"/>`) +
    shape.replace("/>", ` stroke="${color}" stroke-width="2.6" fill="none"/>`);
  const caption = (x: number, y: number, value: string | undefined) =>
    value ? text(x, y, value, { size: 13, color }) : "";
  switch (mark.kind) {
    case "box":
      return (
        halo(`<rect x="${f(X(mark.x))}" y="${f(Y(mark.y))}" width="${f(mark.width * sx)}" height="${f(mark.height * sy)}" rx="2"/>`) +
        caption(X(mark.x), Y(mark.y) - 6, mark.label)
      );
    case "circle":
      return (
        halo(`<ellipse cx="${f(X(mark.x))}" cy="${f(Y(mark.y))}" rx="${f(Math.max(4, mark.radius * sx))}" ry="${f(Math.max(4, mark.radius * sy))}"/>`) +
        caption(X(mark.x) + mark.radius * sx + 6, Y(mark.y) + 4, mark.label)
      );
    case "arrow": {
      const x1 = X(mark.x1), y1 = Y(mark.y1), x2 = X(mark.x2), y2 = Y(mark.y2);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = (a: number) => `${f(x2 - 13 * Math.cos(angle + a))},${f(y2 - 13 * Math.sin(angle + a))}`;
      const tip = `<polygon points="${f(x2)},${f(y2)} ${head(0.45)} ${head(-0.45)}" fill="${color}" stroke="#000" stroke-width="1"/>`;
      return halo(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`) + tip + caption(x1 + 4, y1 - 6, mark.label);
    }
    case "polyline":
      return (
        halo(`<polyline points="${mark.points.map((p) => `${f(X(p.x))},${f(Y(p.y))}`).join(" ")}" stroke-linejoin="round"/>`) +
        caption(X(mark.points[0].x) + 4, Y(mark.points[0].y) - 6, mark.label)
      );
    case "label":
      return text(X(mark.x), Y(mark.y), mark.text, { size: 13, color });
  }
}
