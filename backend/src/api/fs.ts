/**
 * fs.ts — server-side folder picker + "open project folder" workflow.
 *
 * The application runs as a local server, so the browser cannot use the native
 * folder picker to obtain an absolute path. Instead these endpoints let the
 * frontend browse the server's filesystem and then register a chosen directory
 * as a self-contained project (see projectLayout.ts).
 *
 *   GET  /api/fs/browse            — list sub-directories of a path (roots when omitted)
 *   POST /api/dies/open-folder     — register (or create) a project in a folder
 *   POST /api/dies/:dieId/relocate — point an existing folder project at a new path
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import type {
  FsBrowseResponse,
  FsEntry,
  OpenFolderResponse
} from "shared";
import { listDieRecords, readDieRecord, writeDieRecord } from "../store.js";
import {
  PROJECT_MANIFEST_FILE,
  PROJECT_MANIFEST_VERSION,
  readProjectManifest,
  registerFolderShortcut,
  relocateFolderShortcut,
  writeProjectManifest
} from "../projectLayout.js";
import type { DieRecord } from "../types.js";
import type { createTileScheduler } from "../tileScheduler.js";

function deriveId(name: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(name + Date.now() + Math.random())
    .digest("hex")
    .slice(0, 12);
  return `folder-${hash}`;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function hasProjectMarker(target: string): Promise<boolean> {
  return (await readProjectManifest(target)) !== null;
}

/** Roots offered when the picker opens with no path (drives on Windows, / on POSIX). */
async function listRoots(): Promise<FsEntry[]> {
  if (process.platform !== "win32") {
    const home = os.homedir();
    return [{ name: "/", path: "/", isProject: false }];
  }

  const roots: FsEntry[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    if (await isDirectory(drive)) {
      roots.push({ name: drive, path: drive, isProject: false });
    }
  }
  return roots;
}

async function listDirectories(dirPath: string): Promise<FsBrowseResponse> {
  const resolved = path.resolve(dirPath);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Path vanished between clicks — fall back to the parent listing.
      const parent = path.dirname(resolved);
      if (parent !== resolved && (await isDirectory(parent))) {
        return listDirectories(parent);
      }
    }
    return {
      path: resolved,
      parent: path.dirname(resolved) === resolved ? null : path.dirname(resolved),
      directories: [],
      error: "Directory could not be read"
    };
  }

  const directories: FsEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(resolved, entry.name);
    directories.push({
      name: entry.name,
      path: entryPath,
      isProject: await hasProjectMarker(entryPath)
    });
  }
  directories.sort((a, b) => a.name.localeCompare(b.name));

  const parentDir = path.dirname(resolved);
  return {
    path: resolved,
    parent: parentDir === resolved ? null : parentDir,
    directories
  };
}

/**
 * Open (or create) a project inside an existing directory.
 *
 *  - folder already has project.json  → register it (id and name come from the marker)
 *  - folder is empty / unmarked       → create a new project with a fresh id
 *
 * On an id collision (a copied folder) we register the directory under a fresh
 * id and de-duplicate the display name, so both copies stay usable.
 */
async function openFolder(
  dataRoot: string,
  tileScheduler: ReturnType<typeof createTileScheduler>,
  folderPath: string,
  requestedName?: string
): Promise<OpenFolderResponse> {
  const resolved = path.resolve(folderPath);
  if (!(await isDirectory(resolved))) {
    throw Object.assign(new Error("Folder does not exist"), { status: 400 });
  }

  const manifest = await readProjectManifest(resolved);
  const records = await listDieRecords(dataRoot);
  const namesInUse = new Set(records.map((r) => r.name));
  const idsInUse = new Set(records.map((r) => r.id));

  const now = new Date().toISOString();
  let dieId: string;
  let name: string;
  let renamed = false;
  let existing: boolean;

  if (manifest) {
    existing = true;
    dieId = manifest.id;
    name = requestedName?.trim() || manifest.name;

    // A copied folder keeps its id; if that id is already registered elsewhere
    // on this machine, treat the copy as a new project.
    if (idsInUse.has(dieId)) {
      dieId = deriveId(name);
      renamed = true;
    }
  } else {
    existing = false;
    name = requestedName?.trim() || path.basename(resolved) || "project";
    dieId = deriveId(name);
  }

  if (namesInUse.has(name)) {
    let suffix = 2;
    let candidate = `${name} (${suffix})`;
    while (namesInUse.has(candidate)) {
      suffix += 1;
      candidate = `${name} (${suffix})`;
    }
    name = candidate;
    renamed = true;
  }

  // Ensure the marker exists (writes it for new projects, refreshes for copies).
  await writeProjectManifest(resolved, {
    version: PROJECT_MANIFEST_VERSION,
    id: dieId,
    name,
    createdAt: manifest?.createdAt ?? now,
    updatedAt: now
  });

  await registerFolderShortcut(dataRoot, dieId, resolved);

  // This id may have been tombstoned by an earlier delete; re-opening the
  // folder revives it so the scheduler serves its tiles again.
  tileScheduler.reviveDie(dieId);

  // Materialise a metadata.json if the folder came without one, so the record
  // is readable immediately. Remember the folder location on the record.
  const hasMetadata = await fs
    .access(path.join(resolved, "metadata.json"))
    .then(() => true, () => false);
  if (hasMetadata) {
    const record = await readDieRecord(dataRoot, dieId);
    await writeDieRecord(dataRoot, {
      ...record,
      location: "folder",
      folderPath: resolved,
      updatedAt: now
    });
  }

  return { ok: true, dieId, name, renamed, existing };
}

export function createFsRouter(config: {
  dataRoot: string;
  tileScheduler: ReturnType<typeof createTileScheduler>;
}) {
  const router = Router();

  router.get("/api/fs/browse", async (request, response, next) => {
    try {
      const raw = typeof request.query.path === "string" ? request.query.path : "";
      if (!raw) {
        response.json({
          path: null,
          parent: null,
          roots: await listRoots(),
          directories: []
        } satisfies FsBrowseResponse);
        return;
      }
      response.json(await listDirectories(raw));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/dies/open-folder", async (request, response, next) => {
    try {
      const body = request.body ?? {};
      const folderPath: string | undefined =
        typeof body.path === "string" ? body.path : undefined;
      if (!folderPath || !folderPath.trim()) {
        response.status(400).json({ error: "Folder path is required" });
        return;
      }
      const result = await openFolder(
        config.dataRoot,
        config.tileScheduler,
        folderPath,
        typeof body.name === "string" ? body.name : undefined
      );
      response.json(result);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 400) {
        response.status(400).json({ error: (error as Error).message });
        return;
      }
      next(error);
    }
  });

  router.post("/api/dies/:dieId/relocate", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const newPath: string | undefined =
        typeof request.body?.path === "string" ? request.body.path : undefined;
      if (!newPath || !newPath.trim()) {
        response.status(400).json({ error: "Folder path is required" });
        return;
      }
      const resolved = path.resolve(newPath);
      const manifest = await readProjectManifest(resolved);
      if (!manifest) {
        response.status(400).json({ error: `No ${PROJECT_MANIFEST_FILE} found in that folder` });
        return;
      }
      if (manifest.id !== dieId) {
        response.status(409).json({
          error: "project_id_mismatch",
          expected: dieId,
          found: manifest.id
        });
        return;
      }

      await relocateFolderShortcut(config.dataRoot, dieId, resolved);
      config.tileScheduler.reviveDie(dieId);

      const hasMetadata = await fs
        .access(path.join(resolved, "metadata.json"))
        .then(() => true, () => false);
      if (hasMetadata) {
        const record: DieRecord = await readDieRecord(config.dataRoot, dieId);
        await writeDieRecord(config.dataRoot, {
          ...record,
          location: "folder",
          folderPath: resolved,
          updatedAt: new Date().toISOString()
        });
      }

      response.json({ ok: true, dieId, path: resolved });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
