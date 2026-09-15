// Route tile paths through the project-layout resolver and pass an explicit
// projectDir into ensureTileForRecord. CRLF-safe, idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/tileScheduler.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("resolveProjectDirSync")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting`);
    process.exit(1);
  }
}

// 1) import the resolver
const importAnchor = `import { ensureTileForRecord } from "./dieImport/importer.js";
import type { DieRecord } from "./types.js";`;
must(src.includes(importAnchor), "import");
src = src.replace(
  importAnchor,
  `import { ensureTileForRecord } from "./dieImport/importer.js";
import { resolveProjectDirSync } from "./projectLayout.js";
import type { DieRecord } from "./types.js";`
);

// 2) requestTile: compute projectDir from the record, fall back to managed
const reqAnchor = `    const tilePath = buildTilePath(config.dataRoot, record.id, z, x, y);
    try {
      await fs.access(tilePath);
      return tilePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }`;
must(src.includes(reqAnchor), "requestTile");
src = src.replace(
  reqAnchor,
  `    const projectDir = projectDirFor(record);
    const tilePath = buildTilePath(projectDir, z, x, y);
    try {
      await fs.access(tilePath);
      return tilePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }`
);

// 3) runTask: use the resolved dir for both the cache check and generation
const runAnchor = `      const expectedTilePath = buildTilePath(config.dataRoot, task.record.id, task.z, task.x, task.y);
      const wasCached = await isTilePresent(expectedTilePath);
      const tilePath = await ensureTileForRecord({
        dataRoot: config.dataRoot,
        record: task.record,
        z: task.z,
        x: task.x,
        y: task.y
      });`;
must(src.includes(runAnchor), "runTask");
src = src.replace(
  runAnchor,
  `      const projectDir = projectDirFor(task.record);
      const expectedTilePath = buildTilePath(projectDir, task.z, task.x, task.y);
      const wasCached = await isTilePresent(expectedTilePath);
      const tilePath = await ensureTileForRecord({
        dataRoot: config.dataRoot,
        record: task.record,
        z: task.z,
        x: task.x,
        y: task.y,
        projectDir
      });`
);

// 4) add the helper + change buildTilePath signature
const helperAnchor = `  function ensureProgressState(record: DieRecord) {`;
must(src.includes(helperAnchor), "helper anchor");
src = src.replace(
  helperAnchor,
  `  /**
   * Resolve the directory tiles belong to. Records carry their location, so
   * this stays synchronous on the hot tile-serving path. A managed record
   * (or one created before folder projects existed) falls back to the
   * in-dataRoot layout, preserving all previous behaviour.
   */
  function projectDirFor(record: DieRecord): string {
    return resolveProjectDirSync(
      config.dataRoot,
      record.id,
      record.location ?? "managed",
      record.folderPath
    ).dir;
  }

  function ensureProgressState(record: DieRecord) {`
);

const buildAnchor = `function buildTilePath(dataRoot: string, dieId: string, z: number, x: number, y: number) {
  return path.join(dataRoot, "dies", dieId, "tiles", String(z), \`\${x}_\${y}.jpg\`);
}`;
must(src.includes(buildAnchor), "buildTilePath");
src = src.replace(
  buildAnchor,
  `function buildTilePath(projectDir: string, z: number, x: number, y: number) {
  return path.join(projectDir, "tiles", String(z), \`\${x}_\${y}.jpg\`);
}`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
