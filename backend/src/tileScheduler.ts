import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureTileForRecord } from "./dieImport/importer.js";
import type { DieRecord } from "./types.js";

// Build the full tile pyramid after import so every area is fast on its first
// visit. Interactive viewport requests retain dedicated worker capacity.
const BACKGROUND_TILE_GENERATION_ENABLED = true;

type TilePriority = "high" | "low";

interface TileTask {
  key: string;
  record: DieRecord;
  z: number;
  x: number;
  y: number;
  priority: TilePriority;
  started: boolean;
  requesterCount: number;
  promise: Promise<string>;
  resolve: (tilePath: string) => void;
  reject: (error: unknown) => void;
  completion: Promise<void>;
}

interface DieProgressState {
  totalTiles: number;
  /** Files confirmed available during this backend session, including cache hits. */
  completedTiles: number;
  /** Files actually rendered during this session; excludes the fast cache scan. */
  generatedTiles: number;
  lastLoggedStep: number;
  backgroundQueued: boolean;
  isPaused: boolean;
  /** First real Sharp render timestamp; cache scan time never enters ETA. */
  generationStartedAt: number | null;
  /** Average actual render throughput since generationStartedAt. */
  tilesPerSecond: number | null;
  rateSamples: number;
}

export function createTileScheduler(config: {
  dataRoot: string;
  concurrency: number;
}) {
  const activeTasks = new Map<string, TileTask>();
  const highPriorityQueue: string[] = [];
  const lowPriorityQueue: string[] = [];
  const progressByDie = new Map<string, DieProgressState>();
  const deletedDies = new Set<string>();
  let activeWorkers = 0;
  // A full prebuild should be fast, but it must leave capacity for the UI and
  // avoid saturating CPU/disk while working through thousands of native tiles.
  const maxBackgroundWorkers = Math.max(1, Math.min(2, Math.max(1, config.concurrency - 1)));

  function ensureProgressState(record: DieRecord) {
    let progress = progressByDie.get(record.id);
    if (!progress) {
      progress = {
        totalTiles: record.levels.reduce((sum, level) => sum + level.columns * level.rows, 0),
        completedTiles: 0,
        generatedTiles: 0,
        lastLoggedStep: -1,
        backgroundQueued: false,
        isPaused: false,
        generationStartedAt: null,
        tilesPerSecond: null,
        rateSamples: 0
      };
      progressByDie.set(record.id, progress);
    }
    return progress;
  }

  async function requestTile(record: DieRecord, z: number, x: number, y: number) {
    if (deletedDies.has(record.id)) {
      throw new Error("Die has been deleted.");
    }

    const tilePath = buildTilePath(config.dataRoot, record.id, z, x, y);
    try {
      await fs.access(tilePath);
      return tilePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const task = getOrCreateTask(record, z, x, y, "high");
    task.requesterCount += 1;
    if (!task.started && task.priority !== "high") {
      task.priority = "high";
      highPriorityQueue.push(task.key);
    }
    pumpQueue();
    return task.promise;
  }

  function enqueueBackground(record: DieRecord) {
    if (!BACKGROUND_TILE_GENERATION_ENABLED) {
      return;
    }
    if (deletedDies.has(record.id)) {
      return;
    }

    const progress = ensureProgressState(record);
    if (progress.backgroundQueued) {
      return;
    }

    progress.backgroundQueued = true;
    console.log(`[tiles:${record.id}] queued background generation for ${progress.totalTiles} tiles`);

    for (const level of record.levels) {
      for (let y = 0; y < level.rows; y += 1) {
        for (let x = 0; x < level.columns; x += 1) {
          getOrCreateTask(record, level.z, x, y, "low");
        }
      }
    }

    pumpQueue();
  }

  function pauseBackground(dieId: string) {
    const progress = progressByDie.get(dieId);
    if (!progress) return null;
    progress.isPaused = true;
    return getProgress(dieId);
  }

  function resumeBackground(record: DieRecord) {
    const progress = ensureProgressState(record);
    progress.isPaused = false;
    enqueueBackground(record);
    pumpQueue();
    return getProgress(record.id);
  }

  function getOrCreateTask(
    record: DieRecord,
    z: number,
    x: number,
    y: number,
    priority: TilePriority
  ) {
    const key = `${record.id}/${z}/${x}/${y}`;
    const existing = activeTasks.get(key);
    if (existing) {
      if (!existing.started && priority === "high" && existing.priority !== "high") {
        existing.priority = "high";
        highPriorityQueue.push(existing.key);
      }
      return existing;
    }

    let resolve!: (tilePath: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const completion = promise.then(
      () => undefined,
      () => undefined
    );

    const task: TileTask = {
      key,
      record,
      z,
      x,
      y,
      priority,
      started: false,
      requesterCount: 0,
      promise,
      resolve,
      reject,
      completion
    };

    activeTasks.set(key, task);
    if (priority === "high") {
      highPriorityQueue.push(key);
    } else {
      lowPriorityQueue.push(key);
    }

    return task;
  }

  function pumpQueue() {
    while (activeWorkers < Math.max(1, config.concurrency)) {
      const task = takeNextTask();
      if (!task) {
        return;
      }
      if (task.priority === "low" && activeBackgroundWorkerCount() >= maxBackgroundWorkers) {
        // Leave the low-priority task queued. A later interactive request will
        // still be admitted immediately through the reserved worker capacity.
        lowPriorityQueue.unshift(task.key);
        return;
      }

      task.started = true;
      activeWorkers += 1;

      void runTask(task).finally(() => {
        activeWorkers -= 1;
        pumpQueue();
      });
    }
  }

  function activeBackgroundWorkerCount(): number {
    let count = 0;
    for (const task of activeTasks.values()) {
      if (task.started && task.priority === "low") count += 1;
    }
    return count;
  }

  function takeNextTask() {
    while (highPriorityQueue.length > 0) {
      const key = highPriorityQueue.shift()!;
      const task = activeTasks.get(key);
      if (!task || task.started || task.priority !== "high") {
        continue;
      }
      return task;
    }

    // Scan each currently queued low-priority task at most once. Paused work is
    // preserved in-place, while runnable work from later projects can proceed.
    const lowQueueLength = lowPriorityQueue.length;
    for (let index = 0; index < lowQueueLength; index += 1) {
      const key = lowPriorityQueue.shift()!;
      const task = activeTasks.get(key);
      if (!task || task.started || task.priority !== "low") {
        continue;
      }
      if (ensureProgressState(task.record).isPaused) {
        lowPriorityQueue.push(key);
        continue;
      }
      return task;
    }

    return null;
  }

  async function runTask(task: TileTask) {
    try {
      const expectedTilePath = buildTilePath(config.dataRoot, task.record.id, task.z, task.x, task.y);
      const wasCached = await isTilePresent(expectedTilePath);
      const tilePath = await ensureTileForRecord({
        dataRoot: config.dataRoot,
        record: task.record,
        z: task.z,
        x: task.x,
        y: task.y
      });

      if (deletedDies.has(task.record.id)) {
        activeTasks.delete(task.key);
        task.reject(new Error("Die has been deleted."));
        return;
      }

      const progress = ensureProgressState(task.record);
      progress.completedTiles += 1;
      if (!wasCached) {
        const generatedAt = Date.now();
        if (progress.generationStartedAt === null) {
          progress.generationStartedAt = generatedAt;
        }
        progress.generatedTiles += 1;
        progress.rateSamples += 1;
        const elapsedSeconds = (generatedAt - progress.generationStartedAt) / 1_000;
        if (elapsedSeconds > 0) {
          progress.tilesPerSecond = progress.generatedTiles / elapsedSeconds;
        }
      }
      logLazyCompletion(task, progress);
      logBackgroundProgress(task.record.id, progress);

      activeTasks.delete(task.key);
      task.resolve(tilePath);
    } catch (error) {
      activeTasks.delete(task.key);
      task.reject(error);
    }
  }

  function logLazyCompletion(task: TileTask, progress: DieProgressState) {
    if (task.requesterCount === 0) {
      return;
    }

    console.log(
      `[tiles:${task.record.id}] requested tile ${task.z}/${task.x}/${task.y} ready (${progress.completedTiles}/${progress.totalTiles})`
    );
  }

  function logBackgroundProgress(dieId: string, progress: DieProgressState) {
    const nextStep =
      progress.totalTiles === 0
        ? 10
        : Math.floor((progress.completedTiles / progress.totalTiles) * 10);
    if (
      nextStep <= progress.lastLoggedStep &&
      progress.completedTiles !== progress.totalTiles
    ) {
      return;
    }

    progress.lastLoggedStep = nextStep;
    const percentage =
      progress.totalTiles === 0
        ? 100
        : (progress.completedTiles / progress.totalTiles) * 100;
    console.log(
      `[tiles:${dieId}] background ${percentage.toFixed(1)}% (${progress.completedTiles}/${progress.totalTiles})`
    );
  }

  async function removeDie(dieId: string) {
    deletedDies.add(dieId);
    progressByDie.delete(dieId);

    const pendingCompletions: Promise<void>[] = [];
    for (const task of activeTasks.values()) {
      if (task.record.id !== dieId) {
        continue;
      }

      if (task.started) {
        pendingCompletions.push(task.completion);
        continue;
      }

      activeTasks.delete(task.key);
      task.reject(new Error("Die has been deleted."));
    }

    await Promise.allSettled(pendingCompletions);
  }

  function getProgress(dieId: string) {
    const state = progressByDie.get(dieId);
    if (!state) return null;
    const percentage =
      state.totalTiles === 0 ? 100 : (state.completedTiles / state.totalTiles) * 100;
    const remainingTiles = Math.max(0, state.totalTiles - state.completedTiles);
    const generationElapsedSeconds =
      state.generationStartedAt === null ? 0 : (Date.now() - state.generationStartedAt) / 1_000;
    const currentRate =
      generationElapsedSeconds > 0 && state.generatedTiles > 0
        ? state.generatedTiles / generationElapsedSeconds
        : null;
    // Require a broad real-world sample window. This blocks a short burst of
    // easy/coarse tiles from claiming the whole remaining pyramid is a minute away.
    const hasStableRate =
      state.rateSamples >= 20 &&
      generationElapsedSeconds >= 20 &&
      currentRate !== null &&
      currentRate > 0;
    return {
      totalTiles: state.totalTiles,
      completedTiles: state.completedTiles,
      percentage,
      generatedTiles: state.generatedTiles,
      isPaused: state.isPaused,
      tilesPerSecond: hasStableRate ? currentRate : null,
      etaSeconds:
        remainingTiles === 0
          ? 0
          : !state.isPaused && hasStableRate
          ? remainingTiles / currentRate!
          : null
    };
  }

  return {
    enqueueBackground,
    pauseBackground,
    resumeBackground,
    requestTile,
    removeDie,
    getProgress
  };
}

async function isTilePresent(tilePath: string) {
  try {
    await fs.access(tilePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function buildTilePath(dataRoot: string, dieId: string, z: number, x: number, y: number) {
  return path.join(dataRoot, "dies", dieId, "tiles", String(z), `${x}_${y}.jpg`);
}
