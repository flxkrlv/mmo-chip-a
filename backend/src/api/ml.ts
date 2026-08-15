import { promises as fs } from "node:fs";
import path from "node:path";
import { Router, type Request } from "express";
import sharp from "sharp";
import type {
  AKAZEReverifyRequest,
  CVMatchRequest,
  CVMatchResponse,
  CVMatchResult,
  MLJobStatus,
  MLModelsResponse,
  MLPrediction,
  MLSelectModelRequest,
  MLServiceStatus,
  MLTrainRequest,
  MLViasTileResult,
  MLViasTilesResponse
} from "shared";
import { createMLJobManager } from "../ml/jobs.js";
import { resolveOverlayOriginalPath } from "./overlayImages.js";
import {
  createMLPredictor,
  INFERENCE_MIN_DISTANCE,
  INFERENCE_THRESHOLD,
  resolveTile,
  SidecarUnavailable,
  toPrediction
} from "../ml/predict.js";
import { clearMLJobs, readAnnotations, readDieRecord } from "../store.js";
import type { AnnotationBroadcaster } from "../ws.js";

const HEALTH_TIMEOUT_MS = 3000;
const SIDECAR_RW_TIMEOUT_MS = 10000;
/** Hard cap on a single batched range request (the frontend fetches in
 *  blocks well under this; the cap just guards against a pathological URL). */
const MAX_RANGE_TILES = 4096;

async function fetchSidecar(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRequestedOverlayPath(params: {
  request: Request;
  dataRoot: string;
  dieId: string;
  sourceId: string | undefined;
}): Promise<string | undefined> {
  if (!params.sourceId) return undefined;
  return (await resolveOverlayOriginalPath({
    dataRoot: params.dataRoot,
    dieId: params.dieId,
    sourceId: params.sourceId
  })) ?? undefined;
}

export function createMLRouter(config: {
  mlSidecarUrl: string;
  dataRoot: string;
  mlPredictPad: number;
  broadcaster?: AnnotationBroadcaster;
}) {
  const router = Router();
  const predictor = createMLPredictor(config);
  const jobs = createMLJobManager({
    dataRoot: config.dataRoot,
    predictor,
    onJobChange: (job) => config.broadcaster?.emitMLJob(job)
  });

  function send503IfUnavailable(
    error: unknown,
    response: import("express").Response
  ): boolean {
    if (error instanceof SidecarUnavailable) {
      response.status(503).json({ error: error.message });
      return true;
    }
    return false;
  }

  // ── GET /api/ml/status ──────────────────────────────────────────────
  router.get("/api/ml/status", async (_request, response) => {
    try {
      const res = await fetchSidecar(
        `${config.mlSidecarUrl}/health`,
        HEALTH_TIMEOUT_MS
      );
      if (!res.ok) {
        response.json({ reachable: false } satisfies MLServiceStatus);
        return;
      }
      const body = (await res.json()) as Record<string, unknown>;
      response.json({
        reachable: true,
        status: body.status as string,
        device: body.device as string,
        checkpoint: (body.checkpoint as string | null) ?? null,
        checkpointHash: (body.checkpoint_hash as string | null) ?? null,
        encoder: body.encoder as string,
        modelLoaded: Boolean(body.model_loaded),
        trainingActive: Boolean(body.training_active)
      } satisfies MLServiceStatus);
    } catch {
      response.json({ reachable: false } satisfies MLServiceStatus);
    }
  });

  // ── GET /api/ml/models ──────────────────────────────────────────────
  router.get("/api/ml/models", async (_request, response, next) => {
    try {
      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/models`,
          HEALTH_TIMEOUT_MS
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (!res.ok) {
        response.status(502).json({ error: `sidecar /models ${res.status}` });
        return;
      }
      const body = (await res.json()) as {
        models?: {
          name: string;
          hash: string | null;
          size_bytes: number;
          resident: boolean;
        }[];
      };
      response.json({
        models: (body.models ?? []).map((m) => ({
          name: m.name,
          hash: m.hash ?? null,
          sizeBytes: m.size_bytes,
          resident: m.resident
        }))
      } satisfies MLModelsResponse);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/model { name } ─────────────────────────────────────
  // Switches the sidecar's resident checkpoint. Every cached prediction is
  // tied to the old checkpoint, so we wipe the prediction cache + ML jobs.
  router.post("/api/ml/model", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<MLSelectModelRequest>;
      if (!body.name || typeof body.name !== "string") {
        response.status(400).json({ error: "name is required" });
        return;
      }
      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/model/reload`,
          SIDECAR_RW_TIMEOUT_MS,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ checkpoint_path: `checkpoints/${body.name}` })
          }
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (res.status === 409) {
        response
          .status(409)
          .json({ error: "cannot switch model while training" });
        return;
      }
      if (!res.ok) {
        const detail = await res.text();
        response
          .status(502)
          .json({ error: `sidecar /model/reload ${res.status}`, detail });
        return;
      }
      await fs.rm(path.join(config.dataRoot, "predictions"), {
        recursive: true,
        force: true
      });
      await clearMLJobs(config.dataRoot);
      predictor.clearMemCache();
      const data = (await res.json()) as {
        checkpoint: string | null;
        checkpoint_hash: string | null;
        model_loaded: boolean;
      };
      response.json({
        checkpoint: data.checkpoint,
        checkpointHash: data.checkpoint_hash,
        modelLoaded: data.model_loaded
      });
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/ml/inference-jobs ──────────────────────────────────────
  // All per-die inference jobs — drives the library page's status badges.
  router.get("/api/ml/inference-jobs", async (_request, response, next) => {
    try {
      response.json(await jobs.listJobs());
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/dies/:dieId/ml/job ─────────────────────────────────────
  router.get("/api/dies/:dieId/ml/job", async (request, response, next) => {
    try {
      response.json(await jobs.getJob(request.params.dieId));
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/dies/:dieId/ml/job/start ──────────────────────────────
  router.post(
    "/api/dies/:dieId/ml/job/start",
    async (request, response, next) => {
      try {
        const body = (request.body ?? {}) as { overlayFilename?: string };
        const overlayFilename = typeof body.overlayFilename === "string" && body.overlayFilename.length > 0
          ? body.overlayFilename
          : undefined;
        response.json(await jobs.startJob(request.params.dieId, overlayFilename));
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        next(error);
      }
    }
  );

  // ── POST /api/dies/:dieId/ml/job/stop ───────────────────────────────
  router.post(
    "/api/dies/:dieId/ml/job/stop",
    async (request, response, next) => {
      try {
        response.json(await jobs.stopJob(request.params.dieId));
      } catch (error) {
        next(error);
      }
    }
  );

  function overlayKey(overlaySource: string | undefined): string | undefined {
    return overlaySource ? overlaySource.replace(/[^a-zA-Z0-9_\-.]/g, "_") : undefined;
  }

  // ── GET /api/dies/:dieId/vias/tile/:z/:x/:y (cached) ────────────────
  router.get(
    "/api/dies/:dieId/vias/tile/:z/:x/:y",
    async (request, response, next) => {
      try {
        const { dieId } = request.params;
        const z = Number(request.params.z);
        const tx = Number(request.params.x);
        const ty = Number(request.params.y);
        if (![z, tx, ty].every(Number.isInteger)) {
          response.status(400).json({ error: "Invalid tile coordinates" });
          return;
        }
        const overlaySource = typeof request.query.overlaySource === "string"
          ? request.query.overlaySource
          : undefined;
        const ovKey = overlayKey(overlaySource);
        const record = await readDieRecord(config.dataRoot, dieId);
        const resolved = resolveTile(record, z, tx, ty);
        if (resolved.kind === "non-native") {
          response.json({
            pointVias: [],
            irregularVias: [],
            traces: [],
            bbox: [0, 0, 0, 0],
            checkpointHash: null,
            overlayFilename: overlaySource ?? null
          } satisfies MLPrediction);
          return;
        }
        if (resolved.kind === "oob") {
          response.status(404).json({ error: "Tile out of range" });
          return;
        }
        const box = resolved.box;

        const cachedOnly =
          request.query.cachedOnly === "1" ||
          request.query.cachedOnly === "true";

        let checkpointHash: string | null;
        try {
          checkpointHash = await predictor.getCheckpointHash();
        } catch (error) {
          if (cachedOnly) {
            response.status(204).end();
            return;
          }
          if (send503IfUnavailable(error, response)) return;
          throw error;
        }

        const cachedTile = await predictor.readCachedTile(
          dieId,
          checkpointHash,
          z,
          tx,
          ty,
          ovKey
        );
        if (cachedTile) {
          response.json(cachedTile);
          return;
        }

        if (cachedOnly) {
          response.status(204).end();
          return;
        }

        const overlayPath = await resolveRequestedOverlayPath({
          request,
          dataRoot: config.dataRoot,
          dieId,
          sourceId: overlaySource
        });
        if (overlaySource && !overlayPath) {
          response.status(404).json({ error: "Visible image source not found" });
          return;
        }

        let result: Awaited<ReturnType<typeof predictor.runPrediction>>;
        try {
          result = await predictor.runPrediction({
            originalPath: record.originalPath,
            dieWidth: record.width,
            dieHeight: record.height,
            keep: box,
            threshold: INFERENCE_THRESHOLD,
            minDistance: INFERENCE_MIN_DISTANCE,
            wantHeatmap: false,
            overlayPath
          });
        } catch (error) {
          if (send503IfUnavailable(error, response)) return;
          throw error;
        }

        const prediction = toPrediction(result, box, checkpointHash, overlaySource);
        await predictor.writeCachedTile(dieId, checkpointHash, z, tx, ty, prediction, ovKey);
        response.json(prediction);
      } catch (error) {
        next(error);
      }
    }
  );

  // ── GET /api/dies/:dieId/vias/tiles?z&x0&y0&x1&y1 (cached, batched) ──
  // One request for a whole native-tile range — replaces N per-tile calls
  // when the overlay loads a zoomed-out view. Cached-only by nature: a tile
  // with no cached prediction is omitted from `tiles`.
  router.get("/api/dies/:dieId/vias/tiles", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const z = Number(request.query.z);
      const x0 = Number(request.query.x0);
      const y0 = Number(request.query.y0);
      const x1 = Number(request.query.x1);
      const y1 = Number(request.query.y1);
      if (![z, x0, y0, x1, y1].every(Number.isInteger)) {
        response
          .status(400)
          .json({ error: "z, x0, y0, x1, y1 (tile coords) required" });
        return;
      }
      const overlaySource = typeof request.query.overlaySource === "string"
        ? request.query.overlaySource
        : undefined;
      const ovKey = overlayKey(overlaySource);
      const record = await readDieRecord(config.dataRoot, dieId);
      if (z !== record.maxZoomLevel) {
        response.json({
          z,
          checkpointHash: null,
          tiles: []
        } satisfies MLViasTilesResponse);
        return;
      }
      const level = record.levels.find((l) => l.z === z);
      const cols = level?.columns ?? Math.ceil(record.width / record.tileSize);
      const rows = level?.rows ?? Math.ceil(record.height / record.tileSize);
      const minTx = Math.max(0, Math.min(x0, x1));
      const minTy = Math.max(0, Math.min(y0, y1));
      const maxTx = Math.min(cols - 1, Math.max(x0, x1));
      const maxTy = Math.min(rows - 1, Math.max(y0, y1));

      let checkpointHash: string | null;
      try {
        checkpointHash = await predictor.getCheckpointHash();
      } catch {
        response.json({
          z,
          checkpointHash: null,
          tiles: []
        } satisfies MLViasTilesResponse);
        return;
      }

      const coords: { tx: number; ty: number }[] = [];
      for (let ty = minTy; ty <= maxTy; ty += 1) {
        for (let tx = minTx; tx <= maxTx; tx += 1) coords.push({ tx, ty });
      }
      if (coords.length > MAX_RANGE_TILES) {
        response.status(400).json({
          error: `range too large (${coords.length} > ${MAX_RANGE_TILES})`
        });
        return;
      }

      const results = await Promise.all(
        coords.map(async ({ tx, ty }) => {
          const prediction = await predictor.readCachedTile(
            dieId,
            checkpointHash,
            z,
            tx,
            ty,
            ovKey
          );
          return prediction ? { x: tx, y: ty, prediction } : null;
        })
      );
      response.json({
        z,
        checkpointHash,
        tiles: results.filter((t): t is MLViasTileResult => t !== null)
      } satisfies MLViasTilesResponse);
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/dies/:dieId/vias?bbox=x0,y0,x1,y1 (uncached) ───────────
  router.get("/api/dies/:dieId/vias", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const parts = String(request.query.bbox ?? "")
        .split(",")
        .map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        response.status(400).json({ error: "bbox must be x0,y0,x1,y1" });
        return;
      }
      const overlaySource = typeof request.query.overlaySource === "string"
        ? request.query.overlaySource
        : undefined;
      const record = await readDieRecord(config.dataRoot, dieId);
      const x0 = Math.max(0, Math.min(parts[0], parts[2]));
      const y0 = Math.max(0, Math.min(parts[1], parts[3]));
      const x1 = Math.min(record.width, Math.max(parts[0], parts[2]));
      const y1 = Math.min(record.height, Math.max(parts[1], parts[3]));
      if (x1 <= x0 || y1 <= y0) {
        response.status(400).json({ error: "Empty or out-of-bounds bbox" });
        return;
      }

      let checkpointHash: string | null;
      try {
        checkpointHash = await predictor.getCheckpointHash();
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        throw error;
      }

      const overlayPath = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlaySource
      });
      if (overlaySource && !overlayPath) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }

      let result: Awaited<ReturnType<typeof predictor.runPrediction>>;
      try {
        result = await predictor.runPrediction({
          originalPath: record.originalPath,
          dieWidth: record.width,
          dieHeight: record.height,
          keep: [x0, y0, x1, y1],
          threshold: INFERENCE_THRESHOLD,
          minDistance: INFERENCE_MIN_DISTANCE,
          wantHeatmap: false,
          overlayPath
        });
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        throw error;
      }

      response.json(
        toPrediction(result, [x0, y0, x1, y1], checkpointHash, overlaySource)
      );
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/dies/:dieId/heatmap/tile/:z/:x/:y (cached PNG) ──────────
  router.get(
    "/api/dies/:dieId/heatmap/tile/:z/:x/:y",
    async (request, response, next) => {
      try {
        const { dieId } = request.params;
        const z = Number(request.params.z);
        const tx = Number(request.params.x);
        const ty = Number(request.params.y);
        if (![z, tx, ty].every(Number.isInteger)) {
          response.status(400).json({ error: "Invalid tile coordinates" });
          return;
        }
        const record = await readDieRecord(config.dataRoot, dieId);
        const resolved = resolveTile(record, z, tx, ty);
        if (resolved.kind === "non-native") {
          response.status(204).end();
          return;
        }
        if (resolved.kind === "oob") {
          response.status(404).json({ error: "Tile out of range" });
          return;
        }
        const box = resolved.box;

        let checkpointHash: string | null;
        try {
          checkpointHash = await predictor.getCheckpointHash();
        } catch (error) {
          if (send503IfUnavailable(error, response)) return;
          throw error;
        }

        const pngPath = path.join(
          predictor.cacheDirFor(dieId, checkpointHash),
          `${z}_${tx}_${ty}.png`
        );
        try {
          const cached = await fs.readFile(pngPath);
          response.type("image/png").send(cached);
          return;
        } catch {
          /* miss */
        }

        let result: Awaited<ReturnType<typeof predictor.runPrediction>>;
        try {
          result = await predictor.runPrediction({
            originalPath: record.originalPath,
            dieWidth: record.width,
            dieHeight: record.height,
            keep: box,
            threshold: INFERENCE_THRESHOLD,
            minDistance: INFERENCE_MIN_DISTANCE,
            wantHeatmap: true
          });
        } catch (error) {
          if (send503IfUnavailable(error, response)) return;
          throw error;
        }
        if (!result.heatmapTilePng) {
          response.status(502).json({ error: "sidecar returned no heatmap" });
          return;
        }

        // One forward pass yielded both — write the prediction through the
        // predictor so the mem cache is warmed (an `fs.access` guard is
        // cheaper than re-encoding JSON, but `writeCachedTile` is idempotent
        // and the extra disk write is negligible vs. the inference itself).
        await predictor.writeCachedTile(
          dieId,
          checkpointHash,
          z,
          tx,
          ty,
          toPrediction(result, box, checkpointHash)
        );
        await predictor.atomicWrite(pngPath, result.heatmapTilePng);
        response.type("image/png").send(result.heatmapTilePng);
      } catch (error) {
        next(error);
      }
    }
  );

  // ── GET /api/dies/:dieId/heatmap?bbox=x0,y0,x1,y1 (uncached PNG) ────
  router.get("/api/dies/:dieId/heatmap", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const parts = String(request.query.bbox ?? "")
        .split(",")
        .map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        response.status(400).json({ error: "bbox must be x0,y0,x1,y1" });
        return;
      }
      const record = await readDieRecord(config.dataRoot, dieId);
      const x0 = Math.max(0, Math.min(parts[0], parts[2]));
      const y0 = Math.max(0, Math.min(parts[1], parts[3]));
      const x1 = Math.min(record.width, Math.max(parts[0], parts[2]));
      const y1 = Math.min(record.height, Math.max(parts[1], parts[3]));
      if (x1 <= x0 || y1 <= y0) {
        response.status(400).json({ error: "Empty or out-of-bounds bbox" });
        return;
      }

      try {
        await predictor.getCheckpointHash();
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        throw error;
      }

      let result: { heatmapTilePng?: Buffer };
      try {
        result = await predictor.runPrediction({
          originalPath: record.originalPath,
          dieWidth: record.width,
          dieHeight: record.height,
          keep: [x0, y0, x1, y1],
          threshold: INFERENCE_THRESHOLD,
          minDistance: INFERENCE_MIN_DISTANCE,
          wantHeatmap: true
        });
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        throw error;
      }
      if (!result.heatmapTilePng) {
        response.status(502).json({ error: "sidecar returned no heatmap" });
        return;
      }
      response.type("image/png").send(result.heatmapTilePng);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/train ──────────────────────────────────────────────
  router.post("/api/ml/train", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<MLTrainRequest>;
      if (!body.dataDir || typeof body.dataDir !== "string") {
        response.status(400).json({ error: "dataDir is required" });
        return;
      }
      const sidecarBody: Record<string, unknown> = { data_dir: body.dataDir };
      if (body.epochs != null) sidecarBody.epochs = body.epochs;
      if (body.encoder != null) sidecarBody.encoder = body.encoder;
      if (body.lr != null) sidecarBody.lr = body.lr;
      if (body.cropSize != null) sidecarBody.crop_size = body.cropSize;
      if (body.stepsPerEpoch != null)
        sidecarBody.steps_per_epoch = body.stepsPerEpoch;
      if (body.batchSize != null) sidecarBody.batch_size = body.batchSize;
      if (body.output != null) sidecarBody.output = body.output;

      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/train`,
          SIDECAR_RW_TIMEOUT_MS,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(sidecarBody)
          }
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (res.status === 409) {
        response.status(409).json({ error: "training already in progress" });
        return;
      }
      if (!res.ok) {
        const detail = await res.text();
        response
          .status(502)
          .json({ error: `sidecar /train ${res.status}`, detail });
        return;
      }
      const data = (await res.json()) as { job_id: string };
      response.status(202).json({ jobId: data.job_id });
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/ml/jobs/:jobId ─────────────────────────────────────────
  router.get("/api/ml/jobs/:jobId", async (request, response, next) => {
    try {
      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/jobs/${encodeURIComponent(
            request.params.jobId
          )}`,
          HEALTH_TIMEOUT_MS
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (res.status === 404) {
        response.status(404).json({ error: "job not found" });
        return;
      }
      if (!res.ok) {
        response.status(502).json({ error: `sidecar /jobs ${res.status}` });
        return;
      }
      const j = (await res.json()) as Record<string, unknown>;
      response.json({
        jobId: j.job_id as string,
        kind: j.kind as MLJobStatus["kind"],
        status: j.status as MLJobStatus["status"],
        epoch: j.epoch as number,
        epochs: j.epochs as number,
        loss: (j.loss as number | null) ?? null,
        checkpointPath: (j.checkpoint_path as string | null) ?? null,
        error: (j.error as string | null) ?? null,
        startedAt: j.started_at as string,
        updatedAt: j.updated_at as string
      } satisfies MLJobStatus);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/cv/match ────────────────────────────────────────────
  router.post("/api/ml/cv/match", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<CVMatchRequest>;
      if (!body.dieId || !body.cellTypeId) {
        response.status(400).json({ error: "dieId and cellTypeId are required" });
        return;
      }
      const { dieId, cellTypeId } = body;

      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) {
        response.status(404).json({ error: "cellType not found" });
        return;
      }

      // Cell position on die — cropRect is cell-local (x:0, y:0), so add cell's die position
      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);

      // Determine source image
      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;

      const sourceMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const sW = sourceMeta.width ?? record.width;
      const sH = sourceMeta.height ?? record.height;

      // Clamp crop to image bounds
      const refLeft = Math.max(0, cx0);
      const refTop = Math.max(0, cy0);
      const refW = Math.min(cx1 - cx0, Math.max(0, sW - refLeft));
      const refH = Math.min(cy1 - cy0, Math.max(0, sH - refTop));
      if (refW <= 0 || refH <= 0) {
        response.status(400).json({ error: "reference crop outside image bounds" });
        return;
      }

      // Send search image + reference bbox to sidecar (single preprocessing)
      const searchBuf = await sharp(sourcePath, { limitInputPixels: false })
        .png()
        .toBuffer();

      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("ref_x", String(refLeft));
      fd.append("ref_y", String(refTop));
      fd.append("ref_w", String(refW));
      fd.append("ref_h", String(refH));
      const contourParams: [string, string | undefined][] = [
        ["threshold", body.threshold?.toFixed(4)],
        ["max_matches", body.maxMatches?.toFixed(0)],
        ["detection_mode", body.detectionMode],
        ["gradient_kernel", body.gradientKernel?.toFixed(0)],
        ["min_area", body.minArea?.toFixed(0)],
        ["min_distance", body.minDistance?.toFixed(0)],
        ["area_lo", body.areaLo?.toFixed(4)],
        ["area_hi", body.areaHi?.toFixed(4)],
        ["aspect_thresh", body.aspectThresh?.toFixed(4)],
        ["merge_dist_px", body.mergeDistPx?.toFixed(2)],
        ["merge_area_ratio", body.mergeAreaRatio?.toFixed(4)],
        ["efd_harmonics", body.efdHarmonics?.toFixed(0)],
        ["fuzzy_thresh", body.fuzzyThresh?.toFixed(4)],
        ["min_ref_children", body.minRefChildren?.toFixed(0)],
        ["struct_thresh", body.structThresh?.toFixed(4)],
        ["rotation_min_matches", body.rotationMinMatches?.toFixed(0)],
        ["w_shape", body.wShape?.toFixed(4)],
        ["w_area", body.wArea?.toFixed(4)],
        ["w_bbox", body.wBbox?.toFixed(4)],
        ["w_pos", body.wPos?.toFixed(4)],
      ];
      for (const [key, val] of contourParams) {
        if (val != null) fd.append(key, val);
      }

      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(
          `${config.mlSidecarUrl}/cv/match`,
          120000, // 2 min timeout for full-die search
          { method: "POST", body: fd }
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (!sidecarRes.ok) {
        const detail = await sidecarRes.text();
        response.status(502).json({ error: `sidecar /cv/match ${sidecarRes.status}`, detail });
        return;
      }

      const sidecarBody = (await sidecarRes.json()) as {
        matches: { x: number; y: number; rotation: number; confidence: number; bbox: [number, number, number, number] }[];
        total: number;
      };

      // Translate matches back to die-global coords.
      // The search image is the full source at its native coordinates, so the
      // sidecar returns coords in source-image pixel space — already die-global
      // when the overlay is at the same resolution as the base image.
      const scaleX = overlayFilename ? (cx1 - cx0) / (cx1 - cx0) : 1; // no scale
      const matches: CVMatchResult[] = sidecarBody.matches.map((m) => ({
        x: m.x,
        y: m.y,
        rotation: (m.rotation as 0 | 90 | 180 | 270) || 0,
        confidence: m.confidence,
        bbox: [m.bbox[0], m.bbox[1], m.bbox[2], m.bbox[3]],
      }));

      response.json({
        matches,
        referenceBbox: [cx0, cy0, cx1, cy1],
        searchRegion: [0, 0, sW, sH],
        total: sidecarBody.total,
      } satisfies CVMatchResponse);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/cv/debug ─────────────────────────────────────────
  router.post("/api/ml/cv/debug", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<CVMatchRequest>;
      if (!body.dieId || !body.cellTypeId) {
        response.status(400).json({ error: "dieId and cellTypeId are required" });
        return;
      }
      const { dieId, cellTypeId } = body;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) {
        response.status(404).json({ error: "cellType not found" });
        return;
      }

      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);

      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;

      const debugMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const dW = debugMeta.width ?? record.width;
      const dH = debugMeta.height ?? record.height;
      const refLeftD = Math.max(0, cx0);
      const refTopD = Math.max(0, cy0);
      const refWD = Math.min(cx1 - cx0, Math.max(0, dW - refLeftD));
      const refHD = Math.min(cy1 - cy0, Math.max(0, dH - refTopD));
      if (refWD <= 0 || refHD <= 0) {
        response.status(400).json({ error: "reference crop outside image bounds" });
        return;
      }

      const searchBuf = await sharp(sourcePath, { limitInputPixels: false })
        .png()
        .toBuffer();

      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("ref_x", String(refLeftD));
      fd.append("ref_y", String(refTopD));
      fd.append("ref_w", String(refWD));
      fd.append("ref_h", String(refHD));
      const contourParams: [string, string | undefined][] = [
        ["threshold", body.threshold?.toFixed(4)],
        ["max_matches", body.maxMatches?.toFixed(0)],
        ["detection_mode", body.detectionMode],
        ["gradient_kernel", body.gradientKernel?.toFixed(0)],
        ["min_area", body.minArea?.toFixed(0)],
        ["min_distance", body.minDistance?.toFixed(0)],
        ["area_lo", body.areaLo?.toFixed(4)],
        ["area_hi", body.areaHi?.toFixed(4)],
        ["aspect_thresh", body.aspectThresh?.toFixed(4)],
        ["merge_dist_px", body.mergeDistPx?.toFixed(2)],
        ["merge_area_ratio", body.mergeAreaRatio?.toFixed(4)],
        ["efd_harmonics", body.efdHarmonics?.toFixed(0)],
        ["fuzzy_thresh", body.fuzzyThresh?.toFixed(4)],
        ["min_ref_children", body.minRefChildren?.toFixed(0)],
        ["struct_thresh", body.structThresh?.toFixed(4)],
        ["rotation_min_matches", body.rotationMinMatches?.toFixed(0)],
        ["w_shape", body.wShape?.toFixed(4)],
        ["w_area", body.wArea?.toFixed(4)],
        ["w_bbox", body.wBbox?.toFixed(4)],
        ["w_pos", body.wPos?.toFixed(4)],
      ];
      for (const [key, val] of contourParams) {
        if (val != null) fd.append(key, val);
      }

      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(
          `${config.mlSidecarUrl}/cv/debug`,
          120000,
          { method: "POST", body: fd }
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (!sidecarRes.ok) {
        response.status(502).json({ error: `sidecar /cv/debug ${sidecarRes.status}` });
        return;
      }

      const debugData = await sidecarRes.json();
      response.json(debugData);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/cv/debug-dump ──────────────────────────────────
  router.post("/api/ml/cv/debug-dump", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<CVMatchRequest>;
      if (!body.dieId || !body.cellTypeId) {
        response.status(400).json({ error: "dieId and cellTypeId are required" });
        return;
      }
      const { dieId, cellTypeId } = body;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) {
        response.status(404).json({ error: "cellType not found" });
        return;
      }
      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);
      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;
      const ddMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const dW = ddMeta.width ?? record.width;
      const dH = ddMeta.height ?? record.height;
      const refLeftD = Math.max(0, cx0);
      const refTopD = Math.max(0, cy0);
      const refWD = Math.min(cx1 - cx0, Math.max(0, dW - refLeftD));
      const refHD = Math.min(cy1 - cy0, Math.max(0, dH - refTopD));
      if (refWD <= 0 || refHD <= 0) {
        response.status(400).json({ error: "reference crop outside image bounds" });
        return;
      }
      const searchBuf = await sharp(sourcePath, { limitInputPixels: false }).png().toBuffer();
      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("ref_x", String(refLeftD));
      fd.append("ref_y", String(refTopD));
      fd.append("ref_w", String(refWD));
      fd.append("ref_h", String(refHD));
      const contourParams: [string, string | undefined][] = [
        ["threshold", body.threshold?.toFixed(4)],
        ["max_matches", body.maxMatches?.toFixed(0)],
        ["detection_mode", body.detectionMode],
        ["gradient_kernel", body.gradientKernel?.toFixed(0)],
        ["min_area", body.minArea?.toFixed(0)],
        ["min_distance", body.minDistance?.toFixed(0)],
        ["area_lo", body.areaLo?.toFixed(4)],
        ["area_hi", body.areaHi?.toFixed(4)],
        ["aspect_thresh", body.aspectThresh?.toFixed(4)],
        ["merge_dist_px", body.mergeDistPx?.toFixed(2)],
        ["merge_area_ratio", body.mergeAreaRatio?.toFixed(4)],
        ["efd_harmonics", body.efdHarmonics?.toFixed(0)],
        ["fuzzy_thresh", body.fuzzyThresh?.toFixed(4)],
        ["min_ref_children", body.minRefChildren?.toFixed(0)],
        ["struct_thresh", body.structThresh?.toFixed(4)],
        ["rotation_min_matches", body.rotationMinMatches?.toFixed(0)],
        ["w_shape", body.wShape?.toFixed(4)],
        ["w_area", body.wArea?.toFixed(4)],
        ["w_bbox", body.wBbox?.toFixed(4)],
        ["w_pos", body.wPos?.toFixed(4)],
      ];
      for (const [key, val] of contourParams) {
        if (val != null) fd.append(key, val);
      }

      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(
          `${config.mlSidecarUrl}/cv/debug-dump`,
          120000,
          { method: "POST", body: fd }
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (!sidecarRes.ok) {
        response.status(502).json({ error: `sidecar /cv/debug-dump ${sidecarRes.status}` });
        return;
      }
      const result = await sidecarRes.json();
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/cv/template-match ──────────────────────────────
  router.post("/api/ml/cv/template-match", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<CVMatchRequest>;
      if (!body.dieId || !body.cellTypeId) {
        response.status(400).json({ error: "dieId and cellTypeId are required" });
        return;
      }
      const { dieId, cellTypeId } = body;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) { response.status(404).json({ error: "cellType not found" }); return; }
      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);
      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;
      const tmMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const sW = tmMeta.width ?? record.width;
      const sH = tmMeta.height ?? record.height;
      const left = Math.max(0, cx0);
      const top = Math.max(0, cy0);
      const w = Math.min(cx1 - cx0, Math.max(0, sW - left));
      const h = Math.min(cy1 - cy0, Math.max(0, sH - top));
      if (w <= 0 || h <= 0) { response.status(400).json({ error: "crop outside bounds" }); return; }
      const searchBuf = await sharp(sourcePath, { limitInputPixels: false }).png().toBuffer();
      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("ref_x", String(left));
      fd.append("ref_y", String(top));
      fd.append("ref_w", String(w));
      fd.append("ref_h", String(h));
      if (body.threshold != null) fd.append("threshold", String(body.threshold));
      if (body.rotationSteps != null) fd.append("rotation_steps", String(body.rotationSteps));
      if (body.maxMatches != null) fd.append("max_matches", String(body.maxMatches));
      if (body.sobelKsize != null) fd.append("sobel_ksize", String(body.sobelKsize));
      if (body.nmsIou != null) fd.append("nms_iou", String(body.nmsIou));
      if (body.nmsDist != null) fd.append("nms_dist", String(body.nmsDist));

      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(`${config.mlSidecarUrl}/cv/template-match`, 120000, { method: "POST", body: fd });
      } catch { response.status(503).json({ error: "sidecar unreachable" }); return; }
      if (!sidecarRes.ok) { response.status(502).json({ error: `sidecar /cv/template-match ${sidecarRes.status}` }); return; }
      const data = await sidecarRes.json();
      response.json({
        matches: data.matches,
        referenceBbox: [cx0, cy0, cx1, cy1],
        searchRegion: [0, 0, sW, sH],
        total: data.total,
      } satisfies CVMatchResponse);
    } catch (error) { next(error); }
  });

  // ── POST /api/ml/cv/template-debug ─────────────────────────────
  router.post("/api/ml/cv/template-debug", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<CVMatchRequest>;
      if (!body.dieId || !body.cellTypeId) {
        response.status(400).json({ error: "dieId and cellTypeId are required" }); return;
      }
      const { dieId, cellTypeId } = body;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) { response.status(404).json({ error: "cellType not found" }); return; }
      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);
      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;
      const tmMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const sW = tmMeta.width ?? record.width;
      const sH = tmMeta.height ?? record.height;
      const left = Math.max(0, cx0); const top = Math.max(0, cy0);
      const w = Math.min(cx1 - cx0, Math.max(0, sW - left));
      const h = Math.min(cy1 - cy0, Math.max(0, sH - top));
      if (w <= 0 || h <= 0) { response.status(400).json({ error: "crop outside bounds" }); return; }
      const searchBuf = await sharp(sourcePath, { limitInputPixels: false }).png().toBuffer();
      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("ref_x", String(left)); fd.append("ref_y", String(top));
      fd.append("ref_w", String(w)); fd.append("ref_h", String(h));
      if (body.threshold != null) fd.append("threshold", String(body.threshold));
      if (body.rotationSteps != null) fd.append("rotation_steps", String(body.rotationSteps));
      if (body.maxMatches != null) fd.append("max_matches", String(body.maxMatches));
      if (body.sobelKsize != null) fd.append("sobel_ksize", String(body.sobelKsize));
      if (body.nmsIou != null) fd.append("nms_iou", String(body.nmsIou));
      if (body.nmsDist != null) fd.append("nms_dist", String(body.nmsDist));
      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(`${config.mlSidecarUrl}/cv/template-debug`, 120000, { method: "POST", body: fd });
      } catch { response.status(503).json({ error: "sidecar unreachable" }); return; }
      if (!sidecarRes.ok) { response.status(502).json({ error: `sidecar /cv/template-debug ${sidecarRes.status}` }); return; }
      const data = await sidecarRes.json();
      response.json(data);
    } catch (error) { next(error); }
  });

  // ── POST /api/ml/cv/akaze-verify ────────────────────────────────
  router.post("/api/ml/cv/akaze-verify", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<AKAZEReverifyRequest>;
      if (!body.dieId || !body.cellTypeId || !body.matches) {
        response.status(400).json({ error: "dieId, cellTypeId, and matches are required" }); return;
      }
      const { dieId, cellTypeId } = body;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) { response.status(404).json({ error: "cellType not found" }); return; }

      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;

      // Extract ref patch coords (same logic as template-match)
      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);
      const tmMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const sW = tmMeta.width ?? record.width;
      const sH = tmMeta.height ?? record.height;
      const left = Math.max(0, cx0);
      const top = Math.max(0, cy0);
      const w = Math.min(cx1 - cx0, Math.max(0, sW - left));
      const h = Math.min(cy1 - cy0, Math.max(0, sH - top));

      const searchBuf = await sharp(sourcePath, { limitInputPixels: false }).png().toBuffer();
      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("matches_json", JSON.stringify(body.matches));
      fd.append("ref_x", String(left));
      fd.append("ref_y", String(top));
      fd.append("ref_w", String(w));
      fd.append("ref_h", String(h));
      if (body.sift_threshold != null) fd.append("sift_threshold", String(body.sift_threshold));
      if (body.blur_ksize != null) fd.append("blur_ksize", String(body.blur_ksize));
      if (body.use_sobel != null) fd.append("use_sobel", String(body.use_sobel));

      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(`${config.mlSidecarUrl}/cv/akaze-verify`, 120000, { method: "POST", body: fd });
      } catch { response.status(503).json({ error: "sidecar unreachable" }); return; }
      if (!sidecarRes.ok) { response.status(502).json({ error: `sidecar /cv/akaze-verify ${sidecarRes.status}` }); return; }
      const data = await sidecarRes.json();
      response.json(data);
    } catch (error) { next(error); }
  });

  // ── POST /api/ml/cv/akaze-debug ──────────────────────────────────
  router.post("/api/ml/cv/akaze-debug", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<AKAZEReverifyRequest & { max_pairs?: number }>;
      if (!body.dieId || !body.cellTypeId || !body.matches) {
        response.status(400).json({ error: "dieId, cellTypeId, and matches are required" }); return;
      }
      const { dieId, cellTypeId } = body;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) { response.status(404).json({ error: "cellType not found" }); return; }

      const overlayFilename = body.overlayFilename;
      const requestedSource = await resolveRequestedOverlayPath({
        request,
        dataRoot: config.dataRoot,
        dieId,
        sourceId: overlayFilename
      });
      if (overlayFilename && !requestedSource) {
        response.status(404).json({ error: "Visible image source not found" });
        return;
      }
      const sourcePath = requestedSource ?? record.originalPath;

      const cellX = body.cellX ?? 0;
      const cellY = body.cellY ?? 0;
      const cx0 = Math.round(cellX + cellType.cropRect.x);
      const cy0 = Math.round(cellY + cellType.cropRect.y);
      const cx1 = Math.round(cellX + cellType.cropRect.x + cellType.cropRect.width);
      const cy1 = Math.round(cellY + cellType.cropRect.y + cellType.cropRect.height);
      const tmMeta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const sW = tmMeta.width ?? record.width;
      const sH = tmMeta.height ?? record.height;
      const left = Math.max(0, cx0);
      const top = Math.max(0, cy0);
      const w = Math.min(cx1 - cx0, Math.max(0, sW - left));
      const h = Math.min(cy1 - cy0, Math.max(0, sH - top));

      const searchBuf = await sharp(sourcePath, { limitInputPixels: false }).png().toBuffer();
      const fd = new FormData();
      fd.append("search", new Blob([new Uint8Array(searchBuf)], { type: "image/png" }), "search.png");
      fd.append("matches_json", JSON.stringify(body.matches));
      fd.append("ref_x", String(left));
      fd.append("ref_y", String(top));
      fd.append("ref_w", String(w));
      fd.append("ref_h", String(h));
      if (body.max_pairs != null) fd.append("max_pairs", String(body.max_pairs));
      if (body.blur_ksize != null) fd.append("blur_ksize", String(body.blur_ksize));
      if (body.use_sobel != null) fd.append("use_sobel", String(body.use_sobel));

      let sidecarRes: Response;
      try {
        sidecarRes = await fetchSidecar(`${config.mlSidecarUrl}/cv/akaze-debug`, 120000, { method: "POST", body: fd });
      } catch { response.status(503).json({ error: "sidecar unreachable" }); return; }
      if (!sidecarRes.ok) { response.status(502).json({ error: `sidecar /cv/akaze-debug ${sidecarRes.status}` }); return; }
      const data = await sidecarRes.json();
      response.json(data);
    } catch (error) { next(error); }
  });

  return router;
}
