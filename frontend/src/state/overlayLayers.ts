import { create } from "zustand";
import { uuid } from "../lib/uuid";
import type { OverlayImageSource } from "../api/overlayImages";
import { usePreferences } from "./preferences";
import type { OverlayLayerPersistedSettings } from "./preferences";

export interface OverlayLayerEntry {
  id: string;
  name: string;
  /** Stable source id for tiled images; filename for legacy images. */
  serverFilename?: string;
  src: string;
  image: HTMLImageElement | null;
  source: OverlayImageSource | null;
  loaded: boolean;
  hidden: boolean;
  opacity: number;
  offsetX: number;
  offsetY: number;
}

interface OverlayLayersState {
  layers: OverlayLayerEntry[];
  baseImageVisible: boolean;
  addLayer: (name: string, image: HTMLImageElement, hidden?: boolean, serverFilename?: string) => string;
  addTiledLayer: (source: OverlayImageSource, hidden?: boolean) => string;
  removeLayer: (id: string) => void;
  setLayerHidden: (id: string, hidden: boolean) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  renameLayer: (id: string, name: string) => void;
  moveLayer: (fromIndex: number, toIndex: number) => void;
  setLayerOffset: (id: string, offsetX: number, offsetY: number) => void;
  toggleBaseImage: () => void;
  clearLayers: () => void;
}

export const useOverlayLayers = create<OverlayLayersState>()((set, get) => ({
  layers: [],
  baseImageVisible: true,
  addLayer: (name, image, hidden = false, serverFilename) => {
    const id = uuid();
    set((state) => ({ layers: [...state.layers, {
      id, name, serverFilename, src: image.src, image, source: null, loaded: true,
      hidden, opacity: 1, offsetX: 0, offsetY: 0
    }] }));
    return id;
  },
  addTiledLayer: (source, hidden = false) => {
    const existing = get().layers.find((layer) => layer.source?.id === source.id);
    if (existing) return existing.id;
    const id = uuid();
    set((state) => ({ layers: [...state.layers, {
      id, name: source.name, serverFilename: source.id, src: "", image: null, source,
      loaded: source.ready, hidden, opacity: 1, offsetX: 0, offsetY: 0
    }] }));
    return id;
  },
  removeLayer: (id) => {
    const entry = get().layers.find((layer) => layer.id === id);
    if (entry?.src.startsWith("blob:")) URL.revokeObjectURL(entry.src);
    set((state) => ({ layers: state.layers.filter((layer) => layer.id !== id) }));
  },
  setLayerHidden: (id, hidden) => set((state) => ({ layers: state.layers.map((layer) => layer.id === id ? { ...layer, hidden } : layer) })),
  setLayerOpacity: (id, opacity) => set((state) => ({ layers: state.layers.map((layer) => layer.id === id ? { ...layer, opacity: Math.min(1, Math.max(0, opacity)) } : layer) })),
  renameLayer: (id, name) => set((state) => ({ layers: state.layers.map((layer) => layer.id === id ? { ...layer, name } : layer) })),
  moveLayer: (fromIndex, toIndex) => set((state) => {
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= state.layers.length || toIndex >= state.layers.length) return state;
    const layers = [...state.layers];
    const [entry] = layers.splice(fromIndex, 1);
    layers.splice(toIndex, 0, entry);
    return { layers };
  }),
  setLayerOffset: (id, offsetX, offsetY) => set((state) => ({ layers: state.layers.map((layer) => layer.id === id ? { ...layer, offsetX, offsetY } : layer) })),
  toggleBaseImage: () => set((state) => ({ baseImageVisible: !state.baseImageVisible })),
  clearLayers: () => {
    for (const entry of get().layers) if (entry.src.startsWith("blob:")) URL.revokeObjectURL(entry.src);
    set({ layers: [] });
  }
}));

/** The last array item paints on top, therefore search from the end. */
export function topVisibleOverlaySourceId(): string | undefined {
  const layers = useOverlayLayers.getState().layers;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (!layer.hidden && layer.opacity > 0 && layer.loaded && layer.serverFilename) return layer.serverFilename;
  }
  return undefined;
}

export function saveOverlaySettingsToPrefs(dieId: string): void {
  const settings: Record<string, OverlayLayerPersistedSettings> = {};
  for (const layer of useOverlayLayers.getState().layers) {
    if (!layer.serverFilename) continue;
    settings[layer.serverFilename] = { hidden: layer.hidden, opacity: layer.opacity, offsetX: layer.offsetX, offsetY: layer.offsetY };
  }
  usePreferences.getState().saveOverlayLayerSettings(dieId, settings);
}

export function applyOverlaySettingsFromPrefs(dieId: string): void {
  const saved = usePreferences.getState().overlayLayerSettings[dieId];
  if (!saved) return;
  const state = useOverlayLayers.getState();
  for (const layer of state.layers) {
    const settings = layer.serverFilename ? saved[layer.serverFilename] : undefined;
    if (!settings) continue;
    state.setLayerHidden(layer.id, settings.hidden);
    state.setLayerOpacity(layer.id, settings.opacity);
    state.setLayerOffset(layer.id, settings.offsetX, settings.offsetY);
  }
}