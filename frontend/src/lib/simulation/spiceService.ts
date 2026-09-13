/**
 * spiceService.ts — Main-thread Comlink wrapper for the SPICE simulation worker.
 *
 * Lazily creates a single Worker instance. All calls are forwarded via Comlink.
 */

import * as Comlink from "comlink";
import type {
  SimulationResult,
  SimulationStatus,
  SimulationWorkerAPI,
  SpiceSimulationOutput,
  WaveformTrace,
} from "./types";

let workerInstance: Worker | null = null;
let api: Comlink.Remote<SimulationWorkerAPI> | null = null;

function getApi(): Comlink.Remote<SimulationWorkerAPI> {
  if (!api) {
    workerInstance = new Worker(
      new URL("./spiceWorker.ts", import.meta.url),
      { type: "module" },
    );
    api = Comlink.wrap<SimulationWorkerAPI>(workerInstance);
  }
  return api;
}

/** Initialize the ngspice WASM engine (idempotent). */
export async function initSpice(): Promise<string> {
  return getApi().init();
}

/** Run a simulation and return the raw result. */
export async function runSpiceSimulation(netlist: string): Promise<SimulationResult> {
  return getApi().run(netlist);
}

/** Get current worker status. */
export async function getSpiceStatus(): Promise<SimulationStatus> {
  return getApi().getStatus();
}

/** Get errors from the last simulation. */
export async function getSpiceErrors(): Promise<string[]> {
  return getApi().getErrors();
}

/** Terminate the worker (cleanup). */
export function terminateSpice(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
    api = null;
  }
}

// ── Waveform parsing helpers ────────────────────────────────────

/**
 * Convert raw SimulationResult into typed WaveformTrace array.
 *
 * IMPORTANT: eecircuit-engine's readOutput filters out "notype" variables
 * from the metadata but keeps all data[] arrays. So data[i] does NOT
 * necessarily correspond to variableNames[i]. We must match by name/type
 * to find the sweep axis (time/frequency/voltage) and signal traces.
 *
 * ngspice with multiple analyses (.op + .dc + .tran) concatenates results
 * into one raw file, producing a non-monotonic x-axis. We extract the
 * largest contiguous monotonic segment for clean plotting.
 */
export function parseWaveforms(result: SimulationResult): WaveformTrace[] {
  const traces: WaveformTrace[] = [];

  if (result.data.length < 2 || result.numPoints < 2) return traces;

  if (result.dataType === "real") {
    // Find the sweep axis: first variable of type time, frequency, or voltage
    // that looks like a monotonic sweep.
    let sweepIdx = -1;
    for (let i = 0; i < result.data.length; i++) {
      const v = result.data[i];
      if (v.type === "time" || v.type === "frequency") {
        sweepIdx = i;
        break;
      }
    }
    // Fallback: check if first variable is monotonic
    if (sweepIdx < 0 && result.data.length > 0) {
      const first = result.data[0].values;
      let monotonic = true;
      for (let i = 1; i < Math.min(first.length, 10); i++) {
        if (first[i] <= first[i - 1]) { monotonic = false; break; }
      }
      if (monotonic) sweepIdx = 0;
    }
    if (sweepIdx < 0) {
      sweepIdx = 0;
    }

    const xAll = result.data[sweepIdx].values;

    // Find largest contiguous monotonic segment
    let bestStart = 0;
    let bestLen = 1;
    let curStart = 0;
    for (let i = 1; i < xAll.length; i++) {
      if (xAll[i] > xAll[i - 1]) {
        const len = i - curStart + 1;
        if (len > bestLen) { bestStart = curStart; bestLen = len; }
      } else {
        curStart = i;
      }
    }
    {
      const len = xAll.length - curStart;
      if (len > bestLen) { bestStart = curStart; bestLen = len; }
    }

    const xValues = xAll.slice(bestStart, bestStart + bestLen);

    for (let i = 0; i < result.data.length; i++) {
      if (i === sweepIdx) continue; // skip sweep axis itself

      const v = result.data[i];
      const yValues = v.values.slice(bestStart, bestStart + bestLen);

      // Skip constant/zero traces
      let min = Infinity, max = -Infinity;
      for (const y of yValues) {
        if (Number.isFinite(y)) {
          if (y < min) min = y;
          if (y > max) max = y;
        }
      }
      if (!Number.isFinite(min) || max - min < 1e-30) continue;

      traces.push({ name: v.name, type: v.type, xValues, yValues });
    }
  } else {
    // Complex — plot magnitude
    const sweepIdx = 0;
    const xValues = result.data[sweepIdx].values.map((pt) => pt.real);

    for (let i = 0; i < result.data.length; i++) {
      if (i === sweepIdx) continue;
      const v = result.data[i];
      const yValues = v.values.map((pt) => Math.sqrt(pt.real ** 2 + pt.img ** 2));
      traces.push({ name: v.name, type: v.type, xValues, yValues });
    }
  }

  return traces;
}

/**
 * Run a full simulation and return parsed output.
 */
export async function runFullSimulation(
  netlist: string,
): Promise<SpiceSimulationOutput> {
  const t0 = performance.now();
  const raw = await runSpiceSimulation(netlist);
  const durationMs = performance.now() - t0;
  const waveforms = parseWaveforms(raw);
  const errors = await getSpiceErrors();

  return { raw, waveforms, errors, durationMs };
}
