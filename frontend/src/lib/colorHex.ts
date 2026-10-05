/**
 * colorHex.ts — colors as the Inspector shows / copies them, plus the color
 * rules the canvas uses for wires and cells (renderer/annotations/nets.ts,
 * dieAnnotations.ts), so the Inspector reports what is actually drawn.
 */

import type { AnnotationNet, AnnotationNetEdge, CellType } from "shared";

/**
 * `color` as hex: #rrggbb, or #rrggbbaa when it is translucent. Accepts
 * #rgb / #rgba / #rrggbb / #rrggbbaa and rgb() / rgba(); anything else is
 * returned unchanged.
 */
export function toHex(color: string): string {
  const c = color.trim();
  const short = c.match(/^#([0-9a-f]{3,4})$/i);
  if (short) return toHex("#" + short[1].replace(/./g, "$&$&"));
  const long = c.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (long) {
    const alpha = long[2]?.toLowerCase();
    return `#${long[1].toLowerCase()}${alpha && alpha !== "ff" ? alpha : ""}`;
  }
  const rgb = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i);
  if (rgb) {
    const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    let a = 1;
    if (rgb[4] !== undefined) a = rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    const hex = `#${byte(+rgb[1])}${byte(+rgb[2])}${byte(+rgb[3])}`;
    return a >= 1 ? hex : hex + byte(a * 255);
  }
  return c;
}

/** The preferences the wire colors depend on. */
export interface NetColorPrefs {
  netColor: string;
  netColors: Record<string, string>;
  customNetColorsEnabled: boolean;
  wireLayerColors: Record<string, string>;
}

/** Color of one wire segment: the net's own color (when custom net colors
 *  are on), else its layer color, else the net / global wire color. */
export function edgeColor(
  netId: string,
  edge: Pick<AnnotationNetEdge, "layer">,
  prefs: NetColorPrefs,
  defaultLayerColors: Record<string, string>
): string {
  const own = prefs.netColors[`net:${netId}`];
  if (prefs.customNetColorsEnabled && own) return own;
  const layer = edge.layer && (prefs.wireLayerColors[edge.layer] ?? defaultLayerColors[edge.layer]);
  return layer || own || prefs.netColor;
}

/** Distinct segment colors of a net, most used first (the base color for a
 *  net without segments). */
export function netColors(net: AnnotationNet, prefs: NetColorPrefs, defaultLayerColors: Record<string, string>): string[] {
  if (net.edges.length === 0) return [prefs.netColors[`net:${net.id}`] ?? prefs.netColor];
  const counts = new Map<string, number>();
  for (const e of net.edges) {
    const c = edgeColor(net.id, e, prefs, defaultLayerColors);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

/** Color cells of `cellType` are drawn with. */
export function cellTypeColor(cellType: Pick<CellType, "color"> | undefined, globalCellColor: string): string {
  return cellType?.color ?? globalCellColor;
}
