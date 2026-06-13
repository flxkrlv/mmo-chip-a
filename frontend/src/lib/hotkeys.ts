/**
 * hotkeys.ts — Central keyboard shortcut registry.
 *
 * Maps keys to tool actions. One file to configure; easy to extend with a
 * GUI editor later. No modifier keys here (Ctrl/Shift are handled separately
 * for undo/redo).
 */

// ── Die Viewer hotkeys ────────────────────────────────────────

export type DieViewerToolId =
  | "select"
  | "wire"
  | "multiWire"
  | "via"
  | "viaRect"
  | "viaPoly"
  | "addCell"
  | "cellGuideLine"
  | "cellGuideSeg"
  | "ioPoint"
  | "roi"
  | "ignore"
  | "measure"
  | "pan";

export const DIE_VIEWER_HOTKEYS: Record<string, DieViewerToolId> = {
  "s": "select",
  "w": "wire",
  "b": "multiWire",
  "o": "via",
  "k": "measure",
  "r": "addCell",
  "p": "ioPoint",
  "f": "pan",       // f = fit is handled separately; pan is fallback
};

// ── Cell RE hotkeys ───────────────────────────────────────────

export type ReToolId = "select" | "pan" | "rect" | "polygon" | "point" | "polyline";

export const CELL_RE_HOTKEYS: Record<string, ReToolId> = {
  "r": "rect",
  "p": "polygon",
  "o": "point",     // o = via/contact point
};

// ── Global action hotkeys (no modifier) ───────────────────────

export type GlobalAction = "fitToScreen" | "zoomIn" | "zoomOut";

export const GLOBAL_HOTKEYS: Record<string, GlobalAction> = {
  "f": "fitToScreen",
  "+": "zoomIn",
  "=": "zoomIn",    // unshifted +
  "-": "zoomOut",
};
