import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { writeDieRecord } from "../store.js";
import { ensurePreviewImage } from "../imagePreview.js";
import type { DieLevelMetadata, DieRecord } from "../types.js";

const VALID_MIME_TYPES = new Set(["image/png", "image/jpeg"]);

export interface ImportProgressUpdate {
  phase: "analyzing" | "tiling" | "persisting" | "completed" | "failed";
  message: string;
  totalLevels: number;
  completedLevels: number;
  currentLevel: number | null;
  currentLevelTiles: number;
  currentLevelProcessedTiles: number;
  totalTiles: number;
  processedTiles: number;
}

export async function importDieShot(params: {
  dataRoot: string;
  filePath: string;
  originalFilename: string;
  mimeType: string;
  tileSize: number;
  limitInputPixels: number | false;
  tileConcurrency: number;
  /** Import straight into this existing directory (creates a folder project). */
  targetDir?: string;
  /** Project id to use when targeting a folder (already registered as a shortcut). */
  targetId?: string;
  onProgress?: (update: ImportProgressUpdate) => Promise<void> | void;
  logger?: (message: string) => void;
}): Promise<DieRecord> {
  if (!VALID_MIME_TYPES.has(params.mimeType)) {
    throw new Error("Only PNG and JPEG imports are supported.");
  }

  const metadata = await sharp(params.filePath, {
    limitInputPixels: params.limitInputPixels,
    sequentialRead: true
  }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Failed to read image dimensions.");
  }

  params.logger?.(`analyzed ${params.originalFilename} at ${metadata.width}x${metadata.height}`);

  const id = params.targetDir ? params.targetId ?? crypto.randomUUID() : crypto.randomUUID();
  const extension = params.mimeType === "image/png" ? "png" : "jpg";
  const dieDir = params.targetDir ? path.resolve(params.targetDir) : path.join(params.dataRoot, "dies", id);
  const originalDir = path.join(dieDir, "original");
  const tilesDir = path.join(dieDir, "tiles");
  await fs.mkdir(originalDir, { recursive: true });
  await fs.mkdir(tilesDir, { recursive: true });

  const sanitizedBase = sanitizeName(path.parse(params.originalFilename).name) || "die-shot";
  const originalPath = path.join(originalDir, `${sanitizedBase}.${extension}`);
  await fs.copyFile(params.filePath, originalPath);

  const maxDimension = Math.max(metadata.width, metadata.height);
  const maxZoomLevel = Math.max(0, Math.ceil(Math.log2(maxDimension / params.tileSize)));
  const levels = buildLevels(metadata.width, metadata.height, params.tileSize, maxZoomLevel);
  const totalTiles = levels.reduce((sum, level) => sum + level.columns * level.rows, 0);

  await params.onProgress?.({
    phase: "analyzing",
    message: "Preparing lazy tile metadata",
    totalLevels: levels.length,
    completedLevels: 0,
    currentLevel: null,
    currentLevelTiles: 0,
    currentLevelProcessedTiles: 0,
    totalTiles,
    processedTiles: 0
  });

  params.logger?.(`prepared ${levels.length} lazy tile levels`);

  const timestamp = new Date().toISOString();
  const record: DieRecord = {
    id,
    name: sanitizedBase,
    originalFilename: params.originalFilename,
    originalPath,
    width: metadata.width,
    height: metadata.height,
    tileSize: params.tileSize,
    tileFormat: "jpg",
    maxZoomLevel,
    levels,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(params.targetDir
      ? { location: "folder" as const, folderPath: dieDir }
      : {})
  };

  await params.onProgress?.({
    phase: "persisting",
    message: "Writing die metadata",
    totalLevels: levels.length,
    completedLevels: levels.length,
    currentLevel: maxZoomLevel,
    currentLevelTiles:
      levels[maxZoomLevel]?.columns * levels[maxZoomLevel]?.rows || 0,
    currentLevelProcessedTiles: 0,
    totalTiles,
    processedTiles: 0
  });

  await writeDieRecord(params.dataRoot, record);

  // Pre-generate the cached IC Package preview so the first page load is
  // instant.  Non-fatal: the route regenerates it on demand if this fails.
  try {
    await ensurePreviewImage({
      sourcePath: originalPath,
      cachePath: path.join(dieDir, "previews", `${sanitizedBase}.4096.jpg`)
    });
    params.logger?.(`generated preview for ${record.name}`);
  } catch (error) {
    params.logger?.(`preview generation failed: ${(error as Error).message}`);
  }

  await params.onProgress?.({
    phase: "completed",
    message: `Imported ${record.name}`,
    totalLevels: levels.length,
    completedLevels: levels.length,
    currentLevel: maxZoomLevel,
    currentLevelTiles:
      levels[maxZoomLevel]?.columns * levels[maxZoomLevel]?.rows || 0,
    currentLevelProcessedTiles: 0,
    totalTiles,
    processedTiles: 0
  });

  return record;
}

export function buildLevels(
  width: number,
  height: number,
  tileSize: number,
  maxZoomLevel: number
): DieLevelMetadata[] {
  return Array.from({ length: maxZoomLevel + 1 }, (_, z) => {
    const scale = 2 ** (maxZoomLevel - z);
    const levelWidth = Math.max(1, Math.ceil(width / scale));
    const levelHeight = Math.max(1, Math.ceil(height / scale));

    return {
      z,
      width: levelWidth,
      height: levelHeight,
      columns: Math.ceil(levelWidth / tileSize),
      rows: Math.ceil(levelHeight / tileSize),
      scale
    };
  });
}

/**
 * Resolve the base die image for a project. The original always lives in the
 * project directory (`<projectDir>/original/`), so that copy wins over the
 * absolute `record.originalPath` — which can go stale when a folder project is
 * moved, renamed or copied between machines.
 */
async function resolveBaseOriginalPath(record: DieRecord, projectDir: string): Promise<string> {
  const originalDir = path.join(projectDir, "original");
  try {
    const files = await fs.readdir(originalDir);
    if (files.length > 0) {
      const wanted = record.originalPath ? path.basename(record.originalPath) : null;
      const pick = wanted && files.includes(wanted) ? wanted : files[0];
      return path.join(originalDir, pick);
    }
  } catch {
    /* no original/ directory — fall back to the recorded path */
  }
  return record.originalPath;
}

export async function ensureTileForRecord(params: {
  dataRoot: string;
  record: DieRecord;
  z: number;
  x: number;
  y: number;
  /** Override the project directory (folder projects live outside dataRoot). */
  projectDir?: string;
}) {
  const level = params.record.levels[params.z];
  if (!level) {
    throw new Error("Tile level out of range.");
  }

  if (
    params.x < 0 ||
    params.y < 0 ||
    params.x >= level.columns ||
    params.y >= level.rows
  ) {
    throw new Error("Tile coordinates out of range.");
  }

  const projectDir = params.projectDir ?? path.join(params.dataRoot, "dies", params.record.id);
  const tilePath = path.join(
    projectDir,
    "tiles",
    String(params.z),
    `${params.x}_${params.y}.jpg`
  );

  try {
    await fs.access(tilePath);
    return tilePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const tileDir = path.dirname(tilePath);
  await fs.mkdir(tileDir, { recursive: true });

  const left = params.x * params.record.tileSize;
  const top = params.y * params.record.tileSize;
  const width = Math.min(params.record.tileSize, level.width - left);
  const height = Math.min(params.record.tileSize, level.height - top);
  const sourceLeft = left * level.scale;
  const sourceTop = top * level.scale;
  const sourceWidth = Math.min(params.record.width - sourceLeft, width * level.scale);
  const sourceHeight = Math.min(params.record.height - sourceTop, height * level.scale);

  const sourcePath = await resolveBaseOriginalPath(params.record, projectDir);

  await pipelineToFileAtomic(
    sharp(sourcePath, {
      limitInputPixels: false,
      sequentialRead: true
    })
      .extract({
        left: sourceLeft,
        top: sourceTop,
        width: sourceWidth,
        height: sourceHeight
      })
      .resize({
        width,
        height,
        fit: "fill",
        kernel: sharp.kernel.lanczos3
      })
      .jpeg({ quality: 90 }),
    tilePath
  );

  return tilePath;
}

// libvips writes JPEG bytes incrementally to disk, so a concurrent reader
// could fs.access the file mid-write and serve an incomplete JPEG. Write to
// a temp path and rename atomically — fs.rename is atomic on POSIX, so the
// canonical path only ever points at a fully-written file.
async function pipelineToFileAtomic(pipeline: sharp.Sharp, finalPath: string) {
  const tempPath = `${finalPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await pipeline.toFile(tempPath);
    await fs.rename(tempPath, finalPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function sanitizeName(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
