// Add optional folder-target fields to ImportJobRecord.
// Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/types.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("targetDir")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting without writing`);
    process.exit(1);
  }
}

const anchor = `  startedAt: string | null;
  finishedAt: string | null;
  progress: import("shared").ImportJobProgress;
}`;
must(src.includes(anchor), "ImportJobRecord tail");
src = src.replace(
  anchor,
  `  startedAt: string | null;
  finishedAt: string | null;
  progress: import("shared").ImportJobProgress;
  /** Folder project destination (null for managed imports). */
  targetDir?: string | null;
  /** Folder project id used for targetDir imports. */
  targetId?: string | null;
}`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
