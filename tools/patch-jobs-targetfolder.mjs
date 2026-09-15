// Support creating an import job that lands in an independent folder project.
// The folder is validated + registered (project.json + shortcut) BEFORE the job
// is queued, so a conflicting/occupied folder fails synchronously with 4xx.
// Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/dieImport/jobs.ts";
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
const importAnchor = `import { readImportJob, writeImportJob } from "../store.js";`;
must(src.includes(importAnchor), "store import");
src = src.replace(
  importAnchor,
  `${importAnchor}
import { prepareFolderProject } from "../projectLayout.js";`
);

// 2) enqueueImportJob: accept an optional target folder, validate it up-front
const sigAnchor = `  async function enqueueImportJob(file: Express.Multer.File) {
    const jobId = crypto.randomUUID();`;
must(src.includes(sigAnchor), "enqueue signature");
src = src.replace(
  sigAnchor,
  `  async function enqueueImportJob(file: Express.Multer.File, targetFolder?: string) {
    // Validate + register the destination folder before creating the job, so an
    // occupied/invalid folder surfaces as a synchronous 4xx to the caller.
    const target = targetFolder ? await prepareFolderProject(config.dataRoot, targetFolder, {
      name: file.originalname.replace(/\.[^.]+$/, "")
    }) : null;

    const jobId = crypto.randomUUID();`
);

// 3) stash target path on the job record (extra fields are ignored by older readers)
const jobAnchor = `      progress: createProgress({
        phase: "queued",`;
must(src.includes(jobAnchor), "job literal");
src = src.replace(
  jobAnchor,
  `      targetDir: target?.dir ?? null,
      targetId: target?.id ?? null,
      progress: createProgress({
        phase: "queued",`
);

// 4) pass targetDir/targetId into importDieShot
const callAnchor = `        limitInputPixels: config.limitInputPixels,
        tileConcurrency: config.tileConcurrency,
        onProgress: persistProgress,`;
must(src.includes(callAnchor), "importDieShot call");
src = src.replace(
  callAnchor,
  `        limitInputPixels: config.limitInputPixels,
        tileConcurrency: config.tileConcurrency,
        targetDir: job.targetDir ?? undefined,
        targetId: job.targetId ?? undefined,
        onProgress: persistProgress,`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
