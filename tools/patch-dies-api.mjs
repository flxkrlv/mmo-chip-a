// Route storage measurement through the resolver and surface location metadata
// (location / available / folderPath) in the die summaries and records.
// CRLF-safe, idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/api/dies.ts";
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

// 1) import the resolver
const importAnchor = `import type { createTileScheduler } from "../tileScheduler.js";`;
must(src.includes(importAnchor), "import");
src = src.replace(
  importAnchor,
  `import type { createTileScheduler } from "../tileScheduler.js";
import { resolveProjectDir } from "../projectLayout.js";`
);

// 2) measureProjectStorage through the resolver
const measureAnchor = `async function measureProjectStorage(dataRoot: string, dieId: string): Promise<ProjectStorageUsage> {
  const dieRoot = path.join(dataRoot, "dies", dieId);
  const overlayRoot = path.join(dataRoot, "overlay-images", dieId);`;
must(src.includes(measureAnchor), "measureProjectStorage");
src = src.replace(
  measureAnchor,
  `async function measureProjectStorage(dataRoot: string, dieId: string): Promise<ProjectStorageUsage> {
  const { dir: dieRoot, overlayDir: overlayRoot } = await resolveProjectDir(dataRoot, dieId);`
);

// 3) withOverlaySourceStorage through the resolver
const withOverlayAnchor = `async function withOverlaySourceStorage(
  dataRoot: string,
  dieId: string,
  progress: OverlayTileProgress
): Promise<OverlayTileProgress> {
  return {
    ...progress,
    sources: await Promise.all(progress.sources.map(async (source) => {
      const root = path.join(dataRoot, "overlay-images", dieId, source.id);`;
must(src.includes(withOverlayAnchor), "withOverlaySourceStorage");
src = src.replace(
  withOverlayAnchor,
  `async function withOverlaySourceStorage(
  dataRoot: string,
  dieId: string,
  progress: OverlayTileProgress
): Promise<OverlayTileProgress> {
  const { overlayDir } = await resolveProjectDir(dataRoot, dieId);
  return {
    ...progress,
    sources: await Promise.all(progress.sources.map(async (source) => {
      const root = path.join(overlayDir, source.id);`
);

// 4) summary: add location metadata (available computed from the resolver)
const summaryAnchor = `function toSummary(
  record: DieRecord,
  tileProgress: ReturnType<ReturnType<typeof createTileScheduler>["getProgress"]>,
  overlayTileProgress: Awaited<ReturnType<typeof getOverlayTileProgress>>
) {
  const { originalPath, levels, tileFormat, ...summary } = record;
  return {
    ...summary,
    ...(tileProgress ? { tileProgress } : {}),
    ...(overlayTileProgress.totalTiles > 0 ? { overlayTileProgress } : {})
  };
}`;
must(src.includes(summaryAnchor), "toSummary");
src = src.replace(
  summaryAnchor,
  `function toSummary(
  record: DieRecord,
  tileProgress: ReturnType<ReturnType<typeof createTileScheduler>["getProgress"]>,
  overlayTileProgress: Awaited<ReturnType<typeof getOverlayTileProgress>>,
  location?: { available: boolean; folderPath?: string }
) {
  const { originalPath, levels, tileFormat, ...summary } = record;
  return {
    ...summary,
    location: record.location ?? "managed",
    available: location?.available ?? true,
    ...(location?.folderPath ? { folderPath: location.folderPath } : {}),
    ...(tileProgress ? { tileProgress } : {}),
    ...(overlayTileProgress.totalTiles > 0 ? { overlayTileProgress } : {})
  };
}`
);

// 5) public record: same metadata
const publicAnchor = `function toPublicRecord(
  record: DieRecord,
  tileProgress: ReturnType<ReturnType<typeof createTileScheduler>["getProgress"]>,
  overlayTileProgress: Awaited<ReturnType<typeof getOverlayTileProgress>>
) {
  const { originalPath, ...publicRecord } = record;
  return {
    ...publicRecord,
    ...(tileProgress ? { tileProgress } : {}),
    ...(overlayTileProgress.totalTiles > 0 ? { overlayTileProgress } : {})
  };
}`;
must(src.includes(publicAnchor), "toPublicRecord");
src = src.replace(
  publicAnchor,
  `function toPublicRecord(
  record: DieRecord,
  tileProgress: ReturnType<ReturnType<typeof createTileScheduler>["getProgress"]>,
  overlayTileProgress: Awaited<ReturnType<typeof getOverlayTileProgress>>,
  location?: { available: boolean; folderPath?: string }
) {
  const { originalPath, ...publicRecord } = record;
  return {
    ...publicRecord,
    location: record.location ?? "managed",
    available: location?.available ?? true,
    ...(location?.folderPath ? { folderPath: location.folderPath } : {}),
    ...(tileProgress ? { tileProgress } : {}),
    ...(overlayTileProgress.totalTiles > 0 ? { overlayTileProgress } : {})
  };
}`
);

// 6) GET /api/dies — pass resolver metadata
const listRouteAnchor = `      response.json(
        await Promise.all(records.map(async (record) =>
          toSummary(
            record,
            config.tileScheduler.getProgress(record.id),
            await getOverlayTileProgress(config.dataRoot, record.id)
          )
        ))
      );`;
must(src.includes(listRouteAnchor), "list route");
src = src.replace(
  listRouteAnchor,
  `      response.json(
        await Promise.all(records.map(async (record) => {
          const resolved = await resolveProjectDir(config.dataRoot, record.id);
          return toSummary(
            record,
            config.tileScheduler.getProgress(record.id),
            await getOverlayTileProgress(config.dataRoot, record.id),
            { available: resolved.available, folderPath: resolved.kind === "folder" ? resolved.dir : undefined }
          );
        }))
      );`
);

// 7) GET /api/dies/:dieId — pass resolver metadata
const getRouteAnchor = `      const record = await readDieRecord(config.dataRoot, request.params.dieId);
      response.json(
        toPublicRecord(
          record,
          config.tileScheduler.getProgress(record.id),
          await getOverlayTileProgress(config.dataRoot, record.id)
        )
      );`;
must(src.includes(getRouteAnchor), "get route");
src = src.replace(
  getRouteAnchor,
  `      const record = await readDieRecord(config.dataRoot, request.params.dieId);
      const resolved = await resolveProjectDir(config.dataRoot, record.id);
      response.json(
        toPublicRecord(
          record,
          config.tileScheduler.getProgress(record.id),
          await getOverlayTileProgress(config.dataRoot, record.id),
          { available: resolved.available, folderPath: resolved.kind === "folder" ? resolved.dir : undefined }
        )
      );`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
