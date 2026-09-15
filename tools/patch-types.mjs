// One-off patch: add project-location types to shared/src/types.ts
// Idempotent: bails out if the marker already exists.
import { readFileSync, writeFileSync } from "node:fs";

const file = "shared/src/types.ts";
const raw = readFileSync(file, "utf8");
// The file uses CRLF; normalise to LF for matching, restore CRLF on write.
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("ProjectLocationKind")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

const anchor = `export interface DieMetadata extends DieSummary {
  tileFormat: "jpg" | "png";
  levels: DieLevelMetadata[];
}
`;

if (!src.includes(anchor)) {
  console.error("ANCHOR NOT FOUND — aborting without writing");
  process.exit(1);
}

const replacement = `export interface DieMetadata extends DieSummary {
  tileFormat: "jpg" | "png";
  levels: DieLevelMetadata[];
}

// ── Project location ──────────────────────────────────────────────

/**
 * How a project's source data is stored.
 *  - managed: inside the application data root, at \`<dataRoot>/dies/<dieId>\`.
 *             Default (legacy) mode; portable via ZIP export / import.
 *  - folder:  a self-contained directory the user picked, living outside the
 *             application. The folder is the single source of truth, so it can
 *             be copied to a USB stick or synced (Dropbox / OneDrive) and
 *             opened on another machine without any export step.
 */
export type ProjectLocationKind = "managed" | "folder";

/**
 * Marker file (\`project.json\`) written at the root of every folder project.
 * Its presence is what turns an arbitrary directory into an openable project.
 */
export interface ProjectManifest {
  /** Layout version; bumped only on an incompatible change. */
  version: 1;
  /** Stable project id. A copied folder keeps this id; on collision the copy
   *  is registered under a fresh id with a "chip (2)" style name. */
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenFolderRequest {
  /** Absolute path of the project directory to open. */
  path: string;
  /** Optional name for the project when creating a new one in an empty folder. */
  name?: string;
  /** Source image path when creating a brand-new project inside the folder. */
  importImagePath?: string;
}

export interface OpenFolderResponse {
  ok: true;
  dieId: string;
  /** Final (possibly suffixed) project name after de-duplication. */
  name: string;
  /** True when a name/id clash forced a "chip (2)" style suffix. */
  renamed: boolean;
  /** True when the folder already contained a project.json and was registered. */
  existing: boolean;
}

export interface RelocateProjectRequest {
  dieId: string;
  /** New absolute path of the (moved) project directory. */
  path: string;
}

/** One directory entry in the server-side folder picker. */
export interface FsEntry {
  name: string;
  path: string;
  /** True when the directory carries a project.json marker. */
  isProject: boolean;
}

export interface FsBrowseResponse {
  /** Absolute path of the listed directory, or null for the roots listing. */
  path: string | null;
  parent: string | null;
  /** Explicit roots (drives / home) returned when \`path\` is null. */
  roots?: FsEntry[];
  directories: FsEntry[];
  /** Set when the directory exists but could not be read (permissions). */
  error?: string;
}
`;

// 1) add the new types after DieMetadata
src = src.replace(anchor, replacement);

// 2) add the location fields to DieSummary
const summaryAnchor = `  createdAt: string;
  updatedAt: string;
  tileProgress?: DieTileProgress;
  overlayTileProgress?: OverlayTileProgress;
}`;

if (!src.includes(summaryAnchor)) {
  console.error("SUMMARY ANCHOR NOT FOUND — aborting without writing");
  process.exit(1);
}

src = src.replace(
  summaryAnchor,
  `  createdAt: string;
  updatedAt: string;
  tileProgress?: DieTileProgress;
  overlayTileProgress?: OverlayTileProgress;
  /** Where the project's source data lives. Absent ⇒ "managed" (legacy records). */
  location?: ProjectLocationKind;
  /** False when a folder project's directory is missing or unreadable on this machine. */
  available?: boolean;
  /** Absolute directory for folder projects; undefined for managed projects. */
  folderPath?: string;
}`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");

