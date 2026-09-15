// Route overlay-image paths through the project-layout resolver. The overlay
// dir becomes async (resolver is async); all call-sites already run inside
// async functions. CRLF-safe, idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/api/overlayImages.ts";
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
const importAnchor = `import { buildLevels } from "../dieImport/importer.js";`;
must(src.includes(importAnchor), "import");
src = src.replace(
  importAnchor,
  `import { buildLevels } from "../dieImport/importer.js";
import { resolveProjectDir } from "../projectLayout.js";`
);

// 2) async path helpers, overlay dir comes from the resolver
const helpers = `function dieOverlayDir(dataRoot: string, dieId: string): string {
  assertSafeId(dieId);
  return path.join(dataRoot, "overlay-images", dieId);
}

function sourceDir(dataRoot: string, dieId: string, id: string): string {
  assertSafeId(id);
  return path.join(dieOverlayDir(dataRoot, dieId), id);
}

function manifestPath(dataRoot: string, dieId: string, id: string): string {
  return path.join(sourceDir(dataRoot, dieId, id), "manifest.json");
}`;
must(src.includes(helpers), "helpers");
src = src.replace(
  helpers,
  `async function dieOverlayDir(dataRoot: string, dieId: string): Promise<string> {
  assertSafeId(dieId);
  return (await resolveProjectDir(dataRoot, dieId)).overlayDir;
}

async function sourceDir(dataRoot: string, dieId: string, id: string): Promise<string> {
  assertSafeId(id);
  return path.join(await dieOverlayDir(dataRoot, dieId), id);
}

async function manifestPath(dataRoot: string, dieId: string, id: string): Promise<string> {
  return path.join(await sourceDir(dataRoot, dieId, id), "manifest.json");
}`
);

// 3) readManifest
const readAnchor = `    const raw = await fs.readFile(manifestPath(dataRoot, dieId, id), "utf8");`;
must(src.includes(readAnchor), "readManifest");
src = src.replace(
  readAnchor,
  `    const raw = await fs.readFile(await manifestPath(dataRoot, dieId, id), "utf8");`
);

// 4) listFullManifests
const listAnchor = `  const dir = dieOverlayDir(dataRoot, dieId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const manifests = await Promise.all(`;
must(src.includes(listAnchor), "listFullManifests");
src = src.replace(
  listAnchor,
  `  const dir = await dieOverlayDir(dataRoot, dieId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const manifests = await Promise.all(`
);

// 5) listLegacyFiles
const legacyAnchor = `    const dir = dieOverlayDir(dataRoot, dieId);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const images = await Promise.all(`;
must(src.includes(legacyAnchor), "listLegacyFiles");
src = src.replace(
  legacyAnchor,
  `    const dir = await dieOverlayDir(dataRoot, dieId);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const images = await Promise.all(`
);

// 6) ensureTile target
const ensureTileAnchor = `  const target = path.join(
    sourceDir(params.dataRoot, params.dieId, params.manifest.id),
    "tiles",
    String(params.z),
    \`\${params.x}_\${params.y}.\${params.manifest.tileFormat}\`
  );`;
must(src.includes(ensureTileAnchor), "ensureTile target");
src = src.replace(
  ensureTileAnchor,
  `  const target = path.join(
    await sourceDir(params.dataRoot, params.dieId, params.manifest.id),
    "tiles",
    String(params.z),
    \`\${params.x}_\${params.y}.\${params.manifest.tileFormat}\`
  );`
);

// 7) ensureTileImpl target
const implAnchor = `  const target = path.join(
    sourceDir(params.dataRoot, params.dieId, manifest.id),
    "tiles",
    String(z),
    \`\${x}_\${y}.\${ext}\`
  );`;
must(src.includes(implAnchor), "ensureTileImpl target");
src = src.replace(
  implAnchor,
  `  const target = path.join(
    await sourceDir(params.dataRoot, params.dieId, manifest.id),
    "tiles",
    String(z),
    \`\${x}_\${y}.\${ext}\`
  );`
);

// 8) preGenerateFullPyramid root
const prebuildAnchor = `      const root = sourceDir(params.dataRoot, params.dieId, params.manifest.id);`;
must(src.includes(prebuildAnchor), "prebuild root");
src = src.replace(
  prebuildAnchor,
  `      const root = await sourceDir(params.dataRoot, params.dieId, params.manifest.id);`
);

// 9) getOverlayTileProgress countTileFiles
const progressAnchor = `    await countTileFiles(path.join(sourceDir(dataRoot, dieId, manifest.id), "tiles"), manifest.tileFormat)`;
must(src.includes(progressAnchor), "progress countTileFiles");
src = src.replace(
  progressAnchor,
  `    await countTileFiles(path.join(await sourceDir(dataRoot, dieId, manifest.id), "tiles"), manifest.tileFormat)`
);

// 10) upload source dir
const uploadAnchor = `        const dir = sourceDir(config.dataRoot, dieId, id);
        await fs.mkdir(dir, { recursive: true });`;
must(src.includes(uploadAnchor), "upload dir");
src = src.replace(
  uploadAnchor,
  `        const dir = await sourceDir(config.dataRoot, dieId, id);
        await fs.mkdir(dir, { recursive: true });`
);

// 11) legacy original route
const legacyRouteAnchor = `      const filePath = path.join(dieOverlayDir(config.dataRoot, dieId), safeName);`;
must(src.includes(legacyRouteAnchor), "legacy route");
src = src.replace(
  legacyRouteAnchor,
  `      const filePath = path.join(await dieOverlayDir(config.dataRoot, dieId), safeName);`
);

// 12) /original preview cachePath -> project dir
const previewAnchor = `      const previewPath = await ensurePreviewImage({
        sourcePath: originalPath,
        cachePath: path.join(
          config.dataRoot,
          "dies",
          request.params.dieId,
          "previews",
          \`overlay-\${request.params.id}.4096.jpg\`
        )
      });`;
must(src.includes(previewAnchor), "overlay preview");
src = src.replace(
  previewAnchor,
  `      const { dir: projectDir } = await resolveProjectDir(config.dataRoot, request.params.dieId);
      const previewPath = await ensurePreviewImage({
        sourcePath: originalPath,
        cachePath: path.join(
          projectDir,
          "previews",
          \`overlay-\${request.params.id}.4096.jpg\`
        )
      });`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
