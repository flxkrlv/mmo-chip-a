// The project.json marker + shortcut are owned by prepareFolderProject (called
// before the import job runs); importDieShot must not write the marker itself.
// Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/dieImport/importer.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting without writing`);
    process.exit(1);
  }
}

if (!src.includes("writeProjectManifest")) {
  console.log("marker block already removed — nothing to do");
  process.exit(0);
}

// drop the marker-writing block
const blockAnchor = `  if (params.targetDir) {
    await writeProjectManifest(dieDir, {
      version: PROJECT_MANIFEST_VERSION,
      id,
      name: record.name,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  await writeDieRecord(params.dataRoot, record);`;
must(src.includes(blockAnchor), "marker block");
src = src.replace(blockAnchor, `  await writeDieRecord(params.dataRoot, record);`);

// drop the now-unused import
const importAnchor = `import {
  PROJECT_MANIFEST_VERSION,
  writeProjectManifest
} from "../projectLayout.js";
`;
must(src.includes(importAnchor), "projectLayout import");
src = src.replace(importAnchor, "");

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
