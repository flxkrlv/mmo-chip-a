import { promises as fs } from "node:fs";
import path from "node:path";
import type { MLInferenceJob } from "shared";
import type { DieAnnotations, DieIndex, DieRecord, ImportJobIndex, ImportJobRecord, UserRecord } from "./types.js";
import {
  resolveProjectDir,
  registerFolderShortcut,
  unregisterFolderShortcut,
  listFolderShortcuts
} from "./projectLayout.js";

const EMPTY_DIE_INDEX: DieIndex = { dies: [] };
const EMPTY_JOB_INDEX: ImportJobIndex = { jobs: [] };

// One write at a time per target path: concurrent writers (job progress
// persisting without awaiting) must not race their tmp+rename sequences, or
// an older body could land after a newer one and resurrect stale content.
const jsonWriteLocks = new Map<string, Promise<unknown>>();

/**
 * Write to a unique sibling tmp file, then rename over the target. A plain
 * writeFile truncates first, so a crash or `tsx watch` restart mid-write
 * leaves a cut-off file that no longer parses; rename replaces the file in
 * one step, so readers see either the old or the new complete file.
 * Writes to the same path are serialized (see jsonWriteLocks), and the
 * rename is retried: on Windows a replace can fail transiently with
 * EPERM/EACCES/EBUSY when the target is being read (or scanned) right then.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const key = path.resolve(filePath);
  const previous = jsonWriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  jsonWriteLocks.set(key, gate);
  await previous;
  try {
    await writeJsonAtomicNow(filePath, value);
  } finally {
    release();
    if (jsonWriteLocks.get(key) === gate) {
      // Keep the map bounded: drop the entry once the queue drains.
      jsonWriteLocks.delete(key);
    }
  }
}

async function writeJsonAtomicNow(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tmp, filePath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

// ─── User CRUD ────────────────────────────────────────────────

export async function listUsers(dataRoot: string): Promise<UserRecord[]> {
  return readJson<UserRecord[]>(path.join(dataRoot, "users.json"), []);
}

export async function findUserByUsername(dataRoot: string, username: string): Promise<UserRecord | null> {
  const users = await listUsers(dataRoot);
  return users.find((u) => u.username === username) ?? null;
}

export async function findUserById(dataRoot: string, userId: string): Promise<UserRecord | null> {
  const users = await listUsers(dataRoot);
  return users.find((u) => u.id === userId) ?? null;
}

export async function createUser(dataRoot: string, record: UserRecord): Promise<void> {
  const users = await listUsers(dataRoot);
  users.push(record);
  await writeJsonAtomic(path.join(dataRoot, "users.json"), users);
}

// ─── Die CRUD ─────────────────────────────────────────────────

export async function ensureDataStore(dataRoot: string) {
  await fs.mkdir(path.join(dataRoot, "dies"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "jobs"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "ml-jobs"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "tmp"), { recursive: true });
  await writeJsonIfMissing(path.join(dataRoot, "index.json"), EMPTY_DIE_INDEX);
  await writeJsonIfMissing(path.join(dataRoot, "jobs", "index.json"), EMPTY_JOB_INDEX);
  await writeJsonIfMissing(path.join(dataRoot, "users.json"), []);
}

export async function listDieRecords(dataRoot: string): Promise<DieRecord[]> {
  await ensureDataStore(dataRoot);
  const indexPath = path.join(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);

    // Managed records come from the index; folder records are remembered as
  // local shortcuts. A folder project whose directory was moved/deleted on
  // disk must not break the whole list, so it is skipped — managed records keep
  // their original behaviour (an unreadable managed record still throws).
  const managedIds = new Set(index.dies);
  const shortcuts = await listFolderShortcuts(dataRoot);
  const folderIds = shortcuts.map((s) => s.dieId);
  const allIds = Array.from(new Set([...index.dies, ...folderIds]));

  const records = await Promise.all(
    allIds.map(async (dieId) => {
      if (managedIds.has(dieId)) {
        return readDieRecord(dataRoot, dieId);
      }
      try {
        return await readDieRecord(dataRoot, dieId);
      } catch {
        // The folder is gone/unreadable. If we have a snapshot, still list
        // the project as an unavailable folder project so the user can see
        // it and relocate it; otherwise drop it silently.
        const shortcut = shortcuts.find((s) => s.dieId === dieId);
        return shortcut?.snapshot ? snapshotRecord(dieId, shortcut.folderPath, shortcut.snapshot) : null;
      }
    })
  );

  return records
    .filter((record): record is DieRecord => record !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readDieRecord(dataRoot: string, dieId: string): Promise<DieRecord> {
  const resolved = await resolveProjectDir(dataRoot, dieId);
  const record = await readJson<DieRecord>(path.join(resolved.dir, "metadata.json"));
  // The local shortcut is the source of truth for a folder project's location;
  // metadata's `folderPath` can go stale after the folder is moved or copied
  // (e.g. opened from another machine). Correcting it here keeps every consumer
  // — the tile scheduler's synchronous resolver, ML, crops — pointed at the
  // folder that actually exists on this machine.
  if (resolved.kind === "folder") {
    return { ...record, location: "folder", folderPath: resolved.dir };
  }
  return record;
}

export async function writeDieRecord(dataRoot: string, record: DieRecord) {
  const resolved = await resolveProjectDir(dataRoot, record.id);
  await fs.mkdir(resolved.dir, { recursive: true });
  await writeJsonAtomic(path.join(resolved.dir, "metadata.json"), record);

  if (resolved.kind === "folder") {
    // Folder projects are tracked by a local shortcut, not the managed index.
    // Snapshot the display fields so the project can still be listed
    // (as "folder missing") if its directory is moved/deleted later.
    await registerFolderShortcut(dataRoot, record.id, resolved.dir, {
      name: record.name,
      width: record.width,
      height: record.height,
      originalFilename: record.originalFilename,
      createdAt: record.createdAt
    });
    return;
  }

  const indexPath = path.join(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  if (!index.dies.includes(record.id)) {
    index.dies.push(record.id);
    await writeJsonAtomic(indexPath, index);
  }
}

export async function deleteDieRecord(dataRoot: string, dieId: string) {
    const resolved = await resolveProjectDir(dataRoot, dieId);

  // Managed projects: remove the die directory — exactly what the legacy code
  // did (overlay-images were never removed here and still are not).
  // Folder projects: only forget the shortcut — the user's folder is theirs and
  // must never be deleted implicitly.
  if (resolved.kind === "managed") {
    await fs.rm(resolved.dir, { recursive: true, force: true });
  } else {
    await unregisterFolderShortcut(dataRoot, dieId);
  }

  const indexPath = path.join(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  const nextDies = index.dies.filter((id) => id !== dieId);
  if (nextDies.length !== index.dies.length) {
    await writeJsonAtomic(indexPath, { dies: nextDies });
  }
}

export async function listImportJobs(dataRoot: string): Promise<ImportJobRecord[]> {
  await ensureDataStore(dataRoot);
  const indexPath = path.join(dataRoot, "jobs", "index.json");
  const index = await readJson<ImportJobIndex>(indexPath, EMPTY_JOB_INDEX);
  const jobs = await Promise.all(index.jobs.map((jobId) => readImportJob(dataRoot, jobId)));

  return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readImportJob(
  dataRoot: string,
  jobId: string
): Promise<ImportJobRecord> {
  return readJson<ImportJobRecord>(path.join(dataRoot, "jobs", `${jobId}.json`));
}

export async function writeImportJob(dataRoot: string, job: ImportJobRecord) {
  await writeJsonAtomic(path.join(dataRoot, "jobs", `${job.id}.json`), job);

  const indexPath = path.join(dataRoot, "jobs", "index.json");
  const index = await readJson<ImportJobIndex>(indexPath, EMPTY_JOB_INDEX);
  if (!index.jobs.includes(job.id)) {
    index.jobs.push(job.id);
    await writeJsonAtomic(indexPath, index);
  }
}

export async function deleteImportJobsForDie(dataRoot: string, dieId: string) {
  const indexPath = path.join(dataRoot, "jobs", "index.json");
  const index = await readJson<ImportJobIndex>(indexPath, EMPTY_JOB_INDEX);
  const jobs = await Promise.all(index.jobs.map(async (jobId) => ({
    jobId,
    job: await readImportJob(dataRoot, jobId)
  })));

  const jobsToDelete = jobs.filter(({ job }) => job.dieId === dieId);
  await Promise.all(
    jobsToDelete.map(({ jobId }) =>
      fs.rm(path.join(dataRoot, "jobs", `${jobId}.json`), { force: true })
    )
  );

  if (jobsToDelete.length > 0) {
    const remainingJobs = index.jobs.filter(
      (jobId) => !jobsToDelete.some((job) => job.jobId === jobId)
    );
    await writeJsonAtomic(
      indexPath,
      { jobs: remainingJobs }
    );
  }
}

// ── ML inference jobs (one per die, keyed by dieId) ───────────────

export async function readMLJob(
  dataRoot: string,
  dieId: string
): Promise<MLInferenceJob | null> {
  return readJson<MLInferenceJob | null>(
    path.join(dataRoot, "ml-jobs", `${dieId}.json`),
    null
  );
}

/** Every persisted ML inference job (one per die). */
export async function listMLJobs(
  dataRoot: string
): Promise<MLInferenceJob[]> {
  const dir = path.join(dataRoot, "ml-jobs");
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const jobs = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<MLInferenceJob | null>(path.join(dir, f), null))
  );
  return jobs.filter((j): j is MLInferenceJob => j !== null);
}

export async function writeMLJob(
  dataRoot: string,
  job: MLInferenceJob
): Promise<void> {
  await fs.mkdir(path.join(dataRoot, "ml-jobs"), { recursive: true });
  // A sweep persists progress on every tick without awaiting, so the writes
  // must be atomic or one body could be partially overwritten by another.
  await writeJsonAtomic(path.join(dataRoot, "ml-jobs", `${job.dieId}.json`), job);
}

/** Drop every persisted ML job — used when the model changes (the old jobs'
 *  progress no longer reflects the new checkpoint's cache). */
export async function clearMLJobs(dataRoot: string): Promise<void> {
  await fs.rm(path.join(dataRoot, "ml-jobs"), { recursive: true, force: true });
  await fs.mkdir(path.join(dataRoot, "ml-jobs"), { recursive: true });
}

const EMPTY_ANNOTATIONS: DieAnnotations = {
  version: 2,
  rev: 0,
  nets: [],
  cellTypes: [],
  cells: [],
  grids: []
};

export async function readAnnotations(dataRoot: string, dieId: string): Promise<DieAnnotations> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const filePath = path.join(dir, "annotations.json");
  const data = await readJson<DieAnnotations>(filePath, EMPTY_ANNOTATIONS);
  return { ...EMPTY_ANNOTATIONS, ...data };
}

/**
 * Persist annotations and bump the monotonic revision counter. Returns the
 * new revision so callers (the WS broadcaster) can include it in the change
 * notification.
 */
export async function writeAnnotations(
  dataRoot: string,
  dieId: string,
  annotations: DieAnnotations
): Promise<number> {
  const nextRev = (annotations.rev ?? 0) + 1;
  const stamped: DieAnnotations = { ...annotations, rev: nextRev };
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, "annotations.json"), stamped);
  return nextRev;
}

// Per-die mutex: serializes any read-modify-write cycle on a die's files.
// In-process only (single Node instance). Reads via readAnnotations are not
// gated since writes go through writeJsonAtomic — a concurrent reader sees
// either pre- or post-write content, never torn JSON.
const dieLocks = new Map<string, Promise<unknown>>();

export async function withDieLock<T>(dieId: string, fn: () => Promise<T>): Promise<T> {
  const previous = dieLocks.get(dieId) ?? Promise.resolve();
  let releaseNext!: () => void;
  const next = previous.then(
    () => new Promise<void>((resolve) => {
      releaseNext = resolve;
    })
  );
  dieLocks.set(dieId, next);

  await previous;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (dieLocks.get(dieId) === next) {
      dieLocks.delete(dieId);
    }
  }
}

/** Build a degraded DieRecord for a folder project whose directory is
 *  missing, from the last-known snapshot stored on its shortcut. */
function snapshotRecord(
  dieId: string,
  folderPath: string,
  snapshot: { name: string; width: number; height: number; originalFilename: string; createdAt: string }
): DieRecord {
  return {
    id: dieId,
    name: snapshot.name,
    originalFilename: snapshot.originalFilename,
    originalPath: "",
    width: snapshot.width,
    height: snapshot.height,
    tileSize: 0,
    tileFormat: "jpg",
    maxZoomLevel: 0,
    levels: [],
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.createdAt,
    location: "folder",
    folderPath
  };
}

async function readJson<T>(filePath: string, fallback?: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonIfMissing(filePath: string, value: unknown) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await writeJsonAtomic(filePath, value);
  }
}
