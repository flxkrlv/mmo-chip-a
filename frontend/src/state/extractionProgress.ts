import { create } from "zustand";
import type { ChunkedProgress } from "../lib/extraction/chunkedRunner";

interface ExtractionProgressState {
  progress: ChunkedProgress | null;
  isRunning: boolean;
  lastTimeMs: number | null;
  lastCtCount: number | null;
  lastCached: boolean;
}

interface ExtractionProgressActions {
  setProgress: (p: ChunkedProgress | null) => void;
  setLastExtraction: (timeMs: number, ctCount: number, cached: boolean) => void;
  reset: () => void;
}

export const useExtractionProgress = create<
  ExtractionProgressState & ExtractionProgressActions
>()((set) => ({
  progress: null,
  isRunning: false,
  lastTimeMs: null,
  lastCtCount: null,
  lastCached: false,
  setProgress: (p) =>
    set({
      progress: p,
      isRunning: p !== null && !p.canceled && p.done < p.total,
    }),
  setLastExtraction: (timeMs, ctCount, cached) =>
    set({ lastTimeMs: timeMs, lastCtCount: ctCount, lastCached: cached }),
  reset: () =>
    set({
      progress: null,
      isRunning: false,
      // keep lastTimeMs/lastCtCount/lastCached — they persist for StatusBar display
    }),
}));
