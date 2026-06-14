/**
 * crossTabSelection.ts — Shared cross-tab selection state.
 *
 * Allows one phase page to set a selection that another phase page reads
 * when it mounts. Examples:
 *   - AnalogNetlistPage clicks an instance → DieViewerPage frames that cell
 *   - DieViewerPage double-click cell → RECellPage opens that cell
 *
 * Each entry is consumed once on mount (the reader clears it after use).
 * Use a version counter so the reader can distinguish "no selection"
 * from "already consumed this selection".
 */

import { create } from "zustand";

interface FocusState {
  /** Cell instance ID to frame on the die viewer. */
  focusedCellId: string | null;
  /** Analog device instance name (e.g. "M1") for highlighting. */
  focusedAnalogDeviceId: string | null;
  /** Version bump every time a new focus is set. */
  version: number;
}

interface CrossTabActions {
  /** Set the analog device focus. Clears after die viewer consumes it. */
  setAnalogFocus: (deviceName: string, cellId: string) => void;
  /** Clear after consumption. */
  clearAnalogFocus: () => void;
  /** Read and consume (atomically). Returns the state if version > 0. */
  consumeAnalogFocus: () => { deviceName: string; cellId: string } | null;
}

export const useCrossTabSelection = create<FocusState & CrossTabActions>()(
  (set, get) => ({
    focusedCellId: null,
    focusedAnalogDeviceId: null,
    version: 0,

    setAnalogFocus: (deviceName, cellId) =>
      set({
        focusedCellId: cellId,
        focusedAnalogDeviceId: deviceName,
        version: get().version + 1,
      }),

    clearAnalogFocus: () =>
      set({
        focusedCellId: null,
        focusedAnalogDeviceId: null,
        version: 0,
      }),

    consumeAnalogFocus: () => {
      const s = get();
      if (s.version === 0) return null;
      const result = { deviceName: s.focusedAnalogDeviceId!, cellId: s.focusedCellId! };
      set({
        focusedCellId: null,
        focusedAnalogDeviceId: null,
        version: 0,
      });
      return result;
    },
  }),
);
