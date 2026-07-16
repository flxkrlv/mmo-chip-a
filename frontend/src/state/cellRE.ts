import { create } from "zustand";
import type { LayerShape, LayerType } from "shared";

export type ReToolKind = "select" | "pan" | "rect" | "polygon" | "point" | "polyline";

export interface CellREClipboardItem { layer: LayerType; shape: LayerShape; }

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
  clipboard: CellREClipboardItem[];
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
  setClipboard: (items: CellREClipboardItem[]) => void;
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
  canvasTab: "image", activeDomainId: null, clipboard: [],
  polylineDraft: [], polylineWidth: parseFloat(localStorage.getItem('cellRE_polylineWidth') ?? '') || 10,
};

export const useCellREStore = create<CellREState & CellREActions>()((set, get) => ({
  ...INITIAL,
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
  setClipboard: (items) => set({ clipboard: items }),
  addPolylinePoint: (pt) => set((s) => ({ polylineDraft: [...s.polylineDraft, pt] })),
  clearPolylineDraft: () => set({ polylineDraft: [] }),
  setPolylineWidth: (w) => { localStorage.setItem('cellRE_polylineWidth', String(w)); set({ polylineWidth: w }); },
  reset: () => { const { expandedTypes, unmatchedOpen, mlOpen } = get(); set({ ...INITIAL, expandedTypes, unmatchedOpen, mlOpen }); },
}));

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
