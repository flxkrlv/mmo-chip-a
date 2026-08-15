/**
 * Shared tiled overlay image storage.
 *
 * All users see the same overlay images.  Uploads are stored as an image
 * manifest plus a lazy-generated tile pyramid under a shared directory.
 * Per-user render settings (visibility, opacity, offset) live in each
 * browser's localStorage.
 *
 * Legacy flat files remain readable through the original-file route.
 */
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { buildLevels } from "../dieImport/importer.js";

const DEFAULT_TILE_SIZE = 512;
const SUPPORTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp"
]);
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

type TileFormat = "jpg" | "png";

export interface OverlayImageManifest {
  id: string;
  name: string;
  originalFilename: string;
  originalPath: string;
  size: number;
  width: number;
  height: number;
  tileSize: number;
  tileFormat: TileFormat;
  hasAlpha: boolean;
  maxZoomLevel: number;
  levels: ReturnType<typeof buildLevels>;
  ready: boolean;
  createdAt: string;
  updatedAt: string;
}

interface OverlayImageListItem extends Omit<OverlayImageManifest, "originalPath"> {
  legacy?: boolean;
}

function assertSafeId(value: string): void {
  if (!SAFE_ID.test(value)) throw new Error("Invalid overlay image id");
}

function dieOverlayDir(dataRoot: string, dieId: string): string {
  assertSafeId(dieId);
  return path.join(dataRoot, "overlay-images", dieId);
}

function sourceDir(dataRoot: string, dieId: string, id: string): string {
  assertSafeId(id);
  return path.join(dieOverlayDir(dataRoot, dieId), id);
}

function manifestPath(dataRoot: string, dieId: string, id: string): string {
  return path.join(sourceDir(dataRoot, dieId, id), "manifest.json");
}

async function readManifest(
  dataRoot: string,
  dieId: string,
  id: string
): Promise<OverlayImageManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(dataRoot, dieId, id), "utf8");
    const value = JSON.parse(raw) as OverlayImageManifest;
    if (!value || value.id !== id || !value.originalPath) return null;
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function toListItem(manifest: OverlayImageManifest): OverlayImageListItem {
  const { originalPath: _originalPath, ...item } = manifest;
  return item;
}

async function listManifests(
  dataRoot: string,
  dieId: string
): Promise<OverlayImageListItem[]> {
  const dir = dieOverlayDir(dataRoot, dieId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
        .map((entry) => readManifest(dataRoot, dieId, entry.name))
    );
    return manifests
      .filter((item): item is OverlayImageManifest => item !== null)
      .map(toListItem)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function listLegacyFiles(dataRoot: string, dieId: string): Promise<OverlayImageListItem[]> {
  try {
    const dir = dieOverlayDir(dataRoot, dieId);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const images = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
        .map(async (entry) => {
          const filePath = path.join(dir, entry.name);
          const stat = await fs.stat(filePath);
          return {
            id: entry.name,
            name: entry.name.replace(/\.[^.]+$/, ""),
            originalFilename: entry.name,
            size: stat.size,
            width: 0,
            height: 0,
            tileSize: DEFAULT_TILE_SIZE,
            tileFormat: "jpg" as TileFormat,
            hasAlpha: false,
            maxZoomLevel: 0,
            levels: [],
            ready: true,
            createdAt: stat.birthtime.toISOString(),
            updatedAt: stat.mtime.toISOString(),
            legacy: true
          } satisfies OverlayImageListItem;
        })
    );
    return images.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeManifest(manifest: OverlayImageManifest): Promise<void> {
  const target = path.join(path.dirname(manifest.originalPath), "manifest.json");
  const temp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(manifest, null, 2), "utf8");
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

const MAX_CONCURRENT_TILE_GENERATIONS = Math.max(
  2,
  Math.min(8, Number(process.env.TILE_GENERATION_CONCURRENCY ?? 0) ||
    Math.max(2, os.availableParallelism?.() ?? 4))
);

interface TileGenerationResult {
  tilePath: string;
  cache: "disk" | "generated";
  queueMs: number;
  generationMs: number;
}

interface QueuedTileGeneration {
  priority: number;
  sequence: number;
  run: () => void;
}

const pendingTileGenerations = new Map<string, Promise<TileGenerationResult>>();
const tileGenerationQueue: QueuedTileGeneration[] = [];
let activeTileGenerations = 0;
let tileGenerationSequence = 0;

function drainTileGenerationQueue(): void {
  while (
    activeTileGenerations < MAX_CONCURRENT_TILE_GENERATIONS &&
    tileGenerationQueue.length > 0
  ) {
    const next = tileGenerationQueue.shift();
    if (!next) return;
    activeTileGenerations += 1;
    next.run();
  }
}

function scheduleTileGeneration<T>(
  priority: number,
  work: () => Promise<T>
): Promise<{ value: T; queueMs: number }> {
  const enqueuedAt = Date.now();
  return new Promise((resolve, reject) => {
    tileGenerationQueue.push({
      priority,
      sequence: tileGenerationSequence++,
      run: () => {
        const startedAt = Date.now();
        void work()
          .then((value) => resolve({ value, queueMs: startedAt - enqueuedAt }), reject)
          .finally(() => {
            activeTileGenerations -= 1;
            drainTileGenerationQueue();
          });
      }
    });
    // Stable priority ordering: higher priority first, FIFO for equal priority.
    tileGenerationQueue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    drainTileGenerationQueue();
  });
}

async function ensureTile(params: {
  manifest: OverlayImageManifest;
  dataRoot: string;
  dieId: string;
  z: number;
  x: number;
  y: number;
  priority: number;
}): Promise<TileGenerationResult> {
  const target = path.join(
    sourceDir(params.dataRoot, params.dieId, params.manifest.id),
    "tiles",
    String(params.z),
    `${params.x}_${params.y}.${params.manifest.tileFormat}`
  );
  try {
    await fs.access(target);
    return { tilePath: target, cache: "disk", queueMs: 0, generationMs: 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const key = `${params.dieId}/${params.manifest.id}/${params.z}/${params.x}/${params.y}`;
  const existing = pendingTileGenerations.get(key);
  if (existing) return existing;

  const task = scheduleTileGeneration(params.priority, async () => {
    const generationStartedAt = Date.now();
    const tilePath = await ensureTileImpl(params);
    return { tilePath, generationMs: Date.now() - generationStartedAt };
  })
    .then(({ value, queueMs }) => ({
      tilePath: value.tilePath,
      cache: "generated" as const,
      queueMs,
      generationMs: value.generationMs
    }))
    .finally(() => pendingTileGenerations.delete(key));
  pendingTileGenerations.set(key, task);
  return task;
}

async function ensureTileImpl(params: {
  manifest: OverlayImageManifest;
  dataRoot: string;
  dieId: string;
  z: number;
  x: number;
  y: number;
}): Promise<string> {
  const { manifest, z, x, y } = params;
  const level = manifest.levels[z];
  if (!level || x < 0 || y < 0 || x >= level.columns || y >= level.rows) {
    throw new Error("Tile coordinates out of range");
  }
  const ext = manifest.tileFormat;
  const target = path.join(
    sourceDir(params.dataRoot, params.dieId, manifest.id),
    "tiles",
    String(z),
    `${x}_${y}.${ext}`
  );
  try {
    await fs.access(target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const left = x * manifest.tileSize;
  const top = y * manifest.tileSize;
  const width = Math.min(manifest.tileSize, level.width - left);
  const height = Math.min(manifest.tileSize, level.height - top);
  const sourceLeft = left * level.scale;
  const sourceTop = top * level.scale;
  const sourceWidth = Math.min(manifest.width - sourceLeft, width * level.scale);
  const sourceHeight = Math.min(manifest.height - sourceTop, height * level.scale);
  if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error("Tile outside image");

  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    const pipeline = sharp(manifest.originalPath, {
      limitInputPixels: false,
      sequentialRead: true
    })
      .extract({ left: sourceLeft, top: sourceTop, width: sourceWidth, height: sourceHeight })
      .resize({ width, height, fit: "fill", kernel: sharp.kernel.lanczos2 });
    if (manifest.tileFormat === "png") {
      await pipeline.png({ compressionLevel: 6 }).toFile(temp);
    } else {
      await pipeline.jpeg({ quality: 85, chromaSubsampling: "4:2:0" }).toFile(temp);
    }
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return target;
}

/** Resolve a tiled overlay original in the shared namespace. */
export async function resolveOverlayOriginalPath(params: {
  dataRoot: string;
  dieId: string;
  sourceId: string;
}): Promise<string | null> {
  if (!SAFE_ID.test(params.sourceId)) return null;
  const manifest = await readManifest(
    params.dataRoot,
    params.dieId,
    params.sourceId
  );
  if (!manifest) return null;
  try {
    await fs.access(manifest.originalPath);
    return manifest.originalPath;
  } catch {
    return null;
  }
}

export async function preGenerateCoarseLevels(params: {
  manifest: OverlayImageManifest;
  dataRoot: string;
  dieId: string;
}): Promise<void> {
  // Level 0 is normally one tile; level 1 is still tiny.  Run this as idle
  // work only: every interactive viewport request has a newer positive epoch.
  const levels = params.manifest.levels.slice(0, 2);
  await Promise.all(
    levels.flatMap((level) => {
      const jobs: Array<Promise<TileGenerationResult>> = [];
      for (let x = 0; x < level.columns; x += 1) {
        for (let y = 0; y < level.rows; y += 1) {
          jobs.push(
            ensureTile({
              ...params,
              z: level.z,
              x,
              y,
              priority: -1_000_000_000
            })
          );
        }
      }
      return jobs;
    })
  );
}

export function createOverlayImagesRouter(config: { dataRoot: string }) {
  const router = Router();
  const upload = multer({ dest: path.join(config.dataRoot, "tmp") });

  router.get("/api/dies/:dieId/overlay-images/list", async (request, response, next) => {
    try {
      const dieId = String(request.params.dieId);
      const personal = await listManifests(config.dataRoot, dieId);
      const legacy = await listLegacyFiles(config.dataRoot, dieId);
      response.json({ images: [...legacy, ...personal] });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/api/dies/:dieId/overlay-images/upload",
    upload.single("file"),
    async (request, response, next) => {
      const tempFile = request.file;
      try {
        if (!tempFile) {
          response.status(400).json({ error: "No file uploaded" });
          return;
        }
        if (!SUPPORTED_MIME_TYPES.has(tempFile.mimetype)) {
          response.status(400).json({ error: "Only PNG, JPEG and WebP images are supported" });
          return;
        }
        const dieId = String(request.params.dieId);
        const metadata = await sharp(tempFile.path, { limitInputPixels: false }).metadata();
        if (!metadata.width || !metadata.height) {
          response.status(400).json({ error: "Unable to read image dimensions" });
          return;
        }
        const id = crypto.randomUUID().replace(/-/g, "");
        const dir = sourceDir(config.dataRoot, dieId, id);
        await fs.mkdir(dir, { recursive: true });
        const extension = path.extname(tempFile.originalname).toLowerCase() || ".img";
        const originalPath = path.join(dir, `original${extension}`);
        await fs.rename(tempFile.path, originalPath);
        const maxDimension = Math.max(metadata.width, metadata.height);
        const maxZoomLevel = Math.max(0, Math.ceil(Math.log2(maxDimension / DEFAULT_TILE_SIZE)));
        const now = new Date().toISOString();
        const manifest: OverlayImageManifest = {
          id,
          name: tempFile.originalname.replace(/\.[^.]+$/, "") || "image",
          originalFilename: tempFile.originalname,
          originalPath,
          size: tempFile.size,
          width: metadata.width,
          height: metadata.height,
          tileSize: DEFAULT_TILE_SIZE,
          tileFormat: metadata.hasAlpha ? "png" : "jpg",
          hasAlpha: Boolean(metadata.hasAlpha),
          maxZoomLevel,
          levels: buildLevels(metadata.width, metadata.height, DEFAULT_TILE_SIZE, maxZoomLevel),
          ready: true,
          createdAt: now,
          updatedAt: now
        };
        await writeManifest(manifest);
        // Start preview preparation only after an idle grace period. This gives
        // the UI time to issue its first interactive requests, which must always
        // obtain the worker slots ahead of background coarse generation.
        setTimeout(() => {
          void preGenerateCoarseLevels({
            manifest,
            dataRoot: config.dataRoot,
            dieId
          }).catch((error) => {
            console.warn("Failed to pre-generate overlay preview tiles", error);
          });
        }, 750);
        response.status(201).json({ image: toListItem(manifest) });
      } catch (error) {
        if (tempFile) await fs.rm(tempFile.path, { force: true }).catch(() => {});
        next(error);
      }
    }
  );

  router.get("/api/dies/:dieId/overlay-images/:id/tiles/:z/:x/:y", async (request, response, next) => {
    try {
      const { dieId, id, z, x, y } = request.params;
      if (!SAFE_ID.test(id) || ![z, x, y].every((part) => /^\d+$/.test(part))) {
        response.status(400).json({ error: "Invalid tile coordinates" });
        return;
      }
      const manifest = await readManifest(config.dataRoot, dieId, id);
      if (!manifest) {
        response.status(404).json({ error: "Overlay image not found" });
        return;
      }
      const requestStartedAt = Date.now();
      const requestedPriority = Number(request.query.p ?? 0);
      // Browser priority includes a monotonically increasing viewport epoch.
      // Do not clamp it: a fresh viewport must outrank stale queued work.
      const priority = Number.isFinite(requestedPriority)
        ? Math.round(requestedPriority)
        : 0;
      const tile = await ensureTile({
        manifest,
        dataRoot: config.dataRoot,
        dieId,
        z: Number(z),
        x: Number(x),
        y: Number(y),
        priority
      });
      const requestMs = Date.now() - requestStartedAt;
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      response.setHeader("X-Tile-Cache", tile.cache);
      response.setHeader("X-Tile-Queue-Ms", String(tile.queueMs));
      response.setHeader("X-Tile-Generation-Ms", String(tile.generationMs));
      response.setHeader(
        "Server-Timing",
        `tile;dur=${requestMs}, queue;dur=${tile.queueMs}, generate;dur=${tile.generationMs}`
      );
      response.sendFile(tile.tilePath);
    } catch (error) {
      if (error instanceof Error && /Tile (coordinates|outside)/.test(error.message)) {
        response.status(404).json({ error: "Tile not found" });
        return;
      }
      next(error);
    }
  });

  router.get("/api/dies/:dieId/overlay-images/:id/original", async (request, response, next) => {
    try {
      const originalPath = await resolveOverlayOriginalPath({
        dataRoot: config.dataRoot,
        dieId: request.params.dieId,
        sourceId: request.params.id
      });
      if (!originalPath) {
        response.status(404).json({ error: "Overlay image not found" });
        return;
      }
      response.setHeader("Cache-Control", "private, no-store");
      response.sendFile(originalPath);
    } catch (error) {
      next(error);
    }
  });

  // Backward-compatible legacy original route.  New tiled sources must use
  // `/:id/original`; do not let arbitrary filenames escape this directory.
  router.get("/api/dies/:dieId/overlay-images/:filename", async (request, response, next) => {
    try {
      const { dieId, filename } = request.params;
      const safeName = path.basename(filename);
      if (safeName !== filename || !/\.(png|jpe?g|webp)$/i.test(safeName)) {
        response.status(400).json({ error: "Invalid filename" });
        return;
      }
      const filePath = path.join(dieOverlayDir(config.dataRoot, dieId), safeName);
      await fs.access(filePath);
      response.sendFile(filePath);
    } catch (error) {
      next(error);
    }
  });

  return router;
}