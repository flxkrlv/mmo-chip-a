// POST /api/dies/import: accept an optional "targetFolder" form field so an
// image import can create a folder project directly. The folder is validated
// before the job is queued, so 400/409 are returned synchronously.
// Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/api/dies.ts";
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

const anchor = `    try {
      await ensureDataStore(config.dataRoot);
      const job = await config.importJobManager.enqueueImportJob(request.file);
      response.status(202).json(toPublicImportJob(job));
    } catch (error) {
      next(error);
    } finally {
      await fs.rm(request.file.path, { force: true });
    }`;
must(src.includes(anchor), "import handler");
src = src.replace(
  anchor,
  `    const targetFolder =
      typeof request.body?.targetFolder === "string" && request.body.targetFolder.trim()
        ? request.body.targetFolder.trim()
        : undefined;

    try {
      await ensureDataStore(config.dataRoot);
      const job = await config.importJobManager.enqueueImportJob(request.file, targetFolder);
      response.status(202).json(toPublicImportJob(job));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 400 || status === 409) {
        response.status(status).json({
          error: (error as { code?: string }).code ?? "folder_error",
          message: (error as Error).message
        });
        return;
      }
      next(error);
    } finally {
      await fs.rm(request.file.path, { force: true });
    }`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
