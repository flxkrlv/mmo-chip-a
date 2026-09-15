// Let POST /api/dies/import-project land in an independent folder project when a
// targetFolder is provided (query ?folder= or body targetFolder). The folder is
// validated + registered with prepareFolderProject before extraction; conflicts
// return 409. Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/api/projectIO.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("targetFolder")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting without writing`);
    process.exit(1);
  }
}

// 1) import prepareFolderProject
const importAnchor = `import { listDieRecords, readDieRecord, writeDieRecord } from "../store.js";`;
must(src.includes(importAnchor), "store import");
src = src.replace(
  importAnchor,
  `import { listDieRecords, readDieRecord, writeDieRecord } from "../store.js";
import { prepareFolderProject } from "../projectLayout.js";`
);

// 2) handleImport signature: add targetFolder
const sigAnchor = `async function handleImport(
  dataRoot: string,
  tileScheduler: ReturnType<typeof createTileScheduler>,
  zipPath: string,
  renameTo?: string
): Promise<{ dieId: string; preferences: string | null; deviceRegistry: string | null; analogNames: string | null }> {`;
must(src.includes(sigAnchor), "handleImport signature");
src = src.replace(
  sigAnchor,
  `async function handleImport(
  dataRoot: string,
  tileScheduler: ReturnType<typeof createTileScheduler>,
  zipPath: string,
  renameTo?: string,
  targetFolder?: string
): Promise<{ dieId: string; preferences: string | null; deviceRegistry: string | null; analogNames: string | null }> {`
);

// 3) compute dieDir/overlayDir: folder target vs managed
const dirAnchor = `    dieDir = path.join(dataRoot, "dies", targetDieId);
    overlayDir = path.join(dataRoot, "overlay-images", targetDieId);
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
    if (await fileExists(overlayDir)) {
      throw new ProjectIOError(409, \`Project resources already exist for \${targetName}\`);
    }`;
must(src.includes(dirAnchor), "dir resolution");
src = src.replace(
  dirAnchor,
  `    if (targetFolder) {
      // Create (or validate) the folder project up-front so the destination is
      // registered and any conflict (already a project / not empty) fails here.
      const prepared = await prepareFolderProject(dataRoot, targetFolder, {
        name: targetName
      });
      targetDieId = prepared.id;
      targetName = prepared.name;
      dieDir = prepared.dir;
      overlayDir = path.join(prepared.dir, "overlay-images");
    } else {
      dieDir = path.join(dataRoot, "dies", targetDieId);
      overlayDir = path.join(dataRoot, "overlay-images", targetDieId);
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
      if (await fileExists(overlayDir)) {
        throw new ProjectIOError(409, \`Project resources already exist for \${targetName}\`);
      }
    }`
);

// 4) metadata: remember the folder location for folder projects
const metaAnchor = `    const updatedMeta: DieRecord = {
      ...meta,
      id: targetDieId,
      name: targetName,
      originalPath: resolvedOriginalPath ?? meta.originalPath,
      updatedAt: new Date().toISOString()
    };`;
must(src.includes(metaAnchor), "updatedMeta");
src = src.replace(
  metaAnchor,
  `    const updatedMeta: DieRecord = {
      ...meta,
      id: targetDieId,
      name: targetName,
      originalPath: resolvedOriginalPath ?? meta.originalPath,
      updatedAt: new Date().toISOString(),
      ...(targetFolder
        ? { location: "folder" as const, folderPath: dieDir, available: true }
        : {})
    };`
);

// 5) final move: into dataRoot/dis… (managed, rename) or into the existing
//    folder (folder project, move staged contents in).
const moveAnchor = `    await fs.rename(stagedDieDir, dieDir);
    dieMoved = true;
    if (importedOverlays.size > 0) {
      await ensureDir(path.join(dataRoot, "overlay-images"));
      await fs.rename(stagedOverlayDir, overlayDir);
      overlayMoved = true;
    }
    await writeDieRecord(dataRoot, updatedMeta);`;
must(src.includes(moveAnchor), "final move");
src = src.replace(
  moveAnchor,
  `    if (targetFolder) {
      // The destination folder already exists (created by prepareFolderProject);
      // move the staged contents into it instead of renaming the directory.
      await moveDirectoryContents(stagedDieDir, dieDir);
      if (importedOverlays.size > 0) {
        await ensureDir(overlayDir);
        await moveDirectoryContents(stagedOverlayDir, overlayDir);
        overlayMoved = true;
      }
      dieMoved = true;
    } else {
      await fs.rename(stagedDieDir, dieDir);
      dieMoved = true;
      if (importedOverlays.size > 0) {
        await ensureDir(path.join(dataRoot, "overlay-images"));
        await fs.rename(stagedOverlayDir, overlayDir);
        overlayMoved = true;
      }
    }
    await writeDieRecord(dataRoot, updatedMeta);`
);

// 6) cleanup: a folder project's dieDir must NOT be removed on failure — the
//    user's folder stays theirs. Only managed rename targets are cleaned up.
const cleanupAnchor = `    if (dieMoved && dieDir) await fs.rm(dieDir, { recursive: true, force: true }).catch(() => {});
    if (overlayMoved && overlayDir) await fs.rm(overlayDir, { recursive: true, force: true }).catch(() => {});`;
must(src.includes(cleanupAnchor), "cleanup");
src = src.replace(
  cleanupAnchor,
  `    if (targetFolder) {
      // Never delete the user's folder. Remove only the artefacts we moved in,
      // and unregister the shortcut so the half-created project disappears.
      if (dieMoved) await pruneProjectArtefacts(dieDir).catch(() => {});
      if (overlayMoved) await fs.rm(overlayDir, { recursive: true, force: true }).catch(() => {});
      await unregisterFolderShortcutSafe(dataRoot, targetDieId);
    } else {
      if (dieMoved && dieDir) await fs.rm(dieDir, { recursive: true, force: true }).catch(() => {});
      if (overlayMoved && overlayDir) await fs.rm(overlayDir, { recursive: true, force: true }).catch(() => {});
    }`
);

// 7) helper functions + shortcut unregister import
const helperAnchor = `// ═════════════════════════════════════════════════════════════════════
// Express router
// ═════════════════════════════════════════════════════════════════════`;
must(src.includes(helperAnchor), "router header");
src = src.replace(
  helperAnchor,
  `/** Move every top-level entry of \`from\` into the existing directory \`to\`. */
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
}

/** Remove the loose project artefacts we may have moved into a user folder. */
async function pruneProjectArtefacts(dieDir: string): Promise<void> {
  for (const artefact of ["metadata.json", "annotations.json", "spice_config.json"]) {
    await fs.rm(path.join(dieDir, artefact), { force: true }).catch(() => {});
  }
  for (const dir of ["original", "tiles", "export", "overlay-images"]) {
    await fs.rm(path.join(dieDir, dir), { recursive: true, force: true }).catch(() => {});
  }
  // Leave project.json in place? No — the project was never created successfully.
  await fs.rm(path.join(dieDir, "project.json"), { force: true }).catch(() => {});
}

async function unregisterFolderShortcutSafe(dataRoot: string, dieId: string): Promise<void> {
  await unregisterFolderShortcut(dataRoot, dieId).catch(() => {});
}

// ═════════════════════════════════════════════════════════════════════
// Express router
// ═════════════════════════════════════════════════════════════════════`
);

// 8) import unregisterFolderShortcut
src = src.replace(
  `import { prepareFolderProject } from "../projectLayout.js";`,
  `import { prepareFolderProject, unregisterFolderShortcut } from "../projectLayout.js";`
);

// 9) router: read targetFolder from query or body, pass to handleImport
const routeAnchor = `        const renameTo =
          typeof request.query.name === "string"
            ? request.query.name.trim() || undefined
            : undefined;

        const result = await handleImport(
          config.dataRoot,
          config.tileScheduler,
          request.file.path,
          renameTo
        );`;
must(src.includes(routeAnchor), "route handler");
src = src.replace(
  routeAnchor,
  `        const renameTo =
          typeof request.query.name === "string"
            ? request.query.name.trim() || undefined
            : undefined;

        const rawFolder =
          typeof request.query.folder === "string"
            ? request.query.folder
            : typeof request.body?.targetFolder === "string"
              ? request.body.targetFolder
              : undefined;
        const targetFolder = rawFolder?.trim() || undefined;

        const result = await handleImport(
          config.dataRoot,
          config.tileScheduler,
          request.file.path,
          renameTo,
          targetFolder
        );`
);

// 10) error mapping: surface prepareFolderProject's status/code as 4xx
const errAnchor = `        if (error instanceof ProjectIOError) {`;
must(src.includes(errAnchor), "ProjectIOError branch");
src = src.replace(
  errAnchor,
  `        const folderStatus = (error as { status?: number }).status;
        if (
          !(error instanceof ProjectIOError) &&
          (folderStatus === 400 || folderStatus === 409)
        ) {
          response.status(folderStatus).json({
            error: (error as { code?: string }).code ?? "folder_error",
            message: (error as Error).message
          });
          return;
        }
        if (error instanceof ProjectIOError) {`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
