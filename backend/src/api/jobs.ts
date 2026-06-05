import { Router } from "express";
import { listImportJobs, readImportJob } from "../store.js";
import type { ImportJobRecord } from "../types.js";

export function createJobsRouter(config: { dataRoot: string }) {
  const router = Router();

  router.get("/api/import-jobs", async (_request, response, next) => {
    try {
      const jobs = await listImportJobs(config.dataRoot);
      response.json(jobs.map(toPublicImportJob));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/import-jobs/:jobId", async (request, response, next) => {
    try {
      const job = await readImportJob(config.dataRoot, request.params.jobId);
      response.json(toPublicImportJob(job));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function toPublicImportJob(job: ImportJobRecord) {
  const { inputFilePath, ...publicJob } = job;
  return publicJob;
}
