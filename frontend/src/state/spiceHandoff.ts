/**
 * spiceHandoff.ts — hand a finished SPICE run from the assistant thread over
 * to the SPICE simulation page.
 *
 * The assistant runs ngspice server-side; the user then wants to look at the
 * same testbench and its waveforms in the simulator. This store carries that
 * payload (netlist + numbers) between the two screens. It is intentionally
 * NOT persisted: the netlist can be large and localStorage is small.
 */

import { create } from "zustand";
import type { AssistantSpiceRun } from "shared";

export interface SpiceHandoff {
  dieId: string;
  /** The netlist that was simulated (already converted to ngspice syntax). */
  netlist: string;
  /** The run summary ("Operating Point — 86 variables, 1 point"). */
  summary?: string;
  plot?: string;
  measurements?: Record<string, number>;
  keyValues?: Record<string, number>;
  /** Where the run came from (for the breadcrumb in the simulator). */
  origin?: "assistant";
  at: number;
}

interface SpiceHandoffState {
  handoff: SpiceHandoff | null;
  /** Store a run and return the payload (so the caller can navigate). */
  setHandoff: (handoff: SpiceHandoff) => void;
  /** Build a handoff from an assistant run. */
  setFromRun: (dieId: string, run: AssistantSpiceRun) => void;
  clear: () => void;
}

export const useSpiceHandoff = create<SpiceHandoffState>((set) => ({
  handoff: null,
  setHandoff: (handoff) => set({ handoff }),
  setFromRun: (dieId, run) => set({
    handoff: {
      dieId,
      netlist: run.netlist,
      summary: run.summary,
      plot: run.plot,
      measurements: run.measurements,
      keyValues: run.keyValues,
      origin: "assistant",
      at: run.at || Date.now(),
    },
  }),
  clear: () => set({ handoff: null }),
}));
