// Register the folder-import test file in the backend test script.
// Idempotent, CRLF-safe (package.json is JSON; keep LF).
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/package.json";
const raw = readFileSync(file, "utf8");

if (raw.includes("folderImport.test.ts")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

const anchor = "src/api/fs.test.ts src/dieImport/importer.test.ts";
if (!raw.includes(anchor)) {
  console.error("ANCHOR NOT FOUND — aborting without writing");
  process.exit(1);
}

const next = raw.replace(
  anchor,
  "src/api/fs.test.ts src/dieImport/importer.test.ts src/dieImport/folderImport.test.ts"
);

writeFileSync(file, next, "utf8");
console.log("patched OK");
