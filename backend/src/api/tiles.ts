import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import sharp from "sharp";
import { readAnnotations, readDieRecord } from "../store.js";
import type { createTileScheduler } from "../tileScheduler.js";

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

      // Crop region (cache key includes coords so re-aligning invalidates the old cache)
      const { width: cropW, height: cropH } = cellType.cropRect;
      const left = Math.max(0, Math.round(cell.x));
      const top = Math.max(0, Math.round(cell.y));
      const width = Math.min(Math.round(cropW), record.width - left);
      const height = Math.min(Math.round(cropH), record.height - top);

      // Check cache
      const cacheDir = path.join(config.dataRoot, "dies", dieId, "cell-crops");
      const cachePath = path.join(cacheDir, `${cellId}-${left}-${top}.jpg`);
      try {
        await fs.access(cachePath);
        response.sendFile(cachePath);
        return;
      } catch { /* cache miss */ }

      // Find original image
      const originalDir = path.join(config.dataRoot, "dies", dieId, "original");
      const files = await fs.readdir(originalDir);
      if (files.length === 0) { response.status(404).json({ error: "Original image not found" }); return; }
      const originalPath = path.join(originalDir, files[0]);

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

      // Check cache
      const cacheDir = path.join(config.dataRoot, "dies", dieId, "cell-crops");
      const cachePath = path.join(cacheDir, `ct-${cellTypeId}.jpg`);
      try {
        await fs.access(cachePath);
        response.sendFile(cachePath);
        return;
      } catch { /* cache miss */ }

      const originalDir = path.join(config.dataRoot, "dies", dieId, "original");
      const files = await fs.readdir(originalDir);
      if (files.length === 0) { response.status(404).json({ error: "Original image not found" }); return; }
      const originalPath = path.join(originalDir, files[0]);

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
