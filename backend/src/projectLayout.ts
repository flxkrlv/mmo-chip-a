/**
 * projectLayout.ts — single source of truth for "where does this project live?".
 *
 * A project can be stored two ways:
 *
 *   managed (default, legacy)
 *     `<dataRoot>/dies/<dieId>/`          - data lives inside the app's data dir
 *     `<dataRoot>/overlay-images/<dieId>/`
 *     Portable between machines via the ZIP export / import workflow.
 *
 *   folder (new)
 *     an arbitrary directory the user picked, living outside the application.
 *     The folder itself is the single source of truth and contains a
 *     `project.json` marker. Copying the folder to another machine (USB stick,
 *     Dropbox, OneDrive...) carries the whole project - no export step needed.
 *
 * Everything that resolves a per-project path MUST go through
 * `resolveProjectDir()` / `resolveOverlayDir()` so both modes work everywhere.
 * Global (non-project) paths - users, jobs, ml-jobs, reference-library, tmp -
 * are unaffected and stay under <dataRoot>.
 */

import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { ProjectLocationKind, ProjectManifest } from "shared";

/** Marker file name inside every folder project. */
export const PROJECT_MANIFEST_FILE = "project.json";

/** Current on-disk layout version of a folder project. */
export const PROJECT_MANIFEST_VERSION = 1 as const;

export interface ResolvedProjectDir {
  /** Root directory holding metadata.json / annotations.json / tiles / original. */
  dir: string;
  /** Root directory holding overlay sources (overlay-images/<sourceId>/...). */
  overlayDir: string;
  kind: ProjectLocationKind;
  /** False when a folder project's directory is missing or unreadable. */
  available: boolean;
}

/**
 * Last-known display fields of a folder project, captured whenever its
 * metadata is written. Used to render a degraded "folder missing" card
 * (and offer Relocate) when the project directory is unavailable.
 */
interface FolderShortcutSnapshot {
  name: string;
  width: number;
  height: number;
  originalFilename: string;
  createdAt: string;
}

/** A folder-project shortcut remembered on this machine. */
interface FolderShortcut {
  dieId: string;
  folderPath: string;
  /** Optional; present once the project has written metadata at least once. */
  snapshot?: FolderShortcutSnapshot;
}

/**
 * Local shortcut registry. This is NOT the source of truth - the source of
 * truth is `project.json` inside the project folder itself. The registry only
 * remembers which external folders this machine has opened, so those projects
 * can appear in the library list without re-picking them.
 */
const SHORTCUTS_FILE = "folder-projects.json";

// Keyed by dataRoot: a single process may serve several data roots (tests,
// embedding), and a shared cache leaked shortcuts between them.
const shortcutCache = new Map<string, FolderShortcut[]>();

function shortcutsPath(dataRoot: string): string {
  return path.join(dataRoot, SHORTCUTS_FILE);
}

async function readShortcuts(dataRoot: string): Promise<FolderShortcut[]> {
  const key = path.resolve(dataRoot);
  const cached = shortcutCache.get(key);
  if (cached) return cached;
  let list: FolderShortcut[];
  try {
    const raw = await fs.readFile(shortcutsPath(dataRoot), "utf8");
    const parsed = JSON.parse(raw) as FolderShortcut[];
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    list = [];
  }
  shortcutCache.set(key, list);
  return list;
}

async function writeShortcuts(dataRoot: string, list: FolderShortcut[]): Promise<void> {
  shortcutCache.set(path.resolve(dataRoot), list);
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(
    shortcutsPath(dataRoot),
    `${JSON.stringify(list, null, 2)}\n`,
    "utf8"
  );
}

/** Remember (or update) a folder project so it stays in the library list. */
export async function registerFolderShortcut(
  dataRoot: string,
  dieId: string,
  folderPath: string,
  snapshot?: FolderShortcutSnapshot
): Promise<void> {
  const existing = (await readShortcuts(dataRoot)).find((s) => s.dieId === dieId);
  const list = (await readShortcuts(dataRoot)).filter((s) => s.dieId !== dieId);
  list.push({
    dieId,
    folderPath: path.resolve(folderPath),
    // Keep the previous snapshot unless a fresh one is supplied.
    ...(snapshot ? { snapshot } : existing?.snapshot ? { snapshot: existing.snapshot } : {})
  });
  await writeShortcuts(dataRoot, list);
}

/** Forget a folder project (used when the project is deleted). */
export async function unregisterFolderShortcut(
  dataRoot: string,
  dieId: string
): Promise<void> {
  const list = (await readShortcuts(dataRoot)).filter((s) => s.dieId !== dieId);
  await writeShortcuts(dataRoot, list);
}

/** Point an existing folder project at a new directory (user moved the folder). */
export async function relocateFolderShortcut(
  dataRoot: string,
  dieId: string,
  folderPath: string,
  snapshot?: FolderShortcutSnapshot
): Promise<void> {
  await registerFolderShortcut(dataRoot, dieId, folderPath, snapshot);
}

/** All remembered folder shortcuts on this machine. */
export async function listFolderShortcuts(
  dataRoot: string
): Promise<ReadonlyArray<FolderShortcut>> {
  return readShortcuts(dataRoot);
}

/** Look up the folder path remembered for a dieId, if any. */
export async function findFolderShortcut(
  dataRoot: string,
  dieId: string
): Promise<FolderShortcut | null> {
  const list = await readShortcuts(dataRoot);
  return list.find((s) => s.dieId === dieId) ?? null;
}

// -- Path helpers ------------------------------------------------

/** Managed-mode project directory. */
export function managedProjectDir(dataRoot: string, dieId: string): string {
  return path.join(dataRoot, "dies", dieId);
}

/** Managed-mode overlay directory. */
export function managedOverlayDir(dataRoot: string, dieId: string): string {
  return path.join(dataRoot, "overlay-images", dieId);
}

/** Read the `project.json` marker from a candidate project directory. */
export async function readProjectManifest(
  folderPath: string
): Promise<ProjectManifest | null> {
  try {
    const raw = await fs.readFile(
      path.join(folderPath, PROJECT_MANIFEST_FILE),
      "utf8"
    );
    const parsed = JSON.parse(raw) as ProjectManifest;
    if (!parsed || typeof parsed.id !== "string" || !parsed.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write the `project.json` marker into a project folder. */
export async function writeProjectManifest(
  folderPath: string,
  manifest: ProjectManifest
): Promise<void> {
  await fs.mkdir(folderPath, { recursive: true });
  await fs.writeFile(
    path.join(folderPath, PROJECT_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
}

/** A fresh identity for a project that lives in an independent folder. */
export function deriveFolderProjectId(seed: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(seed + Date.now() + Math.random())
    .digest("hex")
    .slice(0, 12);
  return `folder-${hash}`;
}

export interface PreparedFolderProject {
  dir: string;
  id: string;
  name: string;
}

/**
 * Turn an existing directory into a brand-new folder project.
 *
 * Used by the import flows when the user chooses to create the project in an
 * independent folder ("save to folder"). The directory must be completely
 * empty - we never write into a folder that already holds anything (a project
 * we would clobber, or unrelated user files we would mix into the project).
 *
 * Throws an error carrying a `status` for the caller to surface:
 *   - 400 folder_missing    - the path is not an existing directory
 *   - 409 project_exists    - a project.json is already present
 *   - 409 folder_not_empty  - the folder contains any other entry at all
 */
export async function prepareFolderProject(
  dataRoot: string,
  folderPath: string,
  options: { name: string; id?: string }
): Promise<PreparedFolderProject> {
  const dir = path.resolve(folderPath);

  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw Object.assign(new Error("Folder does not exist"), {
      status: 400,
      code: "folder_missing"
    });
  }
  if (!stat.isDirectory()) {
    throw Object.assign(new Error("Path is not a folder"), {
      status: 400,
      code: "folder_missing"
    });
  }

  if (await readProjectManifest(dir)) {
    throw Object.assign(new Error("Folder already contains a project"), {
      status: 409,
      code: "project_exists"
    });
  }

  // The destination folder must be completely empty. We never create a project
  // alongside pre-existing content: that would either clobber a project copied
  // without its marker, or silently mix unrelated user files into the project.
  const existing = await fs.readdir(dir);
  if (existing.length > 0) {
    throw Object.assign(
      new Error("Folder is not empty (must be completely empty)"),
      {
        status: 409,
        code: "folder_not_empty"
      }
    );
  }

  const id =
    options.id ??
    deriveFolderProjectId(options.name || path.basename(dir) || "project");
  const now = new Date().toISOString();
  await writeProjectManifest(dir, {
    version: PROJECT_MANIFEST_VERSION,
    id,
    name: options.name || path.basename(dir) || "project",
    createdAt: now,
    updatedAt: now
  });
  await registerFolderShortcut(dataRoot, id, dir);

  return { dir, id, name: options.name };
}

/**
 * Resolve where a project's files live. Falls back to the managed layout when
 * no folder shortcut is registered, so all existing behaviour is preserved.
 */
export async function resolveProjectDir(
  dataRoot: string,
  dieId: string
): Promise<ResolvedProjectDir> {
  const shortcut = await findFolderShortcut(dataRoot, dieId);
  if (!shortcut) {
    return {
      dir: managedProjectDir(dataRoot, dieId),
      overlayDir: managedOverlayDir(dataRoot, dieId),
      kind: "managed",
      available: true
    };
  }

  const dir = path.resolve(shortcut.folderPath);
  let available = false;
  try {
    const stat = await fs.stat(dir);
    available = stat.isDirectory();
  } catch {
    available = false;
  }

  return {
    dir,
    overlayDir: path.join(dir, "overlay-images"),
    kind: "folder",
    available
  };
}

/**
 * Synchronous variant for hot paths (tile serving) that already know the path
 * kind. Prefer `resolveProjectDir()` everywhere else.
 */
export function resolveProjectDirSync(
  dataRoot: string,
  dieId: string,
  kind: ProjectLocationKind,
  folderPath?: string
): ResolvedProjectDir {
  if (kind === "folder" && folderPath) {
    const dir = path.resolve(folderPath);
    return {
      dir,
      overlayDir: path.join(dir, "overlay-images"),
      kind: "folder",
      available: true
    };
  }
  return {
    dir: managedProjectDir(dataRoot, dieId),
    overlayDir: managedOverlayDir(dataRoot, dieId),
    kind: "managed",
    available: true
  };
}
