import { create } from "zustand";
import type { LayerShape, LayerType } from "shared";

export type ReToolKind = "select" | "pan" | "rect" | "polygon" | "point" | "polyline";

export interface CellREClipboardItem { layer: LayerType; shape: LayerShape; }

/** What ⌘C put on the shape clipboard. */
export interface CellREClipboard {
  /** Where the shapes were copied from: a paste back into that cell type is
   *  offset so the copies don't hide the originals; anywhere else they land
   *  in place. */
  dieId: string;
  cellTypeId: string;
  items: CellREClipboardItem[];
}

// ── Shared clipboard ──────────────────────────────────────────────────
//
// The shape clipboard lives in localStorage, so every tab of the app (same
// origin) shares it: copy in one tab, paste in another. The `storage` event
// (bottom of this file) keeps each tab's store in step; a tab that can't
// reach storage (blocked, full) still copies and pastes within itself.

const CLIPBOARD_KEY = "mmo-chip-shape-clipboard";
const CLIPBOARD_VERSION = 1;

/** Every layer a clipboard item may name — a Record, so a new LayerType
 *  doesn't compile until it's listed here. */
const CLIPBOARD_LAYERS: Record<LayerType, true> = {
  diffusion: true,
  polysilicon: true,
  metal1: true,
  metal2: true,
  metal3: true,
  metal4: true,
  metal5: true,
  metal6: true,
  contact: true,
  via1: true,
  via2: true,
  via3: true,
  via4: true,
  via5: true,
  wire_hitbox: true,
  nwell: true,
  pwell: true,
  deep_nwell: true,
  buried_layer: true,
  base: true,
  emitter: true,
  collector_sinker: true,
  jfet_gate: true,
  jfet_channel: true,
  resistor_body: true,
  capacitor_bottom: true,
  capacitor_top: true,
  device_box: true,
  hsr: true,
  film: true,
  npn_id: true,
  pnp_id: true,
  lpnp_id: true,
  vpnp: true,
  res_id: true,
  cap_id: true,
  diode_id: true,
  collector: true,
  bulk: true
};

export function serializeClipboard(clipboard: CellREClipboard): string {
  return JSON.stringify({ version: CLIPBOARD_VERSION, ...clipboard });
}

/** Decode a stored clipboard. It may come from another tab running another
 *  build, so anything from a different version, malformed or empty is
 *  null. */
export function parseClipboard(raw: string | null): CellREClipboard | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { version, dieId, cellTypeId, items } = value as Record<string, unknown>;
  if (
    version !== CLIPBOARD_VERSION ||
    typeof dieId !== "string" ||
    typeof cellTypeId !== "string" ||
    !Array.isArray(items) ||
    items.length === 0 ||
    !items.every(isClipboardItem)
  ) {
    return null;
  }
  return { dieId, cellTypeId, items };
}

function isClipboardItem(value: unknown): value is CellREClipboardItem {
  if (!value || typeof value !== "object") return false;
  const { layer, shape } = value as { layer?: unknown; shape?: unknown };
  if (typeof layer !== "string" || !Object.hasOwn(CLIPBOARD_LAYERS, layer)) return false;
  if (!shape || typeof shape !== "object") return false;
  const s = shape as Record<string, unknown>;
  if (typeof s.id !== "string") return false;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  switch (s.kind) {
    case "rect":
      return num(s.x) && num(s.y) && num(s.width) && num(s.height);
    case "point":
      return num(s.x) && num(s.y) && num(s.size);
    case "circle":
      return num(s.x) && num(s.y) && num(s.radius);
    case "line":
      return num(s.x1) && num(s.y1) && num(s.x2) && num(s.y2) && num(s.width);
    case "polygon":
      return (
        Array.isArray(s.points) &&
        s.points.every((p: unknown) => {
          const q = p as { x?: unknown; y?: unknown } | null;
          return !!q && typeof q === "object" && num(q.x) && num(q.y);
        })
      );
    default:
      return false;
  }
}

function readSharedClipboard(): CellREClipboard | null {
  try {
    if (typeof window === "undefined") return null;
    return parseClipboard(window.localStorage.getItem(CLIPBOARD_KEY));
  } catch {
    return null;
  }
}

function writeSharedClipboard(clipboard: CellREClipboard | null): void {
  try {
    if (typeof window === "undefined") return;
    if (clipboard) window.localStorage.setItem(CLIPBOARD_KEY, serializeClipboard(clipboard));
    else window.localStorage.removeItem(CLIPBOARD_KEY);
  } catch {
    // Storage blocked or full: the copy still works within this tab.
  }
}


interface CellREState {
  activeCellTypeId: string | null;
  activeCellId: string | null;
  activeTool: ReToolKind;
  activeLayer: LayerType;
  selectedShapeIds: Set<string>;
  expandedTypes: string[];
  unmatchedOpen: boolean;
  mlOpen: boolean;
  inferredOpen: boolean;
  dieViewerLayersOpen: boolean;
  canvasTab: "image" | "schematic" | "logicSchematic" | "analogSchematic";
  activeDomainId: string | null;
  /** Shape clipboard, shared by every tab of the app (see "Shared
   *  clipboard" above): shapes paste across tabs, dies and cell types. */
  clipboard: CellREClipboard | null;
  polylineDraft: Array<{x:number;y:number}>;
  polylineWidth: number;
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
  setCanvasTab: (tab: "image" | "schematic" | "logicSchematic" | "analogSchematic") => void;
  setActiveDomainId: (id: string | null) => void;
  setClipboard: (clipboard: CellREClipboard | null) => void;
  addPolylinePoint: (pt: {x:number;y:number}) => void;
  clearPolylineDraft: () => void;
  setPolylineWidth: (w: number) => void;
  reset: () => void;
}

export function shapeKey(layer: LayerType, shapeId: string): string { return `${layer}:${shapeId}`; }
export function parseShapeKey(key: string): { layer: LayerType; id: string } | null {
  const i = key.indexOf(":"); if (i < 0) return null;
  return { layer: key.slice(0, i) as LayerType, id: key.slice(i + 1) };
}

const INITIAL: CellREState = {
  activeCellTypeId: null, activeCellId: null,
  activeTool: "select", activeLayer: "polysilicon",
  selectedShapeIds: new Set(), expandedTypes: [],
  unmatchedOpen: true, mlOpen: false, inferredOpen: true, dieViewerLayersOpen: true,
  canvasTab: "image", activeDomainId: null, clipboard: null,
  polylineDraft: [], polylineWidth: parseFloat(localStorage.getItem('cellRE_polylineWidth') ?? '') || 10,
};

export const useCellREStore = create<CellREState & CellREActions>()((set, get) => ({
  ...INITIAL,
  clipboard: readSharedClipboard(),
  setActiveCellType: (typeId, cellId = null) =>
    set({ activeCellTypeId: typeId, activeCellId: cellId, selectedShapeIds: new Set(), activeDomainId: null }),
  setActiveCell: (cellId) => set({ activeCellId: cellId }),
  setActiveTool: (tool) => {
    const prev = get().activeTool; if (prev === tool) return;
    const clears = prev !== "pan" && tool !== "pan";
    set({ activeTool: tool, ...(clears ? { selectedShapeIds: new Set(), polylineDraft: [] } : {}) });
  },
  setActiveLayer: (layer) => set({ activeLayer: layer }),
  setSelectedShapeIds: (ids) => set({ selectedShapeIds: ids }),
  selectOne: (id) => set({ selectedShapeIds: new Set([id]) }),
  toggleSelected: (id) => set((s) => { const n = new Set(s.selectedShapeIds); n.has(id) ? n.delete(id) : n.add(id); return { selectedShapeIds: n }; }),
  clearSelection: () => set({ selectedShapeIds: new Set() }),
  toggleType: (id) => set((s) => ({ expandedTypes: s.expandedTypes.includes(id) ? s.expandedTypes.filter(t=>t!==id) : [...s.expandedTypes, id] })),
  setUnmatchedOpen: (open) => set({ unmatchedOpen: open }),
  setMlOpen: (open) => set({ mlOpen: open }),
  setInferredOpen: (open) => set({ inferredOpen: open }),
  setDieViewerLayersOpen: (open) => set({ dieViewerLayersOpen: open }),
  setCanvasTab: (tab) => set({ canvasTab: tab }),
  setActiveDomainId: (id) => set({ activeDomainId: id }),
  setClipboard: (clipboard) => {
    writeSharedClipboard(clipboard);
    set({ clipboard });
  },
  addPolylinePoint: (pt) => set((s) => ({ polylineDraft: [...s.polylineDraft, pt] })),
  clearPolylineDraft: () => set({ polylineDraft: [] }),
  setPolylineWidth: (w) => { localStorage.setItem('cellRE_polylineWidth', String(w)); set({ polylineWidth: w }); },
  reset: () => {
    // The clipboard is shared with the other tabs — not this page's to drop.
    const { expandedTypes, unmatchedOpen, mlOpen, clipboard } = get();
    set({ ...INITIAL, expandedTypes, unmatchedOpen, mlOpen, clipboard });
  },
}));

// Another tab copied (or storage was cleared): pick up its clipboard. The
// event only fires in the *other* tabs, never the one that wrote.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== CLIPBOARD_KEY) return;
    useCellREStore.setState({ clipboard: parseClipboard(e.newValue) });
  });
}

export const TOOL_LAYERS: Record<"rect" | "polygon" | "point" | "polyline", LayerType[]> = {
  rect: ["diffusion","polysilicon","metal1","metal2","nwell","pwell","base","emitter","resistor_body","hsr","film","capacitor_bottom","capacitor_top","metal3","metal4","metal5","metal6","npn_id","pnp_id","lpnp_id","vpnp","res_id","cap_id","diode_id","collector","bulk","wire_hitbox"],
  polygon: ["diffusion","polysilicon","metal1","metal2","nwell","pwell","base","emitter","resistor_body","hsr","film","capacitor_bottom","capacitor_top","metal3","metal4","metal5","metal6","npn_id","pnp_id","lpnp_id","vpnp","res_id","cap_id","diode_id","collector","bulk","wire_hitbox"],
  point: ["contact","via1","via2","via3","via4","via5"],
  polyline: ["resistor_body","polysilicon","base","emitter","hsr","film"],
};

export const LAYER_LABEL: Record<LayerType, string> = {
  diffusion:"diff",polysilicon:"poly",metal1:"m1",metal2:"m2",contact:"contact",via1:"m1↔m2",via2:"m2↔m3",via3:"m3↔m4",via4:"m4↔m5",via5:"m5↔m6",wire_hitbox:"hitbox",
  nwell:"nwell",pwell:"pwell",deep_nwell:"dnwell",buried_layer:"buried",base:"base",emitter:"emit",collector_sinker:"csink",
  jfet_gate:"jgate",jfet_channel:"jchan",resistor_body:"R",hsr:"HSR",film:"Film",capacitor_bottom:"capB",capacitor_top:"capT",
  metal3:"m3",metal4:"m4",metal5:"m5",metal6:"m6",device_box:"dbox",
  npn_id:"NPN",pnp_id:"PNP",lpnp_id:"LPNP",vpnp:"VPNP",res_id:"RES",cap_id:"CAP",diode_id:"DIO",collector:"COLL",
  bulk:"B",
};

export const LAYER_LONG: Record<LayerType, string> = {
  diffusion:"Diffusion",polysilicon:"Polysilicon",metal1:"Metal 1",metal2:"Metal 2",contact:"Contact via",via1:"M1 ↔ M2 via",via2:"M2 ↔ M3 via",via3:"M3 ↔ M4 via",via4:"M4 ↔ M5 via",via5:"M5 ↔ M6 via",wire_hitbox:"Wire hitbox",
  nwell:"N-Well",pwell:"P-Well",deep_nwell:"Deep N-Well",buried_layer:"Buried Layer",base:"Base",emitter:"Emitter",collector_sinker:"Collector Sinker",
  jfet_gate:"JFET Gate",jfet_channel:"JFET Channel",resistor_body:"Resistor Body",hsr:"High-Sheet-R",film:"Thin Film",capacitor_bottom:"Capacitor Bottom",capacitor_top:"Capacitor Top",
  metal3:"Metal 3",metal4:"Metal 4",metal5:"Metal 5",metal6:"Metal 6",device_box:"Device Box",
  npn_id:"NPN Marker",pnp_id:"PNP Marker",lpnp_id:"LPNP Marker",vpnp:"VPNP (vertical, WIP)",res_id:"Resistor Marker",cap_id:"Capacitor Marker",diode_id:"Diode Marker",collector:"Collector",
  bulk:"Bulk",
};
