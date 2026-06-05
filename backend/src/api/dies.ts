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
import type { DieRecord } from "../types.js";
import { toPublicImportJob } from "./jobs.js";

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
        records.map((record) => toSummary(record, config.tileScheduler.getProgress(record.id)))
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId", async (request, response, next) => {
    try {
      const record = await readDieRecord(config.dataRoot, request.params.dieId);
      response.json(toPublicRecord(record, config.tileScheduler.getProgress(record.id)));
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

    try {
      await ensureDataStore(config.dataRoot);
      const job = await config.importJobManager.enqueueImportJob(request.file);
      response.status(202).json(toPublicImportJob(job));
    } catch (error) {
      next(error);
    } finally {
      await fs.rm(request.file.path, { force: true });
    }
  });

  return router;
}

function toSummary(
  record: DieRecord,
  tileProgress: ReturnType<ReturnType<typeof createTileScheduler>["getProgress"]>
) {
  const { originalPath, levels, tileFormat, ...summary } = record;
  return tileProgress ? { ...summary, tileProgress } : summary;
}

function toPublicRecord(
  record: DieRecord,
  tileProgress: ReturnType<ReturnType<typeof createTileScheduler>["getProgress"]>
) {
  const { originalPath, ...publicRecord } = record;
  return tileProgress ? { ...publicRecord, tileProgress } : publicRecord;
}
