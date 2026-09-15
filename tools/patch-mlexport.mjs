// Route the overlay dir in mlExport/exporter.ts through the resolver.
// ml_exports/ output stays under dataRoot (it is a derived export area, not
// project data). CRLF-safe, idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/mlExport/exporter.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("resolveProjectDir")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting`);
    process.exit(1);
  }
}

const importAnchor = `import { readAnnotations, readDieRecord } from "../store.js";`;
must(src.includes(importAnchor), "import");
src = src.replace(
  importAnchor,
  `import { readAnnotations, readDieRecord } from "../store.js";
import { resolveProjectDir } from "../projectLayout.js";`
);

const overlayAnchor = `    const overlayDir = path.join(dataRoot, "overlay-images", dieId);
    sourcePath = path.join(overlayDir, overlayFilename);`;
must(src.includes(overlayAnchor), "overlay dir");
src = src.replace(
  overlayAnchor,
  `    const { overlayDir } = await resolveProjectDir(dataRoot, dieId);
    sourcePath = path.join(overlayDir, overlayFilename);`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
