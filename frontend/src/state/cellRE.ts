import { create } from "zustand";
import type { LayerShape, LayerType } from "shared";

/** Tool kinds for the Cells-RE page (a separate union from the die viewer
 *  so the two pages can't collide). */
export type ReToolKind = "select" | "pan" | "rect" | "polygon" | "point";

/** A shape on the clipboard, kept paired with the layer it came from so the
 *  paste can choose a sensible default layer (current layer, falling back to
 *  this one). Each entry is a deep copy with a fresh id at paste-time. */
export interface CellREClipboardItem {
  layer: LayerType;
  shape: LayerShape;
}

interface CellREState {
  /** The currently-selected cell type — the canvas + right panel both read
   *  off this. Null = nothing selected yet. */
  activeCellTypeId: string | null;
  /** Which instance is loaded in the canvas. Null ⇒ first member of the type
   *  (resolved by helpers). */
  activeCellId: string | null;
  /** Active tool. Defaults to select so cold-start lands in the safe tool. */
  activeTool: ReToolKind;
  /** Current target layer for the drawing tools. Rect/polygon use one of the
   *  4 shape layers; point uses one of the 2 via layers. We store one value
   *  per tool-category in the same field — switching tool may shift to a
   *  compatible default. */
  activeLayer: LayerType;
  /** Selected shape ids. Ids are namespaced `${layer}:${shapeId}` so the same
   *  raw shape id used across layers stays distinguishable. */
  selectedShapeIds: Set<string>;
  /** Cell types expanded in the left tree (to show instances). */
  expandedTypes: string[];
  /** "Unmatched" folder open. */
  unmatchedOpen: boolean;
  /** "ML" folder open (empty placeholder for now). */
  mlOpen: boolean;
  /** Layer-list visibility folders (cell layers always open; inferred /
   *  die-viewer groups collapsible). */
  inferredOpen: boolean;
  dieViewerLayersOpen: boolean;
  /** Per-tab in the canvas.
   *   - `image`         — the user-annotated cell image (the editing tab).
   *   - `schematic`     — CMOS-level schematic (one domain at a time).
   *   - `logicSchematic`— logic-level abstraction (cell.logic as a tree
   *                       of standard gate symbols). Auto-selected for
   *                       combinational cells when `extraction.logic`
   *                       is set. */
  canvasTab: "image" | "schematic" | "logicSchematic";
  /** Which CmosDomain the schematic tab is currently rendering. Null = let
   *  the page auto-pick the first available domain. Stored here (not in the
   *  URL) because it's a transient pick — the cell's domain ids change on
   *  every annotation edit. */
  activeDomainId: string | null;
  /** Shape clipboard. Cross-cell paste is the explicit goal — keeping it in
   *  this transient store means it survives navigating between cell types in
   *  the same session. */
  clipboard: CellREClipboardItem[];
}

interface CellREActions {
  setActiveCellType: (typeId: string | null, cellId?: string | null) => void;
  setActiveCell: (cellId: string | null) => void;
  setActiveTool: (tool: ReToolKind) => void;
  setActiveLayer: (layer: LayerType) => void;
  setSelectedShapeIds: (ids: Set<string>) => void;
  selectOne: (id: string) => void;
  toggleSelected: (id: string) => void;
  clearSelection: () => void;
  toggleType: (id: string) => void;
  setUnmatchedOpen: (open: boolean) => void;
  setMlOpen: (open: boolean) => void;
  setInferredOpen: (open: boolean) => void;
  setDieViewerLayersOpen: (open: boolean) => void;
  setCanvasTab: (tab: "image" | "schematic" | "logicSchematic") => void;
  setActiveDomainId: (id: string | null) => void;
  setClipboard: (items: CellREClipboardItem[]) => void;
  reset: () => void;
}

/** Layer-id format used in the selection set, mirrored by the canvas hit-test. */
export function shapeKey(layer: LayerType, shapeId: string): string {
  return `${layer}:${shapeId}`;
}
export function parseShapeKey(key: string): { layer: LayerType; id: string } | null {
  const i = key.indexOf(":");
  if (i < 0) return null;
  return { layer: key.slice(0, i) as LayerType, id: key.slice(i + 1) };
}

const INITIAL: CellREState = {
  activeCellTypeId: null,
  activeCellId: null,
  activeTool: "select",
  activeLayer: "polysilicon",
  selectedShapeIds: new Set(),
  expandedTypes: [],
  unmatchedOpen: true,
  mlOpen: false,
  inferredOpen: true,
  dieViewerLayersOpen: true,
  canvasTab: "image",
  activeDomainId: null,
  clipboard: []
};

export const useCellREStore = create<CellREState & CellREActions>()((set, get) => ({
  ...INITIAL,

  setActiveCellType: (typeId, cellId = null) =>
    set({
      activeCellTypeId: typeId,
      activeCellId: cellId,
      // Picking a new type discards the lingering selection from the
      // previous type's layer shapes (those shape ids don't exist on the
      // new type, so a leftover selection would paint over nothing
      // meaningful), and resets the schematic's active domain (domain ids
      // change per cell). The page's hover entity is also cleared by an
      // effect keyed on `activeCellTypeId`.
      selectedShapeIds: new Set(),
      activeDomainId: null
    }),
  setActiveCell: (cellId) => set({ activeCellId: cellId }),
  setActiveTool: (tool) => {
    const prev = get().activeTool;
    if (prev === tool) return;
    // Changing tool clears the selection unless we're going to/from "pan"
    // (which is a transient cursor, often invoked momentarily via space).
    const clears = prev !== "pan" && tool !== "pan";
    set({
      activeTool: tool,
      ...(clears ? { selectedShapeIds: new Set() } : {})
    });
  },
  setActiveLayer: (layer) => set({ activeLayer: layer }),
  setSelectedShapeIds: (ids) => set({ selectedShapeIds: ids }),
  selectOne: (id) => set({ selectedShapeIds: new Set([id]) }),
  toggleSelected: (id) =>
    set((s) => {
      const next = new Set(s.selectedShapeIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedShapeIds: next };
    }),
  clearSelection: () => set({ selectedShapeIds: new Set() }),
  toggleType: (id) =>
    set((s) => ({
      expandedTypes: s.expandedTypes.includes(id)
        ? s.expandedTypes.filter((t) => t !== id)
        : [...s.expandedTypes, id]
    })),
  setUnmatchedOpen: (open) => set({ unmatchedOpen: open }),
  setMlOpen: (open) => set({ mlOpen: open }),
  setInferredOpen: (open) => set({ inferredOpen: open }),
  setDieViewerLayersOpen: (open) => set({ dieViewerLayersOpen: open }),
  setCanvasTab: (tab) => set({ canvasTab: tab }),
  setActiveDomainId: (id) => set({ activeDomainId: id }),
  setClipboard: (items) => set({ clipboard: items }),
  reset: () => {
    const { expandedTypes, unmatchedOpen, mlOpen } = get();
    set({ ...INITIAL, expandedTypes, unmatchedOpen, mlOpen });
  }
}));

/** Which LayerTypes are valid for each drawing tool. The point tool is
 *  restricted to via-style layers (the only kind that accepts a sole point);
 *  rect & polygon work on the 4 shape layers. Used by toolbar + tools to
 *  keep impossible combinations off the table. */
export const TOOL_LAYERS: Record<"rect" | "polygon" | "point", LayerType[]> = {
  rect: ["diffusion", "polysilicon", "metal1", "metal2"],
  polygon: ["diffusion", "polysilicon", "metal1", "metal2"],
  point: ["contact", "via1"]
};

/** Short labels that read cleanly on the toolbar chips. */
export const LAYER_LABEL: Record<LayerType, string> = {
  diffusion: "diff",
  polysilicon: "poly",
  metal1: "m1",
  metal2: "m2",
  contact: "contact",
  via1: "m1↔m2",
  wire_hitbox: "hitbox"
};

/** Long human-readable names for the layer-visibility list. */
export const LAYER_LONG: Record<LayerType, string> = {
  diffusion: "Diffusion",
  polysilicon: "Polysilicon",
  metal1: "Metal 1",
  metal2: "Metal 2",
  contact: "Contact via",
  via1: "M1 ↔ M2 via",
  wire_hitbox: "Wire hitbox"
};
