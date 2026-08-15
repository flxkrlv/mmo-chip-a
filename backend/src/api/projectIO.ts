/**
 * projectIO.ts — Export / Import project bundles (ZIP).
 *
 * Export:  POST /api/dies/:dieId/export-project
 * Import:  POST /api/dies/import-project
 *
 * Export modes:
 *   light — annotations + metadata + SPICE config + netlists only
 *   full  — light + original die image(s) + overlay images
 *
 * Import: accepts a ZIP (produced by export) and reconstructs the die.
 *         On conflict (existing dieId) returns 409 with die info.
 *         Use ?name=XXX to import under a new name/ID.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { ZipArchive } from "archiver";
import type { Archiver } from "archiver";
import AdmZip from "adm-zip";
import {
  preGenerateCoarseLevels,
  type OverlayImageManifest
} from "./overlayImages.js";
import { listDieRecords, readDieRecord, writeDieRecord } from "../store.js";
import type { DieRecord } from "../types.js";

// ═════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════

function sanitizeName(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function deriveId(name: string): string {
  const hash = createHash("sha256")
    .update(name + Date.now())
    .digest("hex")
    .slice(0, 12);
  return `import-${hash}`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function readJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

const SAFE_OVERLAY_SOURCE_ID = /^[a-zA-Z0-9_-]+$/;
const OVERLAY_ORIGINAL_NAME = /^original\.(?:png|jpe?g|webp)$/i;

/** Reject archive traversal and keep all imported paths within their assigned root. */
function archiveRelativePath(entryName: string, prefix: string): string | null {
  if (!entryName.startsWith(prefix)) return null;
  const relative = entryName.slice(prefix.length);
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ProjectIOError(400, `Unsafe archive path: ${entryName}`);
  }
  return relative;
}

function archiveTarget(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relative.split("/"));
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ProjectIOError(400, `Unsafe archive path: ${relative}`);
  }
  return target;
}

async function appendCompactOverlayImages(
  archive: Archiver,
  dataRoot: string,
  dieId: string
): Promise<void> {
  const overlayDir = path.join(dataRoot, "overlay-images", dieId);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(overlayDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_OVERLAY_SOURCE_ID.test(entry.name)) continue;
    const sourceDir = path.join(overlayDir, entry.name);
    const manifestFile = path.join(sourceDir, "manifest.json");
    let manifest: OverlayImageManifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestFile, "utf8")) as OverlayImageManifest;
    } catch {
      continue;
    }
    if (!manifest || manifest.id !== entry.name) continue;
    const originalName = path.basename(manifest.originalPath);
    if (!OVERLAY_ORIGINAL_NAME.test(originalName)) continue;
    const originalFile = path.join(sourceDir, originalName);
    if (!(await fileExists(originalFile))) continue;
    // Do not leak a host-specific originalPath in the portable archive.
    archive.append(
      JSON.stringify({ ...manifest, originalPath: originalName }, null, 2),
      { name: `overlay-images/${entry.name}/manifest.json` }
    );
    archive.file(originalFile, {
      name: `overlay-images/${entry.name}/${originalName}`
    });
  }
}

// ═════════════════════════════════════════════════════════════════════
// Error
// ═════════════════════════════════════════════════════════════════════

class ProjectIOError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProjectIOError";
    this.status = status;
  }
}

// ═════════════════════════════════════════════════════════════════════
// Export — queues files into an archive (does NOT finalize)
// ═════════════════════════════════════════════════════════════════════

async function queueExport(
  dataRoot: string,
  dieId: string,
  body: { mode?: string; preferences?: string | null; deviceRegistry?: string | null; analogNames?: string | null }
): Promise<{ archive: Archiver; filename: string }> {
  const record = await readDieRecord(dataRoot, dieId);
  const mode = body.mode === "full" ? "full" : "light";

  const archive: Archiver = new ZipArchive({ zlib: { level: 0 } }); // store — images already compressed
  const dieDir = path.join(dataRoot, "dies", dieId);
  const dieName = sanitizeName(record.name) || "project";
  const filename = `mmochip-${dieName}-${mode}.zip`;

  async function measure(label: string, fn: () => Promise<void>) {
    await fn();
  }

  // 1. metadata.json
  await measure("metadata.json", async () => {
    const p = path.join(dieDir, "metadata.json");
    if (await fileExists(p)) archive.file(p, { name: "metadata.json" });
  });

  // 2. annotations.json
  await measure("annotations.json", async () => {
    const p = path.join(dieDir, "annotations.json");
    if (await fileExists(p)) archive.file(p, { name: "annotations.json" });
  });

  // 3. spice_config.json (optional)
  await measure("spice_config.json", async () => {
    const p = path.join(dieDir, "spice_config.json");
    if (await fileExists(p)) archive.file(p, { name: "spice_config.json" });
  });

  // 4. export/ netlists (optional)
  await measure("export/ netlists", async () => {
    const d = path.join(dieDir, "export");
    if (await fileExists(d)) archive.directory(d, "export");
  });

  // 5. preferences.json (optional, from frontend)
  await measure("preferences.json", async () => {
    if (body.preferences) archive.append(body.preferences, { name: "preferences.json" });
  });

  // 6. device-registry.json (optional) — analog device names, overrides, UUID identity
  await measure("device-registry.json", async () => {
    if (body.deviceRegistry) archive.append(body.deviceRegistry, { name: "device-registry.json" });
  });

  // 7. analog-names.json (optional) — legacy name map
  await measure("analog-names.json", async () => {
    if (body.analogNames) archive.append(body.analogNames, { name: "analog-names.json" });
  });

  // 8. Full mode extras — iterate manually for size logging
  if (mode === "full") {
    await measure("original/ die image", async () => {
      const d = path.join(dieDir, "original");
      if (await fileExists(d)) {
        for (const f of await fs.readdir(d)) {
          const fp = path.join(d, f);
          archive.file(fp, { name: `original/${f}` });
        }
      }
    });

    await measure("overlay-images/", async () => {
      await appendCompactOverlayImages(archive, dataRoot, dieId);
    });
  }

  return { archive, filename };
}

// ═════════════════════════════════════════════════════════════════════
// Import
// ═════════════════════════════════════════════════════════════════════

async function handleImport(
  dataRoot: string,
  zipPath: string,
  renameTo?: string
): Promise<{ dieId: string; preferences: string | null; deviceRegistry: string | null; analogNames: string | null }> {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  function readEntry(name: string): string | null {
    const e = zip.getEntry(name);
    if (!e) return null;
    return e.getData().toString("utf8");
  }

  const metaRaw = readEntry("metadata.json");
  if (!metaRaw) throw new ProjectIOError(400, "ZIP must contain metadata.json");
  const meta = readJsonSafe<DieRecord>(metaRaw, null as unknown as DieRecord);
  if (!meta || !meta.id) throw new ProjectIOError(400, "Invalid metadata.json");

  let targetDieId = meta.id;
  let targetName = meta.name;

  if (renameTo) {
    targetDieId = deriveId(renameTo);
    targetName = renameTo;
  }

  const dieDir = path.join(dataRoot, "dies", targetDieId);
  if (await fileExists(dieDir)) {
    throw new ProjectIOError(
      409,
      JSON.stringify({
        error: "die_already_exists",
        dieId: targetDieId,
        name: targetName,
        originalDieId: meta.id
      })
    );
  }

  // Check name conflict — if another die has the same human-readable name, auto-suffix
  const allDies = await listDieRecords(dataRoot);
  const namesInUse = new Set(allDies.filter((d) => d.id !== targetDieId).map((d) => d.name));
  if (namesInUse.has(targetName)) {
    let suffix = 2;
    let candidate = `${targetName} (${suffix})`;
    while (namesInUse.has(candidate)) {
      suffix += 1;
      candidate = `${targetName} (${suffix})`;
    }
    targetName = candidate;
  }

  await ensureDir(path.join(dieDir, "original"));
  await ensureDir(path.join(dieDir, "tiles"));

  const annRaw = readEntry("annotations.json");
  if (annRaw) await fs.writeFile(path.join(dieDir, "annotations.json"), annRaw, "utf8");

  const scRaw = readEntry("spice_config.json");
  if (scRaw) await fs.writeFile(path.join(dieDir, "spice_config.json"), scRaw, "utf8");

  const exportRoot = path.join(dieDir, "export");
  for (const e of entries) {
    if (!e.entryName.startsWith("export/") || e.isDirectory) continue;
    const rel = archiveRelativePath(e.entryName, "export/");
    if (!rel) continue;
    const target = archiveTarget(exportRoot, rel);
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, e.getData());
  }

  // Restore original image(s) — track the restored filename to fix originalPath
  let restoredOriginalFile: string | null = null;
  for (const e of entries) {
    if (!e.entryName.startsWith("original/") || e.isDirectory) continue;
    const rel = archiveRelativePath(e.entryName, "original/");
    if (!rel) continue;
    const target = archiveTarget(path.join(dieDir, "original"), rel);
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, e.getData());
    if (!restoredOriginalFile) restoredOriginalFile = target;
  }

  // Resolve originalPath — use restored file, or scan original/ dir
  let resolvedOriginalPath = restoredOriginalFile;
  if (!resolvedOriginalPath) {
    // Try the old meta.originalPath from the ZIP
    if (meta.originalPath) {
      if (await fileExists(meta.originalPath)) {
        resolvedOriginalPath = meta.originalPath;
      } else {
        // Scan the original/ directory for any file
        const origDir = path.join(dieDir, "original");
        try {
          const files = await fs.readdir(origDir);
          for (const f of files) {
            const fp = path.join(origDir, f);
            const st = await fs.stat(fp).catch(() => null);
            if (st && st.isFile()) {
              resolvedOriginalPath = fp;
              break;
            }
          }
        } catch {
          // directory doesn't exist or can't be read
        }
      }
    }
  }

  // Log if we still couldn't find the original image
  if (!resolvedOriginalPath) {
    console.warn(`[import:${targetDieId}] ⚠️ no original image found — base image won't load. Re-import with full export or add the image manually.`);
  } else if (!(await fileExists(resolvedOriginalPath))) {
    console.warn(`[import:${targetDieId}] ⚠️ originalPath resolved but file missing: ${resolvedOriginalPath}`);
  }

  // Update die record with correct originalPath
  const updatedMeta: DieRecord = {
    ...meta,
    id: targetDieId,
    name: targetName,
    originalPath: resolvedOriginalPath ?? meta.originalPath,
    updatedAt: new Date().toISOString()
  };
  await writeDieRecord(dataRoot, updatedMeta);

  const overlayDir = path.join(dataRoot, "overlay-images", targetDieId);
  await ensureDir(overlayDir);
  const importedOverlays = new Map<
    string,
    { manifest?: Buffer; original?: { name: string; data: Buffer } }
  >();
  for (const e of entries) {
    if (!e.entryName.startsWith("overlay-images/") || e.isDirectory) continue;
    const rel = archiveRelativePath(e.entryName, "overlay-images/");
    if (!rel) continue;
    const parts = rel.split("/");
    if (parts.length !== 2 || !SAFE_OVERLAY_SOURCE_ID.test(parts[0])) {
      throw new ProjectIOError(400, `Invalid overlay archive entry: ${e.entryName}`);
    }
    const [sourceId, fileName] = parts;
    const item = importedOverlays.get(sourceId) ?? {};
    if (fileName === "manifest.json") {
      if (item.manifest) throw new ProjectIOError(400, `Duplicate overlay manifest: ${sourceId}`);
      item.manifest = e.getData();
    } else if (OVERLAY_ORIGINAL_NAME.test(fileName)) {
      if (item.original) throw new ProjectIOError(400, `Duplicate overlay original: ${sourceId}`);
      item.original = { name: fileName, data: e.getData() };
    } else {
      throw new ProjectIOError(400, `Unsupported overlay archive entry: ${e.entryName}`);
    }
    importedOverlays.set(sourceId, item);
  }
  for (const [sourceId, item] of importedOverlays) {
    if (!item.manifest || !item.original) {
      throw new ProjectIOError(400, `Overlay ${sourceId} must contain manifest.json and original image`);
    }
    const manifest = readJsonSafe<OverlayImageManifest>(
      item.manifest.toString("utf8"),
      null as unknown as OverlayImageManifest
    );
    if (!manifest || manifest.id !== sourceId) {
      throw new ProjectIOError(400, `Invalid overlay manifest: ${sourceId}`);
    }
    const sourceDir = archiveTarget(overlayDir, sourceId);
    await ensureDir(sourceDir);
    const originalPath = path.join(sourceDir, item.original.name);
    await fs.writeFile(originalPath, item.original.data);
    const reboundManifest: OverlayImageManifest = {
      ...manifest,
      id: sourceId,
      originalPath,
      originalFilename: manifest.originalFilename || item.original.name,
      size: item.original.data.length,
      ready: true,
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(
      path.join(sourceDir, "manifest.json"),
      JSON.stringify(reboundManifest, null, 2),
      "utf8"
    );
    const timer = setTimeout(() => {
      void preGenerateCoarseLevels({
        dataRoot,
        dieId: targetDieId,
        manifest: reboundManifest
      }).catch((error) => {
        console.warn("Failed to pre-generate imported overlay preview tiles", error);
      });
    }, 750);
    timer.unref?.();
  }

  return {
    dieId: targetDieId,
    preferences: readEntry("preferences.json"),
    deviceRegistry: readEntry("device-registry.json"),
    analogNames: readEntry("analog-names.json"),
  };
}

// ═════════════════════════════════════════════════════════════════════
// Express router
// ═════════════════════════════════════════════════════════════════════

export function createProjectIORouter(config: { dataRoot: string }) {
  const router = Router();
  const upload = multer({
    dest: path.join(config.dataRoot, "tmp"),
    limits: { fileSize: 1024 * 1024 * 1024 }
  });

  // ─── Export ─────────────────────────────────────────────────────
  // Write ZIP to a temp file, then serve via response.download.
  // This avoids issues with Express v5 streaming + archiver piping.

  router.post(
    "/api/dies/:dieId/export-project",
    async (request, response, next) => {
      const dieId = request.params.dieId;
      const tempDir = path.join(config.dataRoot, "tmp");
      const tempPath = path.join(tempDir, `export-${dieId}-${Date.now()}.zip`);
      try {
        const { archive, filename } = await queueExport(
          config.dataRoot,
          dieId,
          request.body ?? {}
        );

        await fs.mkdir(tempDir, { recursive: true });
        const writeStream = createWriteStream(tempPath);

        archive.pipe(writeStream);

        await new Promise<void>((resolve, reject) => {
          archive.on("error", reject);
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
          archive.finalize();
        });

        // Serve file with explicit streaming (avoid download/attachment issues)
        const stat = await fs.stat(tempPath);
        response.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": stat.size,
          "Access-Control-Allow-Origin": "*",
          "X-Filename": filename
        });

        const readStream = createReadStream(tempPath);
        await new Promise<void>((resolve, reject) => {
          readStream.pipe(response);
          readStream.on("end", resolve);
          readStream.on("error", reject);
        });

        await fs.rm(tempPath, { force: true }).catch(() => {});
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        console.error(`[export:${dieId}] failed:`, error);
        if (!response.headersSent) next(error);
      }
    }
  );

  // ─── Rename ─────────────────────────────────────────────────────

  router.put(
    "/api/dies/:dieId/rename",
    async (request, response, next) => {
      try {
        const { dieId } = request.params;
        const newName: string | undefined = request.body?.name;
        if (!newName || !newName.trim()) {
          response.status(400).json({ error: "Name is required" });
          return;
        }

        const record = await readDieRecord(config.dataRoot, dieId);
        const updated: DieRecord = {
          ...record,
          name: newName.trim(),
          updatedAt: new Date().toISOString()
        };
        await writeDieRecord(config.dataRoot, updated);
        response.json({ ok: true, name: updated.name });
      } catch (error) {
        next(error);
      }
    }
  );

  // ─── Import ─────────────────────────────────────────────────────

  router.post(
    "/api/dies/import-project",
    upload.single("file"),
    async (request, response, next) => {
      const filePath = request.file?.path;
      try {
        if (!request.file) {
          response.status(400).json({ error: "No ZIP file provided" });
          return;
        }

        const renameTo =
          typeof request.query.name === "string"
            ? request.query.name.trim() || undefined
            : undefined;

        const result = await handleImport(config.dataRoot, request.file.path, renameTo);
        await fs.rm(request.file.path, { force: true });

        response.json({
          ok: true,
          dieId: result.dieId,
          preferences: result.preferences,
          deviceRegistry: result.deviceRegistry,
          analogNames: result.analogNames
        });
      } catch (error) {
        if (filePath) await fs.rm(filePath, { force: true }).catch(() => {});

        if (error instanceof ProjectIOError) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(error.message);
          } catch {
            parsed = { error: error.message };
          }
          response.status(error.status).json(parsed);
          return;
        }
        next(error);
      }
    }
  );

  return router;
}
