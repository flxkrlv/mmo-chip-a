import { promises as fs } from "node:fs";
import path from "node:path";
import { Router, type Request } from "express";
import sharp from "sharp";
import { resolveOverlayOriginalPath } from "./overlayImages.js";
import { readAnnotations, readDieRecord } from "../store.js";
import type { createTileScheduler } from "../tileScheduler.js";

function requestUserId(request: Request): string {
  const user = (request as Request & { user?: { userId?: unknown } }).user;
  return typeof user?.userId === "string" && user.userId.length > 0
    ? user.userId
    : "dev";
}

/**
 * Resolves the source for small static previews. A tiled overlay is always
 * resolved inside the current user's namespace; legacy/base-image previews
 * retain the historical original-image fallback when no source is selected.
 */
async function resolveCropOriginalPath(params: {
  request: Request;
  dataRoot: string;
  dieId: string;
}): Promise<string | null> {
  const rawSourceId = params.request.query.overlaySourceId;
  const sourceId = typeof rawSourceId === "string" ? rawSourceId : undefined;
  if (sourceId) {
    return resolveOverlayOriginalPath({
      dataRoot: params.dataRoot,
      userId: requestUserId(params.request),
      dieId: params.dieId,
      sourceId
    });
  }

  const originalDir = path.join(params.dataRoot, "dies", params.dieId, "original");
  const files = await fs.readdir(originalDir);
  return files.length > 0 ? path.join(originalDir, files[0]) : null;
}

function cropCachePath(params: {
  dataRoot: string;
  dieId: string;
  userId: string;
  overlaySourceId: string | undefined;
  basename: string;
}): string {
  const cacheDir = path.join(
    params.dataRoot,
    "dies",
    params.dieId,
    "cell-crops",
    encodeURIComponent(params.userId)
  );
  const sourcePrefix = params.overlaySourceId
    ? `overlay-${encodeURIComponent(params.overlaySourceId)}-`
    : "base-";
  return path.join(cacheDir, `${sourcePrefix}${params.basename}`);
}

export function createTilesRouter(config: {
  dataRoot: string;
  tileScheduler: ReturnType<typeof createTileScheduler>;
}) {
  const router = Router();

  router.get("/api/dies/:dieId/cells/:cellId/crop", async (request, response, next) => {
    try {
      const { dieId, cellId } = request.params;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);

      const cell = annotations.cells.find((c) => c.id === cellId);
      if (!cell) { response.status(404).json({ error: "Cell not found" }); return; }
      const cellType = annotations.cellTypes.find((ct) => ct.id === cell.cellTypeId);
      if (!cellType) { response.status(404).json({ error: "Cell type not found" }); return; }

      // Cache key includes crop coords and selected source, so re-alignment and
      // layer hotkeys cannot return an image generated for another source.
      const { width: cropW, height: cropH } = cellType.cropRect;
      const left = Math.max(0, Math.round(cell.x));
      const top = Math.max(0, Math.round(cell.y));
      const width = Math.min(Math.round(cropW), record.width - left);
      const height = Math.min(Math.round(cropH), record.height - top);
      const rawOverlaySourceId = request.query.overlaySourceId;
      const overlaySourceId =
        typeof rawOverlaySourceId === "string" ? rawOverlaySourceId : undefined;
      const cachePath = cropCachePath({
        dataRoot: config.dataRoot,
        dieId,
        userId: requestUserId(request),
        overlaySourceId,
        basename: `${cellId}-${left}-${top}.jpg`
      });
      const cacheDir = path.dirname(cachePath);
      try {
        await fs.access(cachePath);
        response.sendFile(cachePath);
        return;
      } catch { /* cache miss */ }

      const originalPath = await resolveCropOriginalPath({
        request,
        dataRoot: config.dataRoot,
        dieId
      });
      if (!originalPath) {
        response.status(404).json({ error: "Crop source image not found" });
        return;
      }
      if (width <= 0 || height <= 0) { response.status(400).json({ error: "Invalid crop region" }); return; }

      await fs.mkdir(cacheDir, { recursive: true });
      await sharp(originalPath, { limitInputPixels: false })
        .extract({ left, top, width, height })
        .jpeg({ quality: 90 })
        .toFile(cachePath);

      response.sendFile(cachePath);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/cell-types/:cellTypeId/crop", async (request, response, next) => {
    try {
      const { dieId, cellTypeId } = request.params;
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);

      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) { response.status(404).json({ error: "Cell type not found" }); return; }

      // For cell types created via "extract cell type", cropRect has the actual image position.
      // For cell types from "add cell", cropRect is at (0,0) — use the first cell instance.
      let cropX = cellType.cropRect.x;
      let cropY = cellType.cropRect.y;
      if (cropX === 0 && cropY === 0 && cellType.cropRect.width > 0) {
        const cell = annotations.cells.find((c) => c.cellTypeId === cellTypeId);
        if (cell) { cropX = cell.x; cropY = cell.y; }
      }

      const rawOverlaySourceId = request.query.overlaySourceId;
      const overlaySourceId =
        typeof rawOverlaySourceId === "string" ? rawOverlaySourceId : undefined;
      const cachePath = cropCachePath({
        dataRoot: config.dataRoot,
        dieId,
        userId: requestUserId(request),
        overlaySourceId,
        basename: `ct-${cellTypeId}.jpg`
      });
      const cacheDir = path.dirname(cachePath);
      try {
        await fs.access(cachePath);
        response.sendFile(cachePath);
        return;
      } catch { /* cache miss */ }

      const originalPath = await resolveCropOriginalPath({
        request,
        dataRoot: config.dataRoot,
        dieId
      });
      if (!originalPath) {
        response.status(404).json({ error: "Crop source image not found" });
        return;
      }

      const left = Math.max(0, Math.round(cropX));
      const top = Math.max(0, Math.round(cropY));
      const width = Math.min(Math.round(cellType.cropRect.width), record.width - left);
      const height = Math.min(Math.round(cellType.cropRect.height), record.height - top);
      if (width <= 0 || height <= 0) { response.status(400).json({ error: "Invalid crop region" }); return; }

      await fs.mkdir(cacheDir, { recursive: true });
      await sharp(originalPath, { limitInputPixels: false })
        .extract({ left, top, width, height })
        .jpeg({ quality: 90 })
        .toFile(cachePath);

      response.sendFile(cachePath);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/tiles/:z/:x/:y", async (request, response, next) => {
    try {
      const { dieId, z, x, y } = request.params;
      const record = await readDieRecord(config.dataRoot, dieId);
      const zIndex = Number(z);
      const xIndex = Number(x);
      const yIndex = Number(y);

      if (
        !Number.isInteger(zIndex) ||
        !Number.isInteger(xIndex) ||
        !Number.isInteger(yIndex)
      ) {
        response.status(400).json({ error: "Invalid tile coordinates" });
        return;
      }

      const tilePath = await config.tileScheduler.requestTile(record, zIndex, xIndex, yIndex);
      response.sendFile(tilePath);
    } catch (error) {
      if (
        error instanceof Error &&
        /Tile (level|coordinates) out of range/.test(error.message)
      ) {
        response.status(404).json({ error: "Tile not found" });
        return;
      }

      next(error);
    }
  });

  return router;
}
