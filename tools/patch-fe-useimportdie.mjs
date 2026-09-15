// useImportDie: accept { file, targetFolder? } so callers can pick a folder.
// Keep backwards compatibility by accepting a bare File too.
// Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "frontend/src/api/dies.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("useImportDie patched")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting without writing`);
    process.exit(1);
  }
}

const anchor = `export function useImportDie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: importDie,
    onSuccess: () => {`;
must(src.includes(anchor), "useImportDie");
src = src.replace(
  anchor,
  `// useImportDie patched: takes a File or { file, targetFolder }
export function useImportDie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: File | { file: File; targetFolder?: string }) =>
      input instanceof File ? importDie(input) : importDie(input.file, input.targetFolder),
    onSuccess: () => {`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
