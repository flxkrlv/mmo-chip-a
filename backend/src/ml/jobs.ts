import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveOverlayOriginalPath } from "../api/overlayImages.js";
import type { MLInferenceJob } from "shared";
import {
  listMLJobs,
  readDieRecord,
  readMLJob,
  writeMLJob
} from "../store.js";
import type { DieRecord } from "../types.js";
import {
  INFERENCE_MIN_DISTANCE,
  INFERENCE_THRESHOLD,
  resolveTile,
  SidecarUnavailable,
  toPrediction,
  type MLPredictor
} from "./predict.js";

/** In-flight tile requests. The sidecar serializes GPU work anyway; a small
 *  pool just overlaps Node-side cropping with the sidecar's inference. */
const SWEEP_CONCURRENCY = 2;
/** Don't flood WS clients — coalesce progress to at most one per interval. */
const BROADCAST_THROTTLE_MS = 700;

export interface MLJobManager {
  /** Current job state for a die (recomputed against the cache on disk). */
  getJob(dieId: string): Promise<MLInferenceJob>;
  /** Every persisted job (stale "running" jobs reconciled to "stopped"). */
  listJobs(): Promise<MLInferenceJob[]>;
  /** Begin (or resume) a die-wide inference sweep. overlayFilename optional — when set, run inference on that overlay. */
  startJob(dieId: string, overlayFilename?: string): Promise<MLInferenceJob>;
  /** Request the running sweep to stop after the current tile. */
  stopJob(dieId: string): Promise<MLInferenceJob>;
}

interface ActiveSweep {
  cancel: boolean;
}

function nativeGrid(record: DieRecord): { columns: number; rows: number } {
  const level = record.levels.find((l) => l.z === record.maxZoomLevel);
  if (level) return { columns: level.columns, rows: level.rows };
  // Fallback: derive from dimensions if the level list is unexpectedly sparse.
  return {
    columns: Math.ceil(record.width / record.tileSize),
    rows: Math.ceil(record.height / record.tileSize)
  };
}

function pct(completed: number, total: number): number {
  return total > 0 ? Math.round((completed / total) * 100) : 0;
}

export function createMLJobManager(config: {
  dataRoot: string;
  predictor: MLPredictor;
  /** Push a job-state change to subscribed WS clients. */
  onJobChange?: (job: MLInferenceJob) => void;
}): MLJobManager {
  const { dataRoot, predictor, onJobChange } = config;
  const active = new Map<string, ActiveSweep>();

  /** Count tiles already cached for a die at the given checkpoint. */
  async function countCachedTiles(
    dieId: string,
    hash: string | null,
    nativeZ: number,
    overlayKey?: string
  ): Promise<number> {
    const dir = predictor.cacheDirFor(dieId, hash);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return 0;
    }
    const prefix = overlayKey ? `${nativeZ}_` : `${nativeZ}_`;
    const suffix = overlayKey ? `__${overlayKey}.json` : ".json";
    // Without overlayKey, count tiles without the overlay suffix; with overlayKey, only those with it.
    return entries.filter((f) => {
      if (!f.startsWith(prefix) || !f.endsWith(".json")) return false;
      const withoutExt = f.slice(0, -5);
      const hasSuffix = withoutExt.includes("__");
      if (overlayKey) return withoutExt.endsWith(`__${overlayKey}`);
      return !hasSuffix;
    }).length;
  }

  async function persistAndBroadcast(job: MLInferenceJob): Promise<void> {
    await writeMLJob(dataRoot, job);
    onJobChange?.(job);
  }

  function overlayKey(dieId: string, overlayFilename: string | null | undefined): string | undefined {
    return overlayFilename ? `${overlayFilename.replace(/[^a-zA-Z0-9_\-.]/g, "_")}` : undefined;
  }

  async function getJob(dieId: string): Promise<MLInferenceJob> {
    const record = await readDieRecord(dataRoot, dieId);
    const { columns, rows } = nativeGrid(record);
    const totalTiles = columns * rows;

    let checkpointHash: string | null = null;
    try {
      checkpointHash = await predictor.getCheckpointHash();
    } catch {
      checkpointHash = null;
    }

    const persisted = await readMLJob(dataRoot, dieId);
    const hash = checkpointHash ?? persisted?.checkpointHash ?? null;
    const ovKey = overlayKey(dieId, persisted?.overlayFilename ?? null);
    const completedTiles = await countCachedTiles(
      dieId,
      hash,
      record.maxZoomLevel,
      ovKey
    );
    const running = active.has(dieId);

    const status: MLInferenceJob["status"] = running
      ? "running"
      : completedTiles >= totalTiles && totalTiles > 0
        ? "completed"
        : persisted?.status === "failed"
          ? "failed"
          : "stopped";

    return {
      dieId,
      status,
      totalTiles,
      completedTiles: Math.min(completedTiles, totalTiles),
      percentage: pct(Math.min(completedTiles, totalTiles), totalTiles),
      checkpointHash: hash,
      model: persisted?.model ?? null,
      overlayFilename: persisted?.overlayFilename ?? null,
      error: status === "failed" ? (persisted?.error ?? null) : null,
      startedAt: persisted?.startedAt ?? null,
      updatedAt: persisted?.updatedAt ?? new Date().toISOString(),
      finishedAt: persisted?.finishedAt ?? null
    };
  }

  async function runSweep(
    record: DieRecord,
    hash: string | null,
    job: MLInferenceJob,
    sweep: ActiveSweep
  ): Promise<void> {
    const nativeZ = record.maxZoomLevel;
    const { columns, rows } = nativeGrid(record);
    const tiles: { tx: number; ty: number }[] = [];
    for (let ty = 0; ty < rows; ty += 1) {
      for (let tx = 0; tx < columns; tx += 1) tiles.push({ tx, ty });
    }

    const ovKey = overlayKey(record.id, job.overlayFilename);
    const overlayPath = job.overlayFilename
      ? await resolveOverlayOriginalPath({
          dataRoot,
          dieId: record.id,
          sourceId: job.overlayFilename
        }) ?? undefined
      : undefined;
    if (job.overlayFilename && !overlayPath) {
      throw new Error("Visible image source not found");
    }

    let completed = 0;
    let lastBroadcast = 0;
    let cursor = 0;

    const emit = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastBroadcast < BROADCAST_THROTTLE_MS) return;
      lastBroadcast = now;
      job.completedTiles = Math.min(completed, job.totalTiles);
      job.percentage = pct(job.completedTiles, job.totalTiles);
      job.updatedAt = new Date().toISOString();
      void persistAndBroadcast({ ...job });
    };

    const worker = async (): Promise<void> => {
      while (!sweep.cancel) {
        const idx = cursor;
        cursor += 1;
        if (idx >= tiles.length) return;
        const { tx, ty } = tiles[idx];
        const cached = await predictor.readCachedTile(
          record.id,
          hash,
          nativeZ,
          tx,
          ty,
          ovKey
        );
        if (cached) {
          completed += 1;
          emit(false);
          continue;
        }
        const resolved = resolveTile(record, nativeZ, tx, ty);
        if (resolved.kind !== "ok") {
          completed += 1;
          emit(false);
          continue;
        }
        const result = await predictor.runPrediction({
          originalPath: record.originalPath,
          dieWidth: record.width,
          dieHeight: record.height,
          keep: resolved.box,
          threshold: INFERENCE_THRESHOLD,
          minDistance: INFERENCE_MIN_DISTANCE,
          wantHeatmap: false,
          overlayPath
        });
        await predictor.writeCachedTile(
          record.id,
          hash,
          nativeZ,
          tx,
          ty,
          toPrediction(result, resolved.box, hash, job.overlayFilename),
          ovKey
        );
        completed += 1;
        emit(false);
      }
    };

    try {
      await Promise.all(
        Array.from({ length: SWEEP_CONCURRENCY }, () => worker())
      );
      job.status = sweep.cancel ? "stopped" : "completed";
      job.error = null;
    } catch (error) {
      job.status = "failed";
      job.error =
        error instanceof SidecarUnavailable
          ? error.message
          : error instanceof Error
            ? error.message
            : "inference failed";
    } finally {
      active.delete(record.id);
      job.completedTiles = Math.min(completed, job.totalTiles);
      job.percentage = pct(job.completedTiles, job.totalTiles);
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      emit(true);
    }
  }

  async function startJob(dieId: string, overlayFilename?: string): Promise<MLInferenceJob> {
    if (active.has(dieId)) return getJob(dieId);

    const record = await readDieRecord(dataRoot, dieId);
    const hash = await predictor.getCheckpointHash();
    const { columns, rows } = nativeGrid(record);
    const totalTiles = columns * rows;
    const now = new Date().toISOString();

    const job: MLInferenceJob = {
      dieId,
      status: "running",
      totalTiles,
      completedTiles: 0,
      percentage: 0,
      checkpointHash: hash,
      model: null,
      overlayFilename: overlayFilename ?? null,
      error: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null
    };

    const sweep: ActiveSweep = { cancel: false };
    active.set(dieId, sweep);
    await persistAndBroadcast({ ...job });
    void runSweep(record, hash, job, sweep);
    return job;
  }

  async function listJobs(): Promise<MLInferenceJob[]> {
    const jobs = await listMLJobs(dataRoot);
    // A job persisted as "running" but absent from `active` is stale — the
    // server restarted mid-sweep. Report it as stopped.
    return jobs.map((j) =>
      j.status === "running" && !active.has(j.dieId)
        ? { ...j, status: "stopped" as const }
        : j
    );
  }

  async function stopJob(dieId: string): Promise<MLInferenceJob> {
    const sweep = active.get(dieId);
    if (sweep) sweep.cancel = true;
    // The sweep persists the final "stopped" state itself; return the live view.
    return getJob(dieId);
  }

  return { getJob, listJobs, startJob: startJob as (dieId: string, overlayFilename?: string) => Promise<MLInferenceJob>, stopJob };
}
