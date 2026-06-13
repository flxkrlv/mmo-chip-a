import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";

/**
 * Router for overlay image files — small images (PNG/JPG) that users load
 * as semi-transparent layers on top of the main die image.
 *
 * Two endpoints:
 *  GET  /api/overlay-images/list — list available images from a known dir
 *  GET  /api/overlay-images/:filename — serve a single image file
 *  POST /api/overlay-images/upload — upload a new overlay image
 */

export function createOverlayImagesRouter(config: {
  dataRoot: string;
}) {
  const router = Router();

  // Directory where overlay images are stored (flat, no subdirs).
  const overlayDir = path.join(config.dataRoot, "overlay-images");
  const upload = multer({ dest: overlayDir });

  // Ensure the overlay dir exists at startup.
  fs.mkdir(overlayDir, { recursive: true }).catch(() => {});

  // ── List available overlay images ─────────────────────────────────
  router.get("/api/overlay-images/list", async (_request, response, next) => {
    try {
      await fs.mkdir(overlayDir, { recursive: true });
      const entries = await fs.readdir(overlayDir, { withFileTypes: true });
      const images = await Promise.all(
        entries
          .filter((e) => e.isFile() && /\.(png|jpg|jpeg|gif|webp)$/i.test(e.name))
          .map(async (e) => {
            const fullPath = path.join(overlayDir, e.name);
            let size = 0;
            try {
              const stat = await fs.stat(fullPath);
              size = stat.size;
            } catch {
              // ignore
            }
            return { name: e.name, size };
          })
      );
      response.json({ images });
    } catch (error) {
      next(error);
    }
  });

  // ── Serve a single overlay image ─────────────────────────────────
  router.get(
    "/api/overlay-images/:filename",
    async (request, response, next) => {
      try {
        const filename = path.basename(request.params.filename);
        // Basic path traversal guard.
        if (filename.includes("..") || filename.includes("/")) {
          response.status(400).json({ error: "Invalid filename" });
          return;
        }
        const filePath = path.join(overlayDir, filename);
        await fs.access(filePath);
        response.sendFile(filePath);
      } catch (error) {
        next(error);
      }
    }
  );

  // ── Upload a new overlay image ────────────────────────────────────
  router.post(
    "/api/overlay-images/upload",
    upload.single("file"),
    async (request, response, next) => {
      if (!request.file) {
        response.status(400).json({ error: "No file uploaded" });
        return;
      }
      // The file is already in overlayDir thanks to multer's dest config.
      response.json({
        name: request.file.filename,
        originalName: request.file.originalname,
        size: request.file.size
      });
    }
  );

  return router;
}
