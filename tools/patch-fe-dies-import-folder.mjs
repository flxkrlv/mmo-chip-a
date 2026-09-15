// Frontend: allow importing an image or a project ZIP directly into a chosen
// folder (creating a folder project). Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "frontend/src/api/dies.ts";
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

// 1) importDie: optional targetFolder
const importDieAnchor = `export function importDie(file: File): Promise<ImportJob> {
  const form = new FormData();
  form.append("file", file);
  return apiUpload<ImportJob>("/api/dies/import", form);
}`;
must(src.includes(importDieAnchor), "importDie");
src = src.replace(
  importDieAnchor,
  `export function importDie(file: File, targetFolder?: string): Promise<ImportJob> {
  const form = new FormData();
  form.append("file", file);
  if (targetFolder) form.append("targetFolder", targetFolder);
  return apiUpload<ImportJob>("/api/dies/import", form);
}`
);

// 2) importProject: optional targetFolder (query ?folder=)
const importProjAnchor = `export async function importProject(
  file: File,
  renameTo?: string
): Promise<ImportProjectResult> {
  const form = new FormData();
  form.append("file", file);

  let url = "/api/dies/import-project";
  if (renameTo) url += \`?name=\${encodeURIComponent(renameTo)}\`;`;
must(src.includes(importProjAnchor), "importProject");
src = src.replace(
  importProjAnchor,
  `export async function importProject(
  file: File,
  renameTo?: string,
  targetFolder?: string
): Promise<ImportProjectResult> {
  const form = new FormData();
  form.append("file", file);

  const params = new URLSearchParams();
  if (renameTo) params.set("name", renameTo);
  if (targetFolder) params.set("folder", targetFolder);
  const query = params.toString();
  let url = "/api/dies/import-project" + (query ? \`?\${query}\` : "");`
);

// 3) useImportProject mutationFn accepts targetFolder
const hookAnchor = `    mutationFn: async ({
      file,
      renameTo
    }: {
      file: File;
      renameTo?: string;
    }) => {
      return importProject(file, renameTo);
    },`;
must(src.includes(hookAnchor), "useImportProject");
src = src.replace(
  hookAnchor,
  `    mutationFn: async ({
      file,
      renameTo,
      targetFolder
    }: {
      file: File;
      renameTo?: string;
      targetFolder?: string;
    }) => {
      return importProject(file, renameTo, targetFolder);
    },`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
