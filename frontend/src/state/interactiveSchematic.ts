/**
 * interactiveSchematic.ts — Zustand store for the interactive analog
 * schematic: user positions and locks, slot-isolated per scope.
 *
 * Scope slots keep layouts of different datasets apart: `full` die view,
 * per-region views and assistant fragments each get their own key, so a
 * layout built for one never corrupts another.
 *
 * Drag writes go through a transient `draft` (NOT persisted) and commit
 * into `layouts` on drag end — localStorage is written once per gesture,
 * not on every mousemove. ELK re-layout results land in `layouts`
 * directly, skipping locked devices (locked = outside ELK's reach —
 * verified: elkjs 0.11.1 cannot fix individual node positions).
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

// ── Types ────────────────────────────────────────────────────────

export interface DevicePos {
  x: number;
  y: number;
}

/** Device orientation — manual per-device rotation/mirror (v1 only
 *  manual; ELK-proposed orientations deferred to future features). */
export interface DeviceOrientation {
  /** Clockwise rotation in degrees. */
  rot: 0 | 90 | 180 | 270;
  /** Mirror along an axis after rotation. */
  flip: "none" | "h" | "v";
}

export interface ScopeLayout {
  positions: Record<string, DevicePos>;
  locked: Record<string, boolean>;
  orientation: Record<string, DeviceOrientation>;
}

interface InteractiveSchematicState {
  /** Persisted layouts keyed by scope slot. */
  layouts: Record<string, ScopeLayout>;
  /** In-progress drag positions (transient — never persisted). */
  draft: { scopeKey: string; positions: Record<string, DevicePos> } | null;
}

interface InteractiveSchematicActions {
  /** Called on device pointerdown — opens a drag session for the scope. */
  dragBegin: (scopeKey: string) => void;
  /** Called on pointermove — updates the transient draft only. */
  dragMove: (deviceKey: string, pos: DevicePos) => void;
  /** Called on pointerup/cancel — commits the draft into the persisted
   *  layout (single localStorage write per gesture). */
  dragEnd: () => void;
  /** Lock/unlock a device. Locked devices survive re-layout. */
  setLocked: (scopeKey: string, deviceKey: string, locked: boolean) => void;
  /** Merge ELK (or grid fallback) positions into the scope, skipping
   *  locked devices. */
  applyPositions: (scopeKey: string, positions: Record<string, DevicePos>) => void;
  /** Rotate/flip a device (applied to its orientation slot). The change
   *  is additive — devices default to rot 0 / flip none. */
  setOrientation: (scopeKey: string, deviceKey: string, orient: DeviceOrientation) => void;
  /** Clear the scope's positions, locks and orientations. */
  resetScope: (scopeKey: string) => void;
  /** Drop entries for devices no longer present in the dataset (renames,
   *  re-extraction). Call when the device set changes. */
  pruneScope: (scopeKey: string, validKeys: readonly string[]) => void;
}

// ── Helpers ──────────────────────────────────────────────────────

const emptyLayout = (): ScopeLayout => ({ positions: {}, locked: {}, orientation: {} });

function layoutOf(state: InteractiveSchematicState, scopeKey: string): ScopeLayout {
  return state.layouts[scopeKey] ?? emptyLayout();
}

/** Effective positions for rendering: draft overrides during a drag. */
export function effectivePositions(
  state: InteractiveSchematicState,
  scopeKey: string,
): Record<string, DevicePos> {
  if (state.draft && state.draft.scopeKey === scopeKey) {
    return { ...layoutOf(state, scopeKey).positions, ...state.draft.positions };
  }
  return layoutOf(state, scopeKey).positions;
}

/** Compose a scope slot key. `scopePart` is "full", "region:<id>" or
 *  "fragment:<hash>"; die/module pin the dataset identity. */
export function scopeKey(dieId: string | null, moduleName: string, scopePart: string): string {
  return `${dieId ?? "nodie"}:${moduleName}:${scopePart}`;
}

// ── Store ────────────────────────────────────────────────────────

export const useInteractiveSchematic = create<
  InteractiveSchematicState & InteractiveSchematicActions
>()(
  persist(
    (set, get) => ({
      layouts: {},
      draft: null,

      dragBegin: (scopeKey) => set({ draft: { scopeKey, positions: {} } }),

      dragMove: (deviceKey, pos) => {
        const { draft } = get();
        if (!draft) return;
        set({ draft: { ...draft, positions: { ...draft.positions, [deviceKey]: pos } } });
      },

      dragEnd: () => {
        const { draft, layouts } = get();
        if (!draft) return;
        const prev = layouts[draft.scopeKey] ?? emptyLayout();
        set({
          layouts: {
            ...layouts,
            [draft.scopeKey]: {
              positions: { ...prev.positions, ...draft.positions },
              locked: prev.locked,
              orientation: prev.orientation,
            },
          },
          draft: null,
        });
      },

      setLocked: (scopeKey, deviceKey, locked) =>
        set((state) => {
          const prev = layoutOf(state, scopeKey);
          return {
            layouts: {
              ...state.layouts,
              [scopeKey]: {
                positions: prev.positions,
                locked: { ...prev.locked, [deviceKey]: locked },
                orientation: prev.orientation,
              },
            },
          };
        }),

      setOrientation: (scopeKey, deviceKey, orient) =>
        set((state) => {
          const prev = layoutOf(state, scopeKey);
          return {
            layouts: {
              ...state.layouts,
              [scopeKey]: {
                positions: prev.positions,
                locked: prev.locked,
                orientation: { ...prev.orientation, [deviceKey]: orient },
              },
            },
          };
        }),

      applyPositions: (scopeKey, positions) =>
        set((state) => {
          const prev = layoutOf(state, scopeKey);
          const merged: Record<string, DevicePos> = { ...prev.positions };
          for (const [key, pos] of Object.entries(positions)) {
            if (prev.locked[key]) continue; // locked = outside ELK's reach
            merged[key] = pos;
          }
          return {
            layouts: { ...state.layouts, [scopeKey]: { positions: merged, locked: prev.locked, orientation: prev.orientation } },
          };
        }),

      resetScope: (scopeKey) =>
        set((state) => ({ layouts: { ...state.layouts, [scopeKey]: emptyLayout() } })),

      pruneScope: (scopeKey, validKeys) =>
        set((state) => {
          const prev = layoutOf(state, scopeKey);
          const valid = new Set(validKeys);
          const positions: Record<string, DevicePos> = {};
          let changed = false;
          for (const [key, pos] of Object.entries(prev.positions)) {
            if (valid.has(key)) positions[key] = pos;
            else changed = true;
          }
          const locked: Record<string, boolean> = {};
          for (const [key, v] of Object.entries(prev.locked)) {
            if (valid.has(key)) locked[key] = v;
            else changed = true;
          }
          const orientation: Record<string, DeviceOrientation> = {};
          for (const [key, v] of Object.entries(prev.orientation)) {
            if (valid.has(key)) orientation[key] = v;
            else changed = true;
          }
          if (!changed) return state;
          return { layouts: { ...state.layouts, [scopeKey]: { positions, locked, orientation } } };
        }),
    }),
    {
      name: "mmo-chip-interactive-schematic",
      version: 2,
      // Draft is transient — persist layouts only.
      partialize: (state) => ({ layouts: state.layouts }),
      // v1 layouts lack `orientation` — backfill to empty per scope.
      migrate: (persisted: unknown) => {
        const state = persisted as { layouts?: Record<string, ScopeLayout> };
        const layouts: Record<string, ScopeLayout> = {};
        for (const [key, l] of Object.entries(state.layouts ?? {})) {
          layouts[key] = {
            positions: l.positions ?? {},
            locked: l.locked ?? {},
            orientation: l.orientation ?? {},
          };
        }
        return { layouts };
      },
    },
  ),
);

/** Convenience read: locked flags for a scope. */
export function lockedMap(state: InteractiveSchematicState, scopeKey: string): Record<string, boolean> {
  return layoutOf(state, scopeKey).locked;
}

/** Convenience read: device orientations for a scope (defaults to none —
 *  every device is rot 0 / flip none unless explicitly rotated). */
export function orientationMap(state: InteractiveSchematicState, scopeKey: string): Record<string, DeviceOrientation> {
  return layoutOf(state, scopeKey).orientation;
}
