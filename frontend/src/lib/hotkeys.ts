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
  | "pan"
  | "comment"
  | "floorplan";

export const DIE_VIEWER_HOTKEYS: Record<string, DieViewerToolId> = {
  "s": "select",
  "w": "wire",
  "b": "multiWire",
  "o": "via",
  "k": "measure",
  "r": "addCell",
  "p": "ioPoint",
  "f": "pan",       // f = fit is handled separately; pan is fallback
  "c": "comment",
  "h": "floorplan",
};

// ── Cell RE hotkeys ───────────────────────────────────────────

export type ReToolId = "select" | "pan" | "rect" | "polygon" | "point" | "polyline";

export const CELL_RE_HOTKEYS: Record<string, ReToolId> = {
  "r": "rect",
  "p": "polygon",
  "o": "point",     // o = via/contact point
  "l": "polyline",
};

// ── Global action hotkeys (no modifier) ───────────────────────

export type GlobalAction = "fitToScreen" | "zoomIn" | "zoomOut";

export const GLOBAL_HOTKEYS: Record<string, GlobalAction> = {
  "f": "fitToScreen",
  "+": "zoomIn",
  "=": "zoomIn",    // unshifted +
  "-": "zoomOut",
};

// ── Navigation hotkeys (1–5, tab switching) ─────────────────────
// Maps key → index into TAB_ROUTES in App.tsx.
// 0=Library, 1=Die viewer, 2=Merge cells, 3=RE cell, 4=Code, 5=Netlist (Analog)
export const NAV_HOTKEYS: Record<string, number> = {
  "1": 1,  // Die viewer
  "2": 2,  // Merge cells
  "3": 3,  // RE cell
  "4": 4,  // Code
  "5": 5,  // Netlist (Analog)
};

// ── Merge Cells mode hotkeys ────────────────────────────────────
// Alt+1..Alt+5 to switch merge view mode (Alt prefix avoids conflict
// with NAV_HOTKEYS which uses bare digits for tab switching).
export type MergeModeId = "overlay" | "sxs" | "diff" | "specimen" | "candidate";

export const MERGE_HOTKEYS: Record<string, MergeModeId> = {
  "Alt+1": "overlay",
  "Alt+2": "sxs",
  "Alt+3": "diff",
  "Alt+4": "specimen",
  "Alt+5": "candidate",
};

// ── Analog Netlist (Netlist page) hotkeys ───────────────────────
export type AnalogNetlistAction =
  | "toggleGraph"      // G — switch between Code / Graph views
  | "toggleHierarchy" // H — toggle hierarchical netlist
  | "toggleResFormat"  // R — resistor format ohms / sq·Rs
  | "toggleMatch"     // M — toggle device geometry matching
  | "viewCode"        // Alt+1 — Code view
  | "viewGraph"       // Alt+2 — Graph view
  | "viewSchematic";  // Alt+3 — Schematic view

export const ANALOG_NETLIST_HOTKEYS: Record<string, AnalogNetlistAction> = {
  "g": "toggleGraph",
  "G": "toggleGraph",
  "h": "toggleHierarchy",
  "H": "toggleHierarchy",
  "r": "toggleResFormat",
  "R": "toggleResFormat",
  "m": "toggleMatch",
  "M": "toggleMatch",
};

/** Alt+1/2/3 view switch mappings (checked in handler via e.altKey) */
export const ANALOG_NETLIST_ALT_HOTKEYS: Record<string, AnalogNetlistAction> = {
  "1": "viewCode",
  "2": "viewGraph",
  "3": "viewSchematic",
};

// ── Overlay hotkeys (shared across Die viewer / Merge / RE Cell) ─
//   Ctrl+Shift+B    — toggle base image visibility
//   ]               — cycle to next overlay (toggle on/off)
//   [               — cycle to previous overlay (toggle on/off)
//   Ctrl+Shift+1..8 — toggle overlay layer #1..#8 directly
// These are handled by the `useOverlayHotkeys()` hook.
