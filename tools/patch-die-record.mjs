// Add location/folderPath to DieRecord in backend/src/types.ts (idempotent, CRLF-safe).
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/types.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("location?: import(\"shared\").ProjectLocationKind")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

const anchor = `  maxZoomLevel: number;
  levels: import("shared").DieLevelMetadata[];
  createdAt: string;
  updatedAt: string;
  config?: import("shared").DieConfig;
}`;

if (!src.includes(anchor)) {
  console.error("ANCHOR NOT FOUND — aborting without writing");
  process.exit(1);
}

src = src.replace(
  anchor,
  `  maxZoomLevel: number;
  levels: import("shared").DieLevelMetadata[];
  createdAt: string;
  updatedAt: string;
  config?: import("shared").DieConfig;
  /** "managed" (absent) = inside <dataRoot>/dies; "folder" = external directory. */
  location?: import("shared").ProjectLocationKind;
  /** Absolute external directory for folder projects. */
  folderPath?: string;
}`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
