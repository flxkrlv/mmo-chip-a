/**
 * overlayImages.ts — Per-die overlay image storage.
 *
 * Overlay images are stored under {dataRoot}/overlay-images/{dieId}/.
 * Each die gets its own subdirectory, isolating images between projects.
 *
 * Routes (all scoped by dieId):
 *   GET  /api/dies/:dieId/overlay-images/list
 *   GET  /api/dies/:dieId/overlay-images/:filename
 *   POST /api/dies/:dieId/overlay-images/upload
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";

function dieOverlayDir(dataRoot: string, dieId: string): string {
  return path.join(dataRoot, "overlay-images", dieId);
}

export function createOverlayImagesRouter(config: { dataRoot: string }) {
  const router = Router();
  const upload = multer({ dest: path.join(config.dataRoot, "tmp") });

  // Warn about orphaned global overlay images (legacy flat layout)
  const globalOverlayDir = path.join(config.dataRoot, "overlay-images");
  fs.readdir(globalOverlayDir, { withFileTypes: true }).then((entries) => {
    const oldFiles = entries.filter((e) => e.isFile());
    if (oldFiles.length > 0) {
      console.warn(
        `[overlay-images] ⚠️ found ${oldFiles.length} legacy global overlay file(s):` +
        ` they won't load under the new per-die storage.` +
        ` Move them into data/overlay-images/{dieId}/ per project.`
      );
    }
  }).catch(() => {});

  // ── List available overlay images for a die ─────────────────────
  router.get(
    "/api/dies/:dieId/overlay-images/list",
    async (request, response, next) => {
      try {
        const dieId = String(request.params.dieId);
        const dir = dieOverlayDir(config.dataRoot, dieId);
        await fs.mkdir(dir, { recursive: true });
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const images = await Promise.all(
          entries
            .filter((e) => e.isFile() && /\.(png|jpg|jpeg|gif|webp)$/i.test(e.name))
            .map(async (e) => {
              const fullPath = path.join(dir, e.name);
              let size = 0;
              try {
                const stat = await fs.stat(fullPath);
                size = stat.size;
              } catch { /* ignore */ }
              return { name: e.name, size };
            })
        );
        response.json({ images });
      } catch (error) {
        next(error);
      }
    }
  );

  // ── Serve a single overlay image ────────────────────────────────
  router.get(
    "/api/dies/:dieId/overlay-images/:filename",
    async (request, response, next) => {
      try {
        const dieId = String(request.params.dieId);
        const filename = String(request.params.filename);
        const safeName = path.basename(filename);
        if (safeName.includes("..") || safeName.includes("/")) {
          response.status(400).json({ error: "Invalid filename" });
          return;
        }
        const filePath = path.join(
          dieOverlayDir(config.dataRoot, dieId),
          safeName
        );
        await fs.access(filePath);
        response.sendFile(filePath);
      } catch (error) {
        next(error);
      }
    }
  );

  // ── Upload a new overlay image for a die ────────────────────────
  router.post(
    "/api/dies/:dieId/overlay-images/upload",
    upload.single("file"),
    async (request, response, next) => {
      const dieId = String(request.params.dieId);
      const file = request.file;
      if (!file) {
        response.status(400).json({ error: "No file uploaded" });
        return;
      }
      try {
        const dir = dieOverlayDir(config.dataRoot, dieId);
        await fs.mkdir(dir, { recursive: true });
        const name = String(file.originalname);
        const dest = path.join(dir, name);
        await fs.rename(file.path, dest);
        response.json({
          name,
          size: file.size
        });
      } catch (error) {
        // Clean up the multer temp file on failure
        await fs.rm(file.path, { force: true }).catch(() => {});
        next(error);
      }
    }
  );

  return router;
}
