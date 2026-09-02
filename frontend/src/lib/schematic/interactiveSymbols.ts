/**
 * interactiveSymbols.ts — Symbol templates for the interactive analog
 * schematic canvas.
 *
 * Parses the static `CUSTOM_ANALOG_SKIN` (netlist2svg markup: `<g s:type>`
 * bodies + `<g s:x s:y s:pid>` pin anchors) ONCE into `SymbolTemplate`s.
 * Bodies are injected verbatim into a shared `<defs>` and placed with
 * `<use href="#isch-<type>">` so the interactive canvas renders pixel-
 * identical symbols to the static netlist2svg view — the 4-terminal
 * nmos_v/pmos_v art is NOT redrawn.
 *
 * Per-instance text labels (ref / value / name) live in the skin as
 * `<text s:attribute="...">`; `<use>` clones share one DOM subtree so
 * labels cannot vary inside it. We therefore strip texts from the body
 * and record `SymbolLabelSpec`s instead — the canvas renders them per
 * device next to the `<use>`.
 *
 * Pin anchors (dx, dy in symbol-local coordinates) drive both the ELK
 * port geometry (wires land exactly on visual pins, same trick as
 * `netlist.tsx` `portConstraints: FIXED_POS`) and the drag-time wire
 * re-routing anchor table.
 */

import { CUSTOM_ANALOG_SKIN } from "./netlist2svgSkin";
import { cellTypeForDevice, DEVICE_PORT_MAP, deviceAttributes } from "./netlist2svgFormat";
import type { AnalogDevice, DeviceGeometryMOS } from "shared";

// ── Types ────────────────────────────────────────────────────────

/** A pin anchor parsed from `<g s:x s:y s:pid s:position>`. */
export interface SymbolPin {
  /** Skin port id — the target of DEVICE_PORT_MAP terminal mapping. */
  pid: string;
  /** Offset from the symbol's local origin (0,0 = top-left of the body). */
  dx: number;
  dy: number;
  /** Skin hint: top | bottom | left | right. */
  position: "top" | "bottom" | "left" | "right" | string;
}

/** A per-instance text label declared in the skin via `s:attribute`. */
export interface SymbolLabelSpec {
  x: number;
  y: number;
  /** Which per-device value fills this label. */
  source: "name" | "ref" | "value";
  /** CSS class from the skin (nodelabel / valuelabel / …), `$cell_id` stripped. */
  cls: string;
}

/** One parsed skin symbol: body markup + pin anchors + label specs. */
export interface SymbolTemplate {
  /** Skin `s:type` value. */
  type: string;
  /** Skin `s:alias` values (device kinds reference these, e.g. `r_v`). */
  aliases: string[];
  width: number;
  height: number;
  /** Sanitized body markup — no texts, no pin groups, `$cell_id` stripped.
   *  Trusted static string from our own skin; injected into `<defs>`. */
  body: string;
  pins: SymbolPin[];
  labels: SymbolLabelSpec[];
}

/** Parsed skin, indexed by both `s:type` and alias values. */
export interface SymbolTable {
  templates: SymbolTemplate[];
  byKey: Map<string, SymbolTemplate>;
}

// ── Skin parsing ─────────────────────────────────────────────────

const G_TAG_RE = /<(\/?)g\b([^>]*?)(\/?)>/g;

function attr(name: string, tag: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

/** Depth-walk from an opening `<g ...>` tag to its matching `</g>`.
 *  Self-closing `<g .../>` tags span just the tag itself.
 *  Returns [endIndexExclusive, innerContent] or null on imbalance. */
function matchGroup(s: string, openStart: number): [number, string] | null {
  const openEnd = s.indexOf(">", openStart);
  if (openEnd < 0) return null;
  if (s[openEnd - 1] === "/") return [openEnd + 1, ""];
  G_TAG_RE.lastIndex = openEnd + 1;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = G_TAG_RE.exec(s))) {
    if (m[1] === "/") depth--;
    else if (m[3] !== "/") depth++;
    if (depth === 0) return [m.index + m[0].length, s.slice(openEnd + 1, m.index)];
  }
  return null;
}

function parsePinsAndBody(inner: string): { pins: SymbolPin[]; body: string; labels: SymbolLabelSpec[] } {
  // 1. Labels first — only texts with s:attribute count (port-name texts
  //    inside generic pin groups have none and are removed with the group).
  const labels: SymbolLabelSpec[] = [];
  const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let tm: RegExpExecArray | null;
  while ((tm = textRe.exec(inner))) {
    const attrsTag = tm[1];
    const source = attr("s:attribute", attrsTag);
    if (source !== "name" && source !== "ref" && source !== "value") continue;
    labels.push({
      x: Number(attr("x", attrsTag) ?? 0),
      y: Number(attr("y", attrsTag) ?? 0),
      source,
      cls: (attr("class", attrsTag) ?? "").replace(/\$cell_id/g, "").trim(),
    });
  }

  // 2. Remove pin groups (whole `<g ... s:pid=...>…</g>` spans, incl. nested)
  //    in a single pass — compute all spans on `inner`, then rebuild.
  const pinOpens: number[] = [];
  const pinTagRe = /<g\b[^>]*>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pinTagRe.exec(inner))) {
    if (/s:pid="/.test(pm[0])) pinOpens.push(pm.index);
  }
  const spans: Array<[number, number]> = [];
  for (const start of pinOpens) {
    const matched = matchGroup(inner, start);
    if (matched) spans.push([start, matched[0]]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let body = "";
  let pos = 0;
  for (const [s0, e0] of spans) {
    if (s0 < pos) continue; // nested inside a previously-removed span
    body += inner.slice(pos, s0);
    pos = e0;
  }
  body += inner.slice(pos);

  // 3. Remove remaining block-level texts (ref/value/name placeholders).
  body = body.replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, "");

  // 4. Collect pin anchors from the ORIGINAL inner (before removal).
  const pins: SymbolPin[] = [];
  for (const start of pinOpens) {
    const tagEnd = inner.indexOf(">", start);
    const tag = inner.slice(start, tagEnd + 1);
    pins.push({
      pid: attr("s:pid", tag) ?? "",
      dx: Number(attr("s:x", tag) ?? 0),
      dy: Number(attr("s:y", tag) ?? 0),
      position: attr("s:position", tag) ?? "",
    });
  }

  // 5. Bake explicit white presentation attributes into the body.
  //
  // The skin styles its art via classes (.symbol/.detail/.connect) and a
  // root-class stroke inherit — but class rules may not reach <use>
  // shadow-clone content in every engine, and elements whose class was
  // only "$cell_id" (bare paths) would fall back to SVG's default
  // fill:#000 — black art on the dark canvas. Baking stroke/fill as
  // presentation attributes makes the symbols self-contained; CSS rules
  // (power colors) still override presentation attributes when they do
  // match, so nothing is lost.
  body = body
    .replace(/\$cell_id/g, "")
    .replace(/style="[^"]*fill:\s*#000(?:000)?[^"]*"/g, 'fill="#ffffff"')
    .replace(/style="[^"]*stroke:\s*#000(?:000)?[^"]*"/g, 'stroke="#ffffff"')
    .replace(/class="([^"]*)"/g, (_m, cls: string) => {
      const parts = cls.trim().split(/\s+/).filter(Boolean);
      const has = (c: string) => parts.includes(c);
      let attrs = "";
      if (has("symbol")) {
        attrs = ' stroke="#ffffff" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"';
      } else if (has("detail")) {
        attrs = ' stroke="#ffffff" fill="#ffffff"';
      } else if (has("connect")) {
        attrs = ' stroke="#ffffff" stroke-width="1.4" fill="none"';
      } else {
        // Bare skin path (class was only "$cell_id"): white wire art.
        attrs = ' stroke="#ffffff" stroke-width="1.4" fill="none"';
      }
      // Keep meaningful classes so CSS (power colors) can still override.
      return parts.length > 0 ? `class="${parts.join(" ")}"${attrs}` : attrs;
    })
    .trim();

  return { pins, body, labels };
}

/** Parse `CUSTOM_ANALOG_SKIN` into symbol templates. */
export function parseSymbolSkin(skin: string = CUSTOM_ANALOG_SKIN): SymbolTable {
  const templates: SymbolTemplate[] = [];
  let i = 0;
  for (;;) {
    const start = skin.indexOf('<g s:type="', i);
    if (start < 0) break;
    const openEnd = skin.indexOf(">", start);
    const openTag = skin.slice(start, openEnd + 1);
    const type = attr("s:type", openTag) ?? "";
    const width = Number(attr("s:width", openTag) ?? 0);
    const height = Number(attr("s:height", openTag) ?? 0);
    const matched = matchGroup(skin, start);
    if (!matched) break;
    const { pins, body, labels } = parsePinsAndBody(matched[1]);
    const aliasMatch = /<s:alias\s+val="([^"]+)"/.exec(matched[1]);
    templates.push({
      type,
      aliases: aliasMatch ? [aliasMatch[1]] : [],
      width,
      height,
      body,
      pins,
      labels,
    });
    i = matched[0];
  }

  const byKey = new Map<string, SymbolTemplate>();
  for (const t of templates) {
    byKey.set(t.type, t);
    for (const a of t.aliases) byKey.set(a, t);
  }
  return { templates, byKey };
}

// ── Device-facing helpers ────────────────────────────────────────

/** Skin template for a device (device kind → cell type → skin alias). */
export function templateForDevice(table: SymbolTable, d: AnalogDevice): SymbolTemplate | undefined {
  return table.byKey.get(cellTypeForDevice(d));
}

/** Terminal name (D/G/S/B, PLUS/MINUS, …) → skin pin for a device. */
export function pinForTerminal(
  d: AnalogDevice,
  termName: string,
  template: SymbolTemplate,
): SymbolPin | undefined {
  const portMap = DEVICE_PORT_MAP[d.kind] ?? { PLUS: "A", MINUS: "B" };
  const pid = portMap[termName];
  if (!pid) return undefined;
  return template.pins.find((p) => p.pid === pid);
}

/** Resolve a label spec to concrete text for a device. */
export function labelForSpec(spec: SymbolLabelSpec, d: AnalogDevice, deviceKey: string): string {
  if (spec.source === "name") return deviceKey;
  const attrs = deviceAttributes(d);
  return spec.source === "ref" ? attrs.ref : (attrs.value ?? "");
}

/** MOS devices carry their type in geometry — needed by callers that
 *  branch on polarity (e.g. driver-side inference). */
export function mosType(d: AnalogDevice): "nmos" | "pmos" | undefined {
  if (d.kind !== "mos") return undefined;
  return (d.geometry as DeviceGeometryMOS).mosType === "pmos" ? "pmos" : "nmos";
}

// ── Canvas stylesheet ────────────────────────────────────────────

/**
 * Stylesheet for the interactive canvas. Symbol art itself carries baked
 * white presentation attributes (see parsePinsAndBody) so it renders
 * regardless of CSS reach into <use> shadow trees; this sheet styles the
 * per-instance text labels and recolors power symbols (CSS rules beat
 * presentation attributes).
 */
export const INTERACTIVE_SCHEMATIC_CSS = `
.isch text {
  fill: #ffffff; stroke: none;
  font-family: var(--mono, ui-monospace, monospace);
  font-weight: 600;
}
.isch .nodelabel { font-size: 10px; text-anchor: middle; }
.isch .valuelabel { font-size: 9px; fill: #88aabb; white-space: pre; text-anchor: middle; }
.isch-vcc .symbol, .isch-vcc .connect, .isch-vcc path { stroke: #ff3344; }
.isch-vcc .detail { stroke: #ff3344; fill: #ff3344; }
.isch-vcc text { fill: #ff3344; }
.isch-gnd .symbol, .isch-gnd .connect, .isch-gnd path { stroke: #3388ff; }
.isch-gnd .detail { stroke: #3388ff; fill: #3388ff; }
.isch-gnd text { fill: #3388ff; }
`;
