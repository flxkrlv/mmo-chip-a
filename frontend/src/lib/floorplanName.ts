/**
 * floorplanName.ts — floorplan region names may span several lines (entered
 * in the floorplan window / Inspector). The canvas label draws one line per
 * row; single-line places (outline, hover readout, menus) show the lines
 * joined with " · ". Exports sanitize names on their own (newline → "_").
 */

/** Separator for showing a multiline name on one line. */
export const FLOORPLAN_NAME_JOIN = " · ";

/** Trailing spaces per line and leading / trailing blank lines removed. */
export function normalizeFloorplanName(name: string): string {
  const lines = name.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}

/** Lines of a (normalized) name, for the canvas label. Empty name → []. */
export function floorplanNameLines(name: string): string[] {
  const n = normalizeFloorplanName(name);
  return n ? n.split("\n") : [];
}

/** The name on one line: non-blank lines joined with " · ". */
export function floorplanNameInline(name: string): string {
  return floorplanNameLines(name)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(FLOORPLAN_NAME_JOIN);
}
