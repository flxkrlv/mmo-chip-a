import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import type { createImportJobManager } from "../dieImport/jobs.js";
import {
  deleteDieRecord,
  deleteImportJobsForDie,
  ensureDataStore,
  listDieRecords,
  readDieRecord
} from "../store.js";
import type { createTileScheduler } from "../tileScheduler.js";
import { resolveProjectDir } from "../projectLayout.js";
import type { DieRecord } from "../types.js";
import type { DieTileInfo, OverlayTileProgress, ProjectStorageUsage } from "shared";
import { toPublicImportJob } from "./jobs.js";
import {
  getOverlayTileProgress,
  pauseOverlayPrebuilds,
  resumeOverlayPrebuilds
} from "./overlayImages.js";

export function createDiesRouter(config: {
  dataRoot: string;
  tileScheduler: ReturnType<typeof createTileScheduler>;
  importJobManager: ReturnType<typeof createImportJobManager>;
}) {
  const router = Router();
  const uploadDirectory = path.join(config.dataRoot, "tmp");
  const upload = multer({ dest: uploadDirectory });

  router.get("/api/dies", async (_request, response, next) => {
    try {
      const records = await listDieRecords(config.dataRoot);
      response.json(
        await Promise.all(records.map(async (record) => {
          const resolved = await resolveProjectDir(config.dataRoot, record.id);
          return toSummary(
            record,
            config.tileScheduler.getProgress(record.id),
            await getOverlayTileProgress(config.dataRoot, record.id),
            { available: resolved.available, folderPath: resolved.kind === "folder" ? resolved.dir : undefined }
          );
        }))
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/tile-info", async (request, response, next) => {
    try {
      const record = await readDieRecord(config.dataRoot, request.params.dieId);
      const overlayTileProgress = await withOverlaySourceStorage(
        config.dataRoot,
        record.id,
        await getOverlayTileProgress(config.dataRoot, record.id)
      );
      const responseBody: DieTileInfo = {
        dieId: record.id,
        baseTileProgress: config.tileScheduler.getProgress(record.id) ?? null,
        overlayTileProgress,
        storage: await measureProjectStorage(config.dataRoot, record.id)
      };
      response.json(responseBody);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId", async (request, response, next) => {
    try {
      const record = await readDieRecord(config.dataRoot, request.params.dieId);
      const resolved = await resolveProjectDir(config.dataRoot, record.id);
      response.json(
        toPublicRecord(
          record,
          config.tileScheduler.getProgress(record.id),
          await getOverlayTileProgress(config.dataRoot, record.id),
          { available: resolved.available, folderPath: resolved.kind === "folder" ? resolved.dir : undefined }
        )
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/dies/:dieId/tiles/prebuild", async (request, response, next) => {
    try {
      const record = await readDieRecord(config.dataRoot, request.params.dieId);
      config.tileScheduler.resumeBackground(record);
      response.status(202).json({
        ok: true,
        tileProgress: config.tileScheduler.getProgress(record.id)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/dies/:dieId/tiles/pause", async (request, response, next) => {
    try {
      const record = await readDieRecord(config.dataRoot, request.params.dieId);
      const tileProgress = config.tileScheduler.pauseBackground(record.id);
      pauseOverlayPrebuilds(record.id);
      response.json({
        ok: true,
        tileProgress,
        overlayTileProgress: await getOverlayTileProgress(config.dataRoot, record.id)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/dies/:dieId/tiles/resume", async (request, response, next) => {
    try {
      const record = await readDieRecord(config.dataRoot, request.params.dieId);
      const tileProgress = config.tileScheduler.resumeBackground(record);
      await resumeOverlayPrebuilds(config.dataRoot, record.id);
      response.status(202).json({
        ok: true,
        tileProgress,
        overlayTileProgress: await getOverlayTileProgress(config.dataRoot, record.id)
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/dies/:dieId", async (request, response, next) => {
    try {
      const record = await readDieRecord(config.dataRoot, request.params.dieId);
      await config.tileScheduler.removeDie(record.id);
      await deleteDieRecord(config.dataRoot, record.id);
      await deleteImportJobsForDie(config.dataRoot, record.id);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/dies/import", upload.single("file"), async (request, response, next) => {
    if (!request.file) {
      response.status(400).send("Expected one uploaded file.");
      return;
    }

    const targetFolder =
      typeof request.body?.targetFolder === "string" && request.body.targetFolder.trim()
        ? request.body.targetFolder.trim()
        : undefined;

    try {
      await ensureDataStore(config.dataRoot);
      const job = await config.importJobManager.enqueueImportJob(request.file, targetFolder);
      response.status(202).json(toPublicImportJob(job));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 400 || status === 409) {
        response.status(status).json({
          error: (error as { code?: string }).code ?? "folder_error",
          message: (error as Error).message
        });
        return;
      }
      next(error);
    } finally {
      await fs.rm(request.file.path, { force: true });
    }
  });

  return router;
}

async function withOverlaySourceStorage(
  dataRoot: string,
  dieId: string,
  progress: OverlayTileProgress
): Promise<OverlayTileProgress> {
  const { overlayDir } = await resolveProjectDir(dataRoot, dieId);
  return {
    ...progress,
    sources: await Promise.all(progress.sources.map(async (source) => {
      const root = path.join(overlayDir, source.id);
      return {
        ...source,
        originalBytes: await measureTreeBytes(root, (file) => /[\\/]original\.(?:png|jpe?g|webp)$/i.test(file)),
        tileBytes: await measureTreeBytes(path.join(root, "tiles"), (file) =>
          /[\\/]\d+[\\/]\d+_\d+\.(?:jpg|png)$/i.test(file)
        )
      };
    }))
  };
}

async function measureProjectStorage(dataRoot: string, dieId: string): Promise<ProjectStorageUsage> {
  const { dir: dieRoot, overlayDir: overlayRoot } = await resolveProjectDir(dataRoot, dieId);
  const baseTileBytes = await measureTreeBytes(path.join(dieRoot, "tiles"));
  const overlayTileBytes = await measureTreeBytes(overlayRoot, (file) =>
    /[\\/]tiles[\\/]\d+[\\/]\d+_\d+\.(?:jpg|png)$/i.test(file)
  );
  const overlayOriginalBytes = await measureTreeBytes(overlayRoot, (file) =>
    /[\\/]original\.(?:png|jpe?g|webp)$/i.test(file)
  );
  const dieBytes = await measureTreeBytes(dieRoot);
  const overlayBytes = await measureTreeBytes(overlayRoot);
  const totalBytes = dieBytes + overlayBytes;
  return {
    totalBytes,
    dieBytes,
    baseTileBytes,
    overlayOriginalBytes,
    overlayTileBytes,
    otherProjectBytes: Math.max(0, totalBytes - baseTileBytes - overlayOriginalBytes - overlayTileBytes)
  };
}

async function measureTreeBytes(
  root: string,
  include: (path: string) => boolean = () => true
): Promise<number> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) total += await measureTreeBytes(entryPath, include);
    else if (entry.isFile() && include(entryPath)) total += (await fs.stat(entryPath)).size;
  }
  return total;
}

function toSummary(
  record: DieRecord,
  tileProgress: ReturnType<ReturnType<typeof createTileScheduler>["getProgress"]>,
  overlayTileProgress: Awaited<ReturnType<typeof getOverlayTileProgress>>,
  location?: { available: boolean; folderPath?: string }
) {
  const { originalPath, levels, tileFormat, ...summary } = record;
  return {
    ...summary,
    location: record.location ?? "managed",
    available: location?.available ?? true,
    ...(location?.folderPath ? { folderPath: location.folderPath } : {}),
    ...(tileProgress ? { tileProgress } : {}),
    ...(overlayTileProgress.totalTiles > 0 ? { overlayTileProgress } : {})
  };
}

function toPublicRecord(
  record: DieRecord,
  tileProgress: ReturnType<ReturnType<typeof createTileScheduler>["getProgress"]>,
  overlayTileProgress: Awaited<ReturnType<typeof getOverlayTileProgress>>,
  location?: { available: boolean; folderPath?: string }
) {
  const { originalPath, ...publicRecord } = record;
  return {
    ...publicRecord,
    location: record.location ?? "managed",
    available: location?.available ?? true,
    ...(location?.folderPath ? { folderPath: location.folderPath } : {}),
    ...(tileProgress ? { tileProgress } : {}),
    ...(overlayTileProgress.totalTiles > 0 ? { overlayTileProgress } : {})
  };
}
