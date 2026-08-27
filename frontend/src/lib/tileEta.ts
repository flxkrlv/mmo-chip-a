import { useEffect, useRef, useState } from "react";

export interface TileProgressSample {
  id: string;
  /** All physically available files, including cache hits during a restart. */
  completedTiles: number;
  totalTiles: number;
  /** Files that were genuinely rendered in this backend session. */
  generatedTiles: number;
}

interface RateState {
  /** Invalidates state preserved by Vite HMR from an older ETA formula. */
  metric: "generated-v1";
  generatedTiles: number;
  totalTiles: number;
  sampledAt: number;
  tilesPerSecond: number | null;
  positiveSamples: number;
}

/**
 * Estimates remaining duration from observed progress samples. The first
 * positive progress delta establishes a rate; later samples use exponential
 * smoothing so a single slow tile does not make the label jump wildly.
 */
export function useTileEta(samples: TileProgressSample[]): ReadonlyMap<string, number | null> {
  const stateById = useRef(new Map<string, RateState>());
  const [etaById, setEtaById] = useState<ReadonlyMap<string, number | null>>(new Map());

  useEffect(() => {
    const now = performance.now();
    const activeIds = new Set(samples.map((sample) => sample.id));
    const next = new Map<string, number | null>();

    for (const sample of samples) {
      const previous = stateById.current.get(sample.id);
      let tilesPerSecond = previous?.tilesPerSecond ?? null;
      let positiveSamples = previous?.positiveSamples ?? 0;
      const shouldReset =
        !previous ||
        previous.metric !== "generated-v1" ||
        !Number.isFinite(previous.generatedTiles) ||
        sample.totalTiles !== previous.totalTiles ||
        sample.generatedTiles < previous.generatedTiles;

      if (shouldReset) {
        stateById.current.set(sample.id, {
          metric: "generated-v1",
          generatedTiles: sample.generatedTiles,
          totalTiles: sample.totalTiles,
          sampledAt: now,
          tilesPerSecond: null,
          positiveSamples: 0
        });
        next.set(sample.id, null);
        continue;
      }

      const completedDelta = sample.generatedTiles - previous.generatedTiles;
      const elapsedSeconds = (now - previous.sampledAt) / 1_000;
      if (completedDelta > 0 && elapsedSeconds > 0) {
        const instantRate = completedDelta / elapsedSeconds;
        tilesPerSecond = tilesPerSecond === null
          ? instantRate
          : tilesPerSecond * 0.7 + instantRate * 0.3;
        positiveSamples += 1;
      }

      const remaining = Math.max(0, sample.totalTiles - sample.completedTiles);
      // Do not present a numerical ETA until two measured generation intervals
      // exist. This prevents a cached tile scan or HMR-preserved rate from being
      // mistaken for the speed of the entire remaining pyramid.
      const etaSeconds =
        remaining === 0
          ? 0
          : positiveSamples >= 2 && tilesPerSecond && tilesPerSecond > 0
          ? remaining / tilesPerSecond
          : null;
      next.set(sample.id, etaSeconds);
      stateById.current.set(sample.id, {
        metric: "generated-v1",
        generatedTiles: sample.generatedTiles,
        totalTiles: sample.totalTiles,
        sampledAt: now,
        tilesPerSecond,
        positiveSamples
      });
    }

    for (const id of stateById.current.keys()) {
      if (!activeIds.has(id)) stateById.current.delete(id);
    }
    setEtaById(next);
  }, [samples]);

  return etaById;
}

export function formatTileEta(etaSeconds: number | null | undefined): string {
  if (etaSeconds === null || etaSeconds === undefined || !Number.isFinite(etaSeconds)) {
    return "measuring generation speed…";
  }
  if (etaSeconds <= 0) return "finishing…";
  const totalMinutes = Math.ceil(etaSeconds / 60);
  if (totalMinutes <= 1) return "~1 min remaining";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `~${minutes} min remaining`;
  return minutes === 0 ? `~${hours} h remaining` : `~${hours} h ${minutes} min remaining`;
}
