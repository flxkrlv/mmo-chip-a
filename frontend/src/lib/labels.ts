import type { ShapeLabel } from "shared";

/**
 * Human-readable form of a `ShapeLabel`. The data model still uses `"vcc"`
 * (kept for backwards compatibility with annotations already on disk), but
 * the proper CMOS convention is **VDD** for the positive supply rail — the
 * UI always renders VDD so a CMOS schematic reads correctly. Use this
 * everywhere instead of `label.toUpperCase()`.
 */
export function displayLabel(label: ShapeLabel): string {
  switch (label) {
    case "vcc":
      return "VDD";
    case "gnd":
      return "GND";
    case "io":
      return "I/O";
    case "input":
      return "INPUT";
    case "output":
      return "OUTPUT";
  }
}

/**
 * Resolve a net to the display name everywhere in the cell-RE UI:
 * the user's arbitrary `customName` wins (e.g. "CLK"); otherwise the
 * `ShapeLabel`-derived name (VDD / GND / INPUT / …); finally a
 * `netN` fallback. Keeping this in one place so all canvases (image,
 * CMOS schematic, logic schematic) and the right panel agree.
 */
export function netDisplayName(net: {
  id: number;
  label?: ShapeLabel;
  customName?: string;
}): string {
  if (net.customName && net.customName.length > 0) return net.customName;
  if (net.label) return displayLabel(net.label);
  return `net${net.id}`;
}
