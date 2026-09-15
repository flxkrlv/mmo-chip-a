// Route per-die paths in backend/src/api/tiles.ts through the project-layout
// resolver. CRLF-safe, idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/api/tiles.ts";
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

// 1) import
const importAnchor = `import { readAnnotations, readDieRecord } from "../store.js";`;
must(src.includes(importAnchor), "import");
src = src.replace(
  importAnchor,
  `import { readAnnotations, readDieRecord } from "../store.js";
import { resolveProjectDir } from "../projectLayout.js";`
);

// 2) resolveCropOriginalPath — base original dir
const cropAnchor = `  const originalDir = path.join(params.dataRoot, "dies", params.dieId, "original");
  const files = await fs.readdir(originalDir);
  return files.length > 0 ? path.join(originalDir, files[0]) : null;
}`;
must(src.includes(cropAnchor), "resolveCropOriginalPath");
src = src.replace(
  cropAnchor,
  `  const { dir } = await resolveProjectDir(params.dataRoot, params.dieId);
  const originalDir = path.join(dir, "original");
  const files = await fs.readdir(originalDir);
  return files.length > 0 ? path.join(originalDir, files[0]) : null;
}`
);

// 3) cropCachePath — takes a resolved project dir instead of dataRoot
const cacheAnchor = `function cropCachePath(params: {
  dataRoot: string;
  dieId: string;
  overlaySourceId: string | undefined;
  basename: string;
}): string {
  const cacheDir = path.join(
    params.dataRoot,
    "dies",
    params.dieId,
    "cell-crops"
  );`;
must(src.includes(cacheAnchor), "cropCachePath");
src = src.replace(
  cacheAnchor,
  `function cropCachePath(params: {
  projectDir: string;
  overlaySourceId: string | undefined;
  basename: string;
}): string {
  const cacheDir = path.join(
    params.projectDir,
    "cell-crops"
  );`
);

// 4) first crop route: compute projectDir, use it for cache + base original
const cellCropAnchor = `      const rawOverlaySourceId = request.query.overlaySourceId;
      const overlaySourceId =
        typeof rawOverlaySourceId === "string" ? rawOverlaySourceId : undefined;
      const cachePath = cropCachePath({
        dataRoot: config.dataRoot,
        dieId,
        overlaySourceId,
        basename: \`\${cellId}-\${left}-\${top}.jpg\`
      });`;
must(src.includes(cellCropAnchor), "cell crop cache");
src = src.replace(
  cellCropAnchor,
  `      const rawOverlaySourceId = request.query.overlaySourceId;
      const overlaySourceId =
        typeof rawOverlaySourceId === "string" ? rawOverlaySourceId : undefined;
      const { dir: projectDir } = await resolveProjectDir(config.dataRoot, dieId);
      const cachePath = cropCachePath({
        projectDir,
        overlaySourceId,
        basename: \`\${cellId}-\${left}-\${top}.jpg\`
      });`
);

const baseImgAnchor = `      // Always resolve the base image (die photo)
      const originalDir = path.join(config.dataRoot, "dies", dieId, "original");
      const originalFiles = await fs.readdir(originalDir);
      const basePath = originalFiles.length > 0 ? path.join(originalDir, originalFiles[0]) : null;`;
must(src.includes(baseImgAnchor), "base image crop");
src = src.replace(
  baseImgAnchor,
  `      // Always resolve the base image (die photo)
      const originalDir = path.join(projectDir, "original");
      const originalFiles = await fs.readdir(originalDir);
      const basePath = originalFiles.length > 0 ? path.join(originalDir, originalFiles[0]) : null;`
);

// 5) cell-type crop route: compute projectDir, use for cache
const ctAnchor = `      const rawOverlaySourceId = request.query.overlaySourceId;
      const overlaySourceId =
        typeof rawOverlaySourceId === "string" ? rawOverlaySourceId : undefined;
      const cachePath = cropCachePath({
        dataRoot: config.dataRoot,
        dieId,
        overlaySourceId,
        basename: \`ct-\${cellTypeId}.jpg\`
      });`;
must(src.includes(ctAnchor), "cell type crop cache");
src = src.replace(
  ctAnchor,
  `      const rawOverlaySourceId = request.query.overlaySourceId;
      const overlaySourceId =
        typeof rawOverlaySourceId === "string" ? rawOverlaySourceId : undefined;
      const { dir: projectDir } = await resolveProjectDir(config.dataRoot, dieId);
      const cachePath = cropCachePath({
        projectDir,
        overlaySourceId,
        basename: \`ct-\${cellTypeId}.jpg\`
      });`
);

// 6) /image preview route
const imageAnchor = `      const originalDir = path.join(config.dataRoot, "dies", dieId, "original");
      const files = await fs.readdir(originalDir);
      if (files.length === 0) {
        response.status(404).json({ error: "Image not found" });
        return;
      }
      const sourcePath = path.join(originalDir, files[0]);
      const previewPath = await ensurePreviewImage({
        sourcePath,
        cachePath: path.join(
          config.dataRoot,
          "dies",
          dieId,
          "previews",
          \`\${path.parse(files[0]).name}.4096.jpg\`
        )
      });`;
must(src.includes(imageAnchor), "image route");
src = src.replace(
  imageAnchor,
  `      const { dir: projectDir } = await resolveProjectDir(config.dataRoot, dieId);
      const originalDir = path.join(projectDir, "original");
      const files = await fs.readdir(originalDir);
      if (files.length === 0) {
        response.status(404).json({ error: "Image not found" });
        return;
      }
      const sourcePath = path.join(originalDir, files[0]);
      const previewPath = await ensurePreviewImage({
        sourcePath,
        cachePath: path.join(
          projectDir,
          "previews",
          \`\${path.parse(files[0]).name}.4096.jpg\`
        )
      });`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
