import { promises as fs } from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { getOverlayCropSource } from "./overlayImages.js";
import { ensurePreviewImage } from "../imagePreview.js";
import { readAnnotations, readDieRecord } from "../store.js";
import { resolveProjectDir } from "../projectLayout.js";
import {
  ensureCrop,
  pickCropScale,
  renderCropFromOriginal,
  renderCropFromTiles,
  tilesAvailable,
  type CropRect,
  type PyramidSource
} from "../tileCrop.js";
import type { createTileScheduler } from "../tileScheduler.js";
import type { DieRecord } from "../types.js";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function assertSafeId(value: string): void {
  if (!SAFE_ID.test(value)) throw new Error("Invalid id");
}

class CropSourceMissing extends Error {}

function cropCachePath(params: {
  projectDir: string;
  overlaySourceId: string | undefined;
  basename: string;
}): string {
  const cacheDir = path.join(
    params.projectDir,
    "cell-crops"
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

  /**
   * Shared crop response. `?px=N` asks for a quick preview: the coarsest
   * pyramid level whose output long side is still >= N pixels. Without it
   * the crop is full resolution. Both are assembled from pyramid tiles.
   */
  async function serveCrop(params: {
    request: Request;
    response: Response;
    dieId: string;
    record: DieRecord;
    /** Cache basename prefix (cell / type id). */
    key: string;
    rect: CropRect;
  }): Promise<void> {
    const { request, response, record, rect } = params;
    if (rect.width <= 0 || rect.height <= 0) {
      response.status(400).json({ error: "Invalid crop region" });
      return;
    }
    const rawOverlaySourceId = request.query.overlaySourceId;
    const overlaySourceId =
      typeof rawOverlaySourceId === "string" ? rawOverlaySourceId : undefined;
    const minPx = Number(request.query.px);
    const requestedScale = pickCropScale(record.levels, rect, Number.isFinite(minPx) ? minPx : undefined);
    const { dir: projectDir } = await resolveProjectDir(config.dataRoot, params.dieId);
    const overlay = overlaySourceId
      ? await getOverlayCropSource({
          dataRoot: config.dataRoot,
          dieId: params.dieId,
          sourceId: overlaySourceId
        })
      : null;
    const tilesDir = path.join(projectDir, "tiles");
    const base: PyramidSource = {
      levels: record.levels,
      tileSize: record.tileSize,
      peekTile: async (z, x, y) => {
        const tilePath = path.join(tilesDir, String(z), `${x}_${y}.jpg`);
        try {
          await fs.access(tilePath);
          return tilePath;
        } catch {
          return null;
        }
      }
    };

    // Tiles are used only where they are already built. A preview may come
    // from any coarser complete level (the client stretches it to the cell
    // box); a full-resolution crop needs the scale-1 tiles. Otherwise one
    // direct extract from the original at the requested scale.
    const candidates = [
      requestedScale,
      ...record.levels.map((l) => l.scale).filter((s) => requestedScale > 1 && s > requestedScale).sort((a, b) => a - b)
    ];
    let scale = requestedScale;
    let fromTiles = false;
    for (const s of candidates) {
      if (await tilesAvailable({ base, overlay: overlay?.pyramid, rect, scale: s })) {
        scale = s;
        fromTiles = true;
        break;
      }
    }

    // Position, size and scale are all in the key: moving or resizing a cell
    // yields a fresh crop, and a preview never masquerades as the full crop.
    const cachePath = cropCachePath({
      projectDir,
      overlaySourceId,
      basename: `${params.key}-${rect.left}-${rect.top}-${rect.width}x${rect.height}-s${scale}.jpg`
    });

    await ensureCrop(cachePath, async () => {
      if (fromTiles && await renderCropFromTiles({ base, overlay: overlay?.pyramid, rect, scale, target: cachePath })) {
        return;
      }
      const originalDir = path.join(projectDir, "original");
      const originalFiles = await fs.readdir(originalDir);
      if (originalFiles.length === 0) throw new CropSourceMissing();
      await renderCropFromOriginal({
        basePath: path.join(originalDir, originalFiles[0]),
        overlayPath: overlay?.originalPath,
        imageSize: { width: record.width, height: record.height },
        rect,
        scale,
        target: cachePath
      });
    });
    response.sendFile(cachePath);
  }

  function clampRect(record: DieRecord, x: number, y: number, w: number, h: number): CropRect {
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    return {
      left,
      top,
      width: Math.min(Math.round(w), record.width - left),
      height: Math.min(Math.round(h), record.height - top)
    };
  }

  router.get("/api/dies/:dieId/cells/:cellId/crop", async (request, response, next) => {
    try {
      const { dieId, cellId } = request.params;
      assertSafeId(dieId);
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);

      const cell = annotations.cells.find((c) => c.id === cellId);
      if (!cell) { console.warn(`[crop] cell ${cellId} not found in annotations`); response.status(404).json({ error: "Cell not found" }); return; }
      const cellType = annotations.cellTypes.find((ct) => ct.id === cell.cellTypeId);
      if (!cellType) { response.status(404).json({ error: "Cell type not found" }); return; }

      await serveCrop({
        request,
        response,
        dieId,
        record,
        key: cellId,
        rect: clampRect(record, cell.x, cell.y, cellType.cropRect.width, cellType.cropRect.height)
      });
    } catch (error) {
      if (error instanceof CropSourceMissing) {
        response.status(404).json({ error: "Crop source image not found" });
        return;
      }
      next(error);
    }
  });

  router.get("/api/dies/:dieId/cell-types/:cellTypeId/crop", async (request, response, next) => {
    try {
      const { dieId, cellTypeId } = request.params;
      assertSafeId(dieId);
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

      await serveCrop({
        request,
        response,
        dieId,
        record,
        key: `ct-${cellTypeId}`,
        rect: clampRect(record, cropX, cropY, cellType.cropRect.width, cellType.cropRect.height)
      });
    } catch (error) {
      if (error instanceof CropSourceMissing) {
        response.status(404).json({ error: "Crop source image not found" });
        return;
      }
      next(error);
    }
  });

  router.get("/api/dies/:dieId/tiles/:z/:x/:y", async (request, response, next) => {
    try {
      const { dieId, z, x, y } = request.params;
      assertSafeId(dieId);
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

  // Serve a downscaled preview of the die image for the IC Package view.
  // The full original is cached on disk as a JPEG (max 4096px edge) so the
  // browser never downloads/decodes the full-resolution file.
  router.get("/api/dies/:dieId/image", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      assertSafeId(dieId);
      const { dir: projectDir } = await resolveProjectDir(config.dataRoot, dieId);
      const originalDir = path.join(projectDir, "original");
      const files = await fs.readdir(originalDir);
      if (files.length === 0) {
        response.status(404).json({ error: "Image not found" });
        return;
      }
      const sourcePath = path.join(originalDir, files[0]);
      const previewPath = await ensurePreviewImage({
        sourcePath,
        cachePath: path.join(
          projectDir,
          "previews",
          `${path.parse(files[0]).name}.4096.jpg`
        )
      });
      response.setHeader("Cache-Control", "public, max-age=86400");
      response.type("image/jpeg");
      response.sendFile(previewPath);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
