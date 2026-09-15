// Fix EXDEV: fs.rename fails across volumes (e.g. staging on C: -> folder on D:).
// Add a moveEntry() helper that falls back to copy+remove on EXDEV, and use it
// both for the staged-project move and for folder contents.
// Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/api/projectIO.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("moveEntry")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting without writing`);
    process.exit(1);
  }
}

// 1) helper: moveEntry + moveDirectoryContents uses it
const helperAnchor = `/** Move every top-level entry of \`from\` into the existing directory \`to\`. */
async function moveDirectoryContents(from: string, to: string): Promise<void> {
  await ensureDir(to);
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    // A collision should never happen for a freshly prepared folder, but guard
    // anyway so we never silently overwrite an existing artefact.
    if (await fileExists(target)) {
      throw new ProjectIOError(409, \`Target already contains \${entry.name}\`);
    }
    await fs.rename(source, target);
  }
}`;
must(src.includes(helperAnchor), "moveDirectoryContents");
src = src.replace(
  helperAnchor,
  `/**
 * Move a single path, falling back to copy+remove when the rename crosses
 * volumes (EXDEV). The application's data root and a user's project folder can
 * live on different drives (e.g. C: staging vs D: project), where rename fails.
 */
async function moveEntry(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // fs.cp preserves nested structure (files + directories).
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}

/** Move every top-level entry of \`from\` into the existing directory \`to\`. */
async function moveDirectoryContents(from: string, to: string): Promise<void> {
  await ensureDir(to);
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    // A collision should never happen for a freshly prepared folder, but guard
    // anyway so we never silently overwrite an existing artefact.
    if (await fileExists(target)) {
      throw new ProjectIOError(409, \`Target already contains \${entry.name}\`);
    }
    await moveEntry(source, target);
  }
}`
);

// 2) managed branch: fs.rename(stagedDieDir, dieDir) -> moveEntry (same-volume
//    today, but robust if dataRoot staging and target ever differ); the overlay
//    rename likewise.
const renameAnchor = `    } else {
      await fs.rename(stagedDieDir, dieDir);
      dieMoved = true;
      if (importedOverlays.size > 0) {
        await ensureDir(path.join(dataRoot, "overlay-images"));
        await fs.rename(stagedOverlayDir, overlayDir);
        overlayMoved = true;
      }
    }`;
must(src.includes(renameAnchor), "managed rename branch");
src = src.replace(
  renameAnchor,
  `    } else {
      await moveEntry(stagedDieDir, dieDir);
      dieMoved = true;
      if (importedOverlays.size > 0) {
        await ensureDir(path.join(dataRoot, "overlay-images"));
        await moveEntry(stagedOverlayDir, overlayDir);
        overlayMoved = true;
      }
    }`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
