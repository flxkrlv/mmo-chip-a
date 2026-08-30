import { create } from "zustand";
import { persist, type StorageValue } from "zustand/middleware";
import type { AssistantAnalysisBrief, AssistantAnalysisMode, AssistantAnalysisResult, AssistantChatMessage } from "shared";

/**
 * Strip large base64 images from toolUse messages to stay within localStorage
 * quota.  Images are ephemeral display data — the vision card shows them while
 * the thread is open but they don't need to survive a page reload.
 */
function stripToolImages(state: AssistantSessionState): AssistantSessionState {
  const stripped: AssistantSessionState = { ...state, byDieId: {} };
  for (const [dieId, session] of Object.entries(state.byDieId)) {
    const threads: Record<string, AssistantChatMessage[]> = {};
    let changed = false;
    for (const [fid, msgs] of Object.entries(session.findingThreads)) {
      const clean = msgs.map((m) => {
        if (!m.toolUse?.images?.length) return m;
        changed = true;
        return { ...m, toolUse: { ...m.toolUse, images: [] } };
      });
      threads[fid] = clean;
    }
    stripped.byDieId[dieId] = changed ? { ...session, findingThreads: threads } : session;
  }
  return stripped;
}

export interface AssistantSession {
  brief: AssistantAnalysisBrief;
  mode: AssistantAnalysisMode;
  /** The last read-only API response. `netlistPreview` is intentionally omitted to bound browser storage. */
  result: AssistantAnalysisResult | null;
  activeFindingId: string | null;
  /** Per-finding discussion threads (oldest first). Ephemeral investigation context. */
  findingThreads: Record<string, AssistantChatMessage[]>;
  updatedAt: number | null;
}

const EMPTY_SESSION: AssistantSession = {
  brief: {},
  mode: "functional_blocks",
  result: null,
  activeFindingId: null,
  findingThreads: {},
  updatedAt: null,
};

interface AssistantSessionState {
  byDieId: Record<string, AssistantSession>;
  setBrief: (dieId: string, brief: AssistantAnalysisBrief) => void;
  setMode: (dieId: string, mode: AssistantAnalysisMode) => void;
  setResult: (dieId: string, result: AssistantAnalysisResult | null) => void;
  setActiveFindingId: (dieId: string, findingId: string | null) => void;
  clearResult: (dieId: string) => void;
  appendFindingMessage: (dieId: string, findingId: string, message: AssistantChatMessage) => void;
  resetFindingThread: (dieId: string, findingId: string) => void;
  updateFinding: (dieId: string, findingId: string, patch: Partial<import("shared").AssistantFinding>) => void;
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
      appendFindingMessage: (dieId, findingId, message) => set((state) => {
        const session = sessionFor(state, dieId);
        const existing = session.findingThreads[findingId] ?? [];
        return {
          byDieId: {
            ...state.byDieId,
            [dieId]: {
              ...session,
              findingThreads: { ...session.findingThreads, [findingId]: [...existing, message] },
              updatedAt: Date.now(),
            },
          },
        };
      }),
      resetFindingThread: (dieId, findingId) => set((state) => {
        const session = sessionFor(state, dieId);
        const threads = { ...session.findingThreads };
        delete threads[findingId];
        return {
          byDieId: { ...state.byDieId, [dieId]: { ...session, findingThreads: threads, updatedAt: Date.now() } },
        };
      }),
      updateFinding: (dieId, findingId, patch) => set((state) => {
        const session = sessionFor(state, dieId);
        const result = session.result;
        if (!result) return {};
        const findings = result.findings.map((finding) =>
          finding.id === findingId ? { ...finding, ...patch, userCorrected: true } : finding,
        );
        return {
          byDieId: {
            ...state.byDieId,
            [dieId]: { ...session, result: { ...result, findings }, updatedAt: Date.now() } },
        };
      }),
    }),
    {
      name: "mmo-chip-assistant-sessions-v1",
      storage: {
        getItem: (name) => {
          const raw = localStorage.getItem(name);
          if (!raw) return null;
          return JSON.parse(raw) as StorageValue<AssistantSessionState>;
        },
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, JSON.stringify(value));
          } catch {
            // Quota exceeded — strip tool images and retry
            const stripped = stripToolImages(value.state);
            try {
              localStorage.setItem(name, JSON.stringify({ ...value, state: stripped }));
            } catch {
              // Still too large — give up silently
            }
          }
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
    },
  ),
);
