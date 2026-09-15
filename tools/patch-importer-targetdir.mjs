// Let importDieShot target an existing folder (creating a folder project)
// instead of always writing under <dataRoot>/dies/<uuid>.
// Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/dieImport/importer.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("targetDir")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting without writing`);
    process.exit(1);
  }
}

// 1) import the manifest helpers + version constant
const importAnchor = `import { writeDieRecord } from "../store.js";`;
must(src.includes(importAnchor), "store import");
src = src.replace(
  importAnchor,
  `import { writeDieRecord } from "../store.js";
import {
  PROJECT_MANIFEST_FILE,
  PROJECT_MANIFEST_VERSION,
  writeProjectManifest
} from "../projectLayout.js";`
);

// 2) params: add optional targetDir / targetId
const paramsAnchor = `  tileSize: number;
  limitInputPixels: number | false;
  tileConcurrency: number;
  onProgress?: (update: ImportProgressUpdate) => Promise<void> | void;
  logger?: (message: string) => void;
}): Promise<DieRecord> {`;
must(src.includes(paramsAnchor), "params");
src = src.replace(
  paramsAnchor,
  `  tileSize: number;
  limitInputPixels: number | false;
  tileConcurrency: number;
  /** Import straight into this existing directory (creates a folder project). */
  targetDir?: string;
  /** Project id to use when targeting a folder (already registered as a shortcut). */
  targetId?: string;
  onProgress?: (update: ImportProgressUpdate) => Promise<void> | void;
  logger?: (message: string) => void;
}): Promise<DieRecord> {`
);

// 3) id + dieDir computation
const idAnchor = `  const id = crypto.randomUUID();
  const extension = params.mimeType === "image/png" ? "png" : "jpg";
  const dieDir = path.join(params.dataRoot, "dies", id);`;
must(src.includes(idAnchor), "id/dieDir");
src = src.replace(
  idAnchor,
  `  const id = params.targetDir ? params.targetId ?? crypto.randomUUID() : crypto.randomUUID();
  const extension = params.mimeType === "image/png" ? "png" : "jpg";
  const dieDir = params.targetDir ? path.resolve(params.targetDir) : path.join(params.dataRoot, "dies", id);`
);

// 4) record: remember the folder location for folder projects
const recordAnchor = `    levels,
    createdAt: timestamp,
    updatedAt: timestamp
  };`;
must(src.includes(recordAnchor), "record literal");
src = src.replace(
  recordAnchor,
  `    levels,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(params.targetDir
      ? { location: "folder" as const, folderPath: dieDir }
      : {})
  };`
);

// 5) before writing the record, refresh the project marker so the folder is
//    self-describing (the shortcut is registered by the caller).
const persistAnchor = `  await writeDieRecord(params.dataRoot, record);`;
must(src.includes(persistAnchor), "writeDieRecord call");
src = src.replace(
  persistAnchor,
  `  if (params.targetDir) {
    await writeProjectManifest(dieDir, {
      version: PROJECT_MANIFEST_VERSION,
      id,
      name: record.name,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  await writeDieRecord(params.dataRoot, record);`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
