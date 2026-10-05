/**
 * floorplan.ts — Zustand store for floorplan tool state.
 *
 * Tracks floorplan regions, the active drawing tool mode, and the
 * current draft (in-progress region being drawn on canvas).
 */

import { create } from "zustand";
import type { FloorplanRegion } from "shared";
import { useDieViewerStore } from "./dieViewer";

export type FloorplanToolMode = "idle" | "rect" | "poly";

export interface FloorplanDraft {
  kind: "rect" | "poly";
  points: { x: number; y: number }[];
  /** True while the user is still drawing (mousedown held or adding vertices). */
  active: boolean;
}

interface FloorplanState {
  /** All persisted floorplan regions for the current die. */
  regions: FloorplanRegion[];
  /** Currently selected region id (for popover). */
  selectedRegionId: string | null;
  /** Region showing geometry edit handles. Set whenever a region is
   *  selected, but outlives the popover (dragging a handle closes it). */
  editingRegionId: string | null;
  /** Active drawing sub-mode when the floorplan tool is selected. */
  toolMode: FloorplanToolMode;
  /** In-progress draft region (not yet saved). */
  draft: FloorplanDraft | null;
}

interface FloorplanActions {
  /** Replace the full region list (e.g. on load from annotations). */
  setRegions: (regions: FloorplanRegion[]) => void;
  /** Upsert (add or update) one region. */
  upsertRegion: (region: FloorplanRegion) => void;
  /** Remove a region by id. */
  removeRegion: (id: string) => void;
  /** Select a region for popover display (also starts geometry editing and
   *  selects `floorplan:<id>` in the die viewer, for the Inspector). */
  selectRegion: (id: string | null) => void;
  /** Start / stop showing geometry edit handles on a region. */
  setEditingRegion: (id: string | null) => void;
  /** Set the drawing sub-mode. */
  setToolMode: (mode: FloorplanToolMode) => void;
  /** Start or update a draft region. */
  setDraft: (draft: FloorplanDraft | null) => void;
  /** Reset all floorplan state (e.g. on die navigation). */
  reset: () => void;
}

const INITIAL: FloorplanState = {
  regions: [],
  selectedRegionId: null,
  editingRegionId: null,
  toolMode: "rect",
  draft: null,
};

export const useFloorplanStore = create<FloorplanState & FloorplanActions>()((set, get) => ({
  ...INITIAL,

  setRegions: (regions) => set({ regions }),
  upsertRegion: (region) => {
    const current = get().regions;
    const idx = current.findIndex((r) => r.id === region.id);
    if (idx >= 0) {
      const next = [...current];
      next[idx] = region;
      set({ regions: next });
    } else {
      set({ regions: [...current, region] });
    }
  },
  removeRegion: (id) =>
    set((state) => ({
      regions: state.regions.filter((r) => r.id !== id),
      selectedRegionId: state.selectedRegionId === id ? null : state.selectedRegionId,
      editingRegionId: state.editingRegionId === id ? null : state.editingRegionId,
    })),
  selectRegion: (id) => {
    if (id === null) {
      set({ selectedRegionId: null });
      return;
    }
    set({ selectedRegionId: id, editingRegionId: id });
    // Mirror into the die-viewer selection (same id as the Outline row) so
    // the Inspector shows the region.
    useDieViewerStore.getState().select([`floorplan:${id}`]);
  },
  setEditingRegion: (id) => set({ editingRegionId: id }),
  setToolMode: (mode) => set({ toolMode: mode }),
  setDraft: (draft) => set({ draft }),
  reset: () => set(INITIAL),
}));
