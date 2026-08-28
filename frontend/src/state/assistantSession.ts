import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AssistantAnalysisBrief, AssistantAnalysisMode, AssistantAnalysisResult } from "shared";

export interface AssistantSession {
  brief: AssistantAnalysisBrief;
  mode: AssistantAnalysisMode;
  /** The last read-only API response. `netlistPreview` is intentionally omitted to bound browser storage. */
  result: AssistantAnalysisResult | null;
  activeFindingId: string | null;
  updatedAt: number | null;
}

const EMPTY_SESSION: AssistantSession = {
  brief: {},
  mode: "functional_blocks",
  result: null,
  activeFindingId: null,
  updatedAt: null,
};

interface AssistantSessionState {
  byDieId: Record<string, AssistantSession>;
  setBrief: (dieId: string, brief: AssistantAnalysisBrief) => void;
  setMode: (dieId: string, mode: AssistantAnalysisMode) => void;
  setResult: (dieId: string, result: AssistantAnalysisResult | null) => void;
  setActiveFindingId: (dieId: string, findingId: string | null) => void;
  clearResult: (dieId: string) => void;
}

function sessionFor(state: AssistantSessionState, dieId: string): AssistantSession {
  return state.byDieId[dieId] ?? EMPTY_SESSION;
}

/**
 * Browser-only persistence for the assistant workspace. This is intentionally
 * separate from project annotations: results and prompts are a user's temporary
 * investigation context, not design facts shared with other collaborators.
 */
export const useAssistantSession = create<AssistantSessionState>()(
  persist(
    (set) => ({
      byDieId: {},
      setBrief: (dieId, brief) => set((state) => ({
        byDieId: { ...state.byDieId, [dieId]: { ...sessionFor(state, dieId), brief, updatedAt: Date.now() } },
      })),
      setMode: (dieId, mode) => set((state) => ({
        byDieId: { ...state.byDieId, [dieId]: { ...sessionFor(state, dieId), mode, updatedAt: Date.now() } },
      })),
      setResult: (dieId, result) => set((state) => ({
        byDieId: {
          ...state.byDieId,
          [dieId]: {
            ...sessionFor(state, dieId),
            // Full die netlist preview can be large and is not required for the
            // UI actions (fragments are generated from the current netlist page).
            result: result ? { ...result, netlistPreview: [] } : null,
            activeFindingId: result?.findings[0]?.id ?? null,
            updatedAt: Date.now(),
          },
        },
      })),
      setActiveFindingId: (dieId, activeFindingId) => set((state) => ({
        byDieId: { ...state.byDieId, [dieId]: { ...sessionFor(state, dieId), activeFindingId, updatedAt: Date.now() } },
      })),
      clearResult: (dieId) => set((state) => ({
        byDieId: { ...state.byDieId, [dieId]: { ...sessionFor(state, dieId), result: null, activeFindingId: null, updatedAt: Date.now() } },
      })),
    }),
    { name: "mmo-chip-assistant-sessions-v1" },
  ),
);
