// Route all per-die path resolution in backend/src/store.ts through the
// project-layout resolver, so both managed and folder projects work.
// Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/store.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("resolveProjectDir")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting without writing`);
    process.exit(1);
  }
}

// 1) import the resolver
const importAnchor = `import type { DieAnnotations, DieIndex, DieRecord, ImportJobIndex, ImportJobRecord, UserRecord } from "./types.js";`;
must(src.includes(importAnchor), "imports");
src = src.replace(
  importAnchor,
  `${importAnchor}
import {
  resolveProjectDir,
  registerFolderShortcut,
  unregisterFolderShortcut
} from "./projectLayout.js";`
);

// 2) listDieRecords: also include remembered folder projects, and tolerate
//    unreadable managed records.
const listAnchor = `  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  const records = await Promise.all(index.dies.map((dieId) => readDieRecord(dataRoot, dieId)));

  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));`;
must(src.includes(listAnchor), "listDieRecords");
src = src.replace(
  listAnchor,
  `  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);

  const shortcuts = await listFolderShortcuts(dataRoot);
  const folderIds = shortcuts.map((s) => s.dieId);
  const allIds = Array.from(new Set([...index.dies, ...folderIds]));

  const records = await Promise.all(
    allIds.map(async (dieId) => {
      try {
        return await readDieRecord(dataRoot, dieId);
      } catch {
        return null;
      }
    })
  );

  return records
    .filter((record): record is DieRecord => record !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));`
);

// 3) readDieRecord through the resolver
const readAnchor = `export async function readDieRecord(dataRoot: string, dieId: string): Promise<DieRecord> {
  return readJson<DieRecord>(path.join(dataRoot, "dies", dieId, "metadata.json"));
}`;
must(src.includes(readAnchor), "readDieRecord");
src = src.replace(
  readAnchor,
  `export async function readDieRecord(dataRoot: string, dieId: string): Promise<DieRecord> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  return readJson<DieRecord>(path.join(dir, "metadata.json"));
}`
);

// 4) writeDieRecord: write into resolved dir; only managed projects go in index.json
const writeAnchor = `export async function writeDieRecord(dataRoot: string, record: DieRecord) {
  const dieDir = path.join(dataRoot, "dies", record.id);
  await fs.mkdir(dieDir, { recursive: true });
  await fs.writeFile(
    path.join(dieDir, "metadata.json"),
    \`\${JSON.stringify(record, null, 2)}\\n\`,
    "utf8"
  );

  const indexPath = path.join(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  if (!index.dies.includes(record.id)) {
    index.dies.push(record.id);
    await fs.writeFile(indexPath, \`\${JSON.stringify(index, null, 2)}\\n\`, "utf8");
  }
}`;
must(src.includes(writeAnchor), "writeDieRecord");
src = src.replace(
  writeAnchor,
  `export async function writeDieRecord(dataRoot: string, record: DieRecord) {
  const resolved = await resolveProjectDir(dataRoot, record.id);
  await fs.mkdir(resolved.dir, { recursive: true });
  await fs.writeFile(
    path.join(resolved.dir, "metadata.json"),
    \`\${JSON.stringify(record, null, 2)}\\n\`,
    "utf8"
  );

  if (resolved.kind === "folder") {
    // Folder projects are tracked by a local shortcut, not the managed index.
    await registerFolderShortcut(dataRoot, record.id, resolved.dir);
    return;
  }

  const indexPath = path.join(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  if (!index.dies.includes(record.id)) {
    index.dies.push(record.id);
    await fs.writeFile(indexPath, \`\${JSON.stringify(index, null, 2)}\\n\`, "utf8");
  }
}`
);

// 5) deleteDieRecord through the resolver
const deleteAnchor = `export async function deleteDieRecord(dataRoot: string, dieId: string) {
  const dieDir = path.join(dataRoot, "dies", dieId);
  await fs.rm(dieDir, { recursive: true, force: true });

  const indexPath = path.join(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  const nextDies = index.dies.filter((id) => id !== dieId);
  if (nextDies.length !== index.dies.length) {
    await fs.writeFile(indexPath, \`\${JSON.stringify({ dies: nextDies }, null, 2)}\\n\`, "utf8");
  }
}`;
must(src.includes(deleteAnchor), "deleteDieRecord");
src = src.replace(
  deleteAnchor,
  `export async function deleteDieRecord(dataRoot: string, dieId: string) {
  const resolved = await resolveProjectDir(dataRoot, dieId);

  // For managed projects remove the data; for folder projects only forget the
  // shortcut — the user's folder is theirs and must never be deleted implicitly.
  if (resolved.kind === "managed") {
    await fs.rm(resolved.dir, { recursive: true, force: true });
    await fs.rm(resolved.overlayDir, { recursive: true, force: true }).catch(() => {});
  } else {
    await unregisterFolderShortcut(dataRoot, dieId);
  }

  const indexPath = path.join(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  const nextDies = index.dies.filter((id) => id !== dieId);
  if (nextDies.length !== index.dies.length) {
    await fs.writeFile(indexPath, \`\${JSON.stringify({ dies: nextDies }, null, 2)}\\n\`, "utf8");
  }
}`
);

// 6) readAnnotations / writeAnnotations through the resolver
const readAnnAnchor = `export async function readAnnotations(dataRoot: string, dieId: string): Promise<DieAnnotations> {
  const filePath = path.join(dataRoot, "dies", dieId, "annotations.json");
  const data = await readJson<DieAnnotations>(filePath, EMPTY_ANNOTATIONS);
  return { ...EMPTY_ANNOTATIONS, ...data };
}`;
must(src.includes(readAnnAnchor), "readAnnotations");
src = src.replace(
  readAnnAnchor,
  `export async function readAnnotations(dataRoot: string, dieId: string): Promise<DieAnnotations> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const filePath = path.join(dir, "annotations.json");
  const data = await readJson<DieAnnotations>(filePath, EMPTY_ANNOTATIONS);
  return { ...EMPTY_ANNOTATIONS, ...data };
}`
);

const writeAnnAnchor = `  const nextRev = (annotations.rev ?? 0) + 1;
  const stamped: DieAnnotations = { ...annotations, rev: nextRev };
  const filePath = path.join(dataRoot, "dies", dieId, "annotations.json");
  await fs.writeFile(filePath, \`\${JSON.stringify(stamped, null, 2)}\\n\`, "utf8");
  return nextRev;`;
must(src.includes(writeAnnAnchor), "writeAnnotations");
src = src.replace(
  writeAnnAnchor,
  `  const nextRev = (annotations.rev ?? 0) + 1;
  const stamped: DieAnnotations = { ...annotations, rev: nextRev };
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "annotations.json");
  await fs.writeFile(filePath, \`\${JSON.stringify(stamped, null, 2)}\\n\`, "utf8");
  return nextRev;`
);

// 7) import the shortcut lister used by listDieRecords
src = src.replace(
  `import {
  resolveProjectDir,
  registerFolderShortcut,
  unregisterFolderShortcut
} from "./projectLayout.js";`,
  `import {
  resolveProjectDir,
  registerFolderShortcut,
  unregisterFolderShortcut,
  listFolderShortcuts
} from "./projectLayout.js";`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
