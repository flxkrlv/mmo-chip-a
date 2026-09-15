// Let ensureTileForRecord write tiles into an explicit project directory, so
// folder projects (outside dataRoot) are supported. CRLF-safe, idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/dieImport/importer.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("projectDir?:")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

const anchor = `export async function ensureTileForRecord(params: {
  dataRoot: string;
  record: DieRecord;
  z: number;
  x: number;
  y: number;
}) {`;
if (!src.includes(anchor)) {
  console.error("ANCHOR 1 NOT FOUND — aborting");
  process.exit(1);
}
src = src.replace(
  anchor,
  `export async function ensureTileForRecord(params: {
  dataRoot: string;
  record: DieRecord;
  z: number;
  x: number;
  y: number;
  /** Override the project directory (folder projects live outside dataRoot). */
  projectDir?: string;
}) {`
);

const pathAnchor = `  const tilePath = path.join(
    params.dataRoot,
    "dies",
    params.record.id,
    "tiles",
    String(params.z),
    \`\${params.x}_\${params.y}.jpg\`
  );`;
if (!src.includes(pathAnchor)) {
  console.error("ANCHOR 2 NOT FOUND — aborting");
  process.exit(1);
}
src = src.replace(
  pathAnchor,
  `  const projectDir = params.projectDir ?? path.join(params.dataRoot, "dies", params.record.id);
  const tilePath = path.join(
    projectDir,
    "tiles",
    String(params.z),
    \`\${params.x}_\${params.y}.jpg\`
  );`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
