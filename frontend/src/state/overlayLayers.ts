import { create } from "zustand";
import { uuid } from "../lib/uuid";
import { usePreferences } from "./preferences";
import type { OverlayLayerPersistedSettings } from "./preferences";

// ── Types ───────────────────────────────────────────────────────────

export interface OverlayLayerEntry {
  /** Unique id (uuid). */
  id: string;
  /** Human-readable name editable in the UI. */
  name: string;
  /** Original filename on the server (with extension). Used when
   *  referencing the file in backend API calls (e.g. template matching). */
  serverFilename?: string;
  /** Object URL or backend URL for the image resource. */
  src: string;
  /** The loaded HTMLImageElement (null until loaded). */
  image: HTMLImageElement | null;
  /** Whether the image has finished loading. */
  loaded: boolean;
  /** When true, the layer is hidden (not painted at all). */
  hidden: boolean;
  /** Opacity 0..1. 1 = fully opaque. */
  opacity: number;
  /** World-coordinate offset (source-image pixels). For aligned crops
   *  this should be (0, 0). */
  offsetX: number;
  offsetY: number;
}

// ── State ───────────────────────────────────────────────────────────

interface OverlayLayersState {
  /** Ordered list of overlay layers. Last entry paints on top. */
  layers: OverlayLayerEntry[];
  /** When true (default), the base die image / cell crop is drawn.
   *  Toggled by Ctrl+Shift+B. */
  baseImageVisible: boolean;

  /** Add a new layer from a loaded HTMLImageElement. Returns the layer id. */
  addLayer: (name: string, image: HTMLImageElement, hidden?: boolean, serverFilename?: string) => string;
  /** Remove a layer by id. */
  removeLayer: (id: string) => void;
  /** Toggle visibility of a layer. */
  setLayerHidden: (id: string, hidden: boolean) => void;
  /** Set opacity 0..1. */
  setLayerOpacity: (id: string, opacity: number) => void;
  /** Rename a layer. */
  renameLayer: (id: string, name: string) => void;
  /** Move a layer in the z-order. From index → to index. */
  moveLayer: (fromIndex: number, toIndex: number) => void;
  /** Set image offset (world px). */
  setLayerOffset: (id: string, offsetX: number, offsetY: number) => void;
  /** Clear all layers. */
  clearLayers: () => void;
  /** Toggle base image visibility (Ctrl+Shift+B). */
  toggleBaseImage: () => void;
}

// ── Store ───────────────────────────────────────────────────────────

export const useOverlayLayers = create<OverlayLayersState>()((set, get) => ({
  layers: [],
  baseImageVisible: true,

  addLayer: (name, image, hidden = false, serverFilename) => {
    const id = uuid();
    const entry: OverlayLayerEntry = {
      id,
      name,
      serverFilename,
      src: image.src,
      image,
      loaded: true,
      hidden,
      opacity: 1,
      offsetX: 0,
      offsetY: 0
    };
    set((s) => ({ layers: [...s.layers, entry] }));
    return id;
  },

  removeLayer: (id) => {
    const entry = get().layers.find((l) => l.id === id);
    // Revoke blob URLs when the layer is removed.
    if (entry && entry.src.startsWith("blob:")) {
      URL.revokeObjectURL(entry.src);
    }
    set((s) => ({ layers: s.layers.filter((l) => l.id !== id) }));
  },

  setLayerHidden: (id, hidden) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, hidden } : l))
    })),

  setLayerOpacity: (id, opacity) =>
    set((s) => ({
      layers: s.layers.map((l) =>
        l.id === id ? { ...l, opacity: Math.min(1, Math.max(0, opacity)) } : l
      )
    })),

  renameLayer: (id, name) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, name } : l))
    })),

  moveLayer: (fromIndex, toIndex) =>
    set((s) => {
      const arr = [...s.layers];
      if (
        fromIndex < 0 ||
        fromIndex >= arr.length ||
        toIndex < 0 ||
        toIndex >= arr.length
      )
        return s;
      const [item] = arr.splice(fromIndex, 1);
      arr.splice(toIndex, 0, item);
      return { layers: arr };
    }),

  setLayerOffset: (id, offsetX, offsetY) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, offsetX, offsetY } : l))
    })),

  clearLayers: () => {
    // Revoke all blob URLs.
    for (const l of get().layers) {
      if (l.src.startsWith("blob:")) URL.revokeObjectURL(l.src);
    }
    set({ layers: [] });
  },

  toggleBaseImage: () => set((s) => ({ baseImageVisible: !s.baseImageVisible }))
}));

// ── Persistence helpers ─────────────────────────────────────────────

/** Save current overlay layer settings to preferences (localStorage). */
export function saveOverlaySettingsToPrefs(dieId: string): void {
  const layers = useOverlayLayers.getState().layers;
  const settings: Record<string, OverlayLayerPersistedSettings> = {};
  for (const l of layers) {
    if (!l.serverFilename) continue;
    settings[l.serverFilename] = {
      hidden: l.hidden,
      opacity: l.opacity,
      offsetX: l.offsetX,
      offsetY: l.offsetY,
    };
  }
  usePreferences.getState().saveOverlayLayerSettings(dieId, settings);
}

/** Apply persisted overlay settings to the currently loaded layers. */
export function applyOverlaySettingsFromPrefs(dieId: string): void {
  const saved = usePreferences.getState().overlayLayerSettings[dieId];
  if (!saved) return;
  const state = useOverlayLayers.getState();
  for (const layer of state.layers) {
    const s = layer.serverFilename ? saved[layer.serverFilename] : undefined;
    if (!s) continue;
    if (s.hidden !== layer.hidden) state.setLayerHidden(layer.id, s.hidden);
    if (s.opacity !== layer.opacity) state.setLayerOpacity(layer.id, s.opacity);
    if (s.offsetX !== layer.offsetX || s.offsetY !== layer.offsetY)
      state.setLayerOffset(layer.id, s.offsetX, s.offsetY);
  }
}
