// Wire the folder-picker / open-folder router into backend/src/app.ts.
// Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/app.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("createFsRouter")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting without writing`);
    process.exit(1);
  }
}

// 1) import
const importAnchor = `import { createProjectIORouter } from "./api/projectIO.js";`;
must(src.includes(importAnchor), "import");
src = src.replace(
  importAnchor,
  `${importAnchor}
import { createFsRouter } from "./api/fs.js";`
);

// 2) mount (place near the other /api/dies routers)
const mountAnchor = `  app.use(createProjectIORouter({ dataRoot: config.dataRoot, tileScheduler }));`;
must(src.includes(mountAnchor), "mount");
src = src.replace(
  mountAnchor,
  `${mountAnchor}
  app.use(createFsRouter({ dataRoot: config.dataRoot }));`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
