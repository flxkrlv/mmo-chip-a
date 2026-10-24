/**
 * spiceHandoff.ts — hand a finished SPICE run from the assistant thread over
 * to the SPICE simulation page.
 *
 * The assistant runs ngspice server-side; the user then wants to look at the
 * same testbench and its waveforms in the simulator, tweak the testbench, and
 * ask the agent on that tab to refine it further. This store carries the run
 * between the two screens. It is intentionally NOT persisted: the netlist can
 * be large and localStorage is small.
 *
 * The payload is decomposed rather than passed through as one blob. The page
 * feeds each piece back into its own state (models → the picker, testbench →
 * the directives field), so what the page shows and what Run simulates stay
 * one and the same thing instead of a frozen override next to stale fields.
 */

import { create } from "zustand";
import type { AssistantSpiceRun } from "shared";
import { extractModelCards, restoreModelSelection } from "shared/spiceModels";
import type { SpiceModelSelection } from "shared/spiceModels";
import { splitAtSectionMarker, stripRunScaffolding } from "shared/spiceNetlist";

export interface SpiceHandoff {
  dieId: string;
  /** The netlist that was simulated (already converted to ngspice syntax). */
  netlist: string;
  /**
   * Models + DUT exactly as they were simulated, i.e. everything before the
   * section marker. `null` when the netlist has no marker and cannot be split
   * safely — the page then keeps its own DUT.
   */
  dut: string | null;
  /** The testbench: sources, loads, analysis, `.print`, `.measure` — editable. */
  directives: string;
  /** The `.MODEL` cards the run used, keyed by model name. */
  modelCards: Record<string, string>;
  /** The library option each card came from (the radio buttons). */
  modelSelection: SpiceModelSelection;
  /** Cards no library option matches, as netlist text for the models editor. */
  customModels: string;
  /** The run summary ("Operating Point — 86 variables, 1 point"). */
  summary?: string;
  plot?: string;
  measurements?: Record<string, number>;
  keyValues?: Record<string, number>;
  /** Where the run came from (for the breadcrumb in the simulator). */
  origin?: "assistant";
  at: number;
}

/** Everything a simulated netlist tells us about how to rebuild the page. */
export interface HandoffSections {
  dut: string | null;
  directives: string;
  modelCards: Record<string, string>;
  modelSelection: SpiceModelSelection;
  customModels: string;
}

/**
 * Decompose a netlist that has been simulated into the pieces the simulator
 * page keeps as separate state.
 *
 * `directives` is the testbench with the runner's own plumbing removed: the
 * `.control` block (`save` / `run` / `write sim.raw` / `quit`) is there for
 * the server-side run, while the simulator drives ngspice itself. Left in
 * place it would fire a second run and quit out from under the worker.
 */
export function handoffSections(netlist: string): HandoffSections {
  const split = splitAtSectionMarker(netlist);
  const directives = stripRunScaffolding(split.testbench);
  const modelCards = extractModelCards(split.dut ?? netlist);
  const { selection, customModels } = restoreModelSelection(modelCards);
  return { dut: split.dut, directives, modelCards, modelSelection: selection, customModels };
}

/** Build a handoff payload out of a simulated netlist. */
export function handoffFromNetlist(input: {
  dieId: string;
  netlist: string;
  summary?: string;
  plot?: string;
  measurements?: Record<string, number>;
  keyValues?: Record<string, number>;
  origin?: "assistant";
  at?: number;
}): SpiceHandoff {
  const sections = handoffSections(input.netlist);
  return {
    dieId: input.dieId,
    netlist: input.netlist,
    ...sections,
    summary: input.summary,
    plot: input.plot,
    measurements: input.measurements,
    keyValues: input.keyValues,
    origin: input.origin,
    at: input.at || Date.now(),
  };
}

interface SpiceHandoffState {
  handoff: SpiceHandoff | null;
  /** Store a handoff and return the payload (so the caller can navigate). */
  setHandoff: (handoff: SpiceHandoff) => void;
  /** Build a handoff from an assistant run. */
  setFromRun: (dieId: string, run: AssistantSpiceRun) => void;
  clear: () => void;
}

export const useSpiceHandoff = create<SpiceHandoffState>((set) => ({
  handoff: null,
  setHandoff: (handoff) => set({ handoff }),
  setFromRun: (dieId, run) => set({
    handoff: handoffFromNetlist({
      dieId,
      netlist: run.netlist,
      summary: run.summary,
      plot: run.plot,
      measurements: run.measurements,
      keyValues: run.keyValues,
      origin: "assistant",
      at: run.at,
    }),
  }),
  clear: () => set({ handoff: null }),
}));
