// Route spice config + netlist export paths through the project-layout resolver.
// CRLF-safe, idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/api/analogExport.ts";
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

const importAnchor = `import { readDieRecord } from "../store.js";`;
must(src.includes(importAnchor), "import");
src = src.replace(
  importAnchor,
  `import { readDieRecord } from "../store.js";
import { resolveProjectDir } from "../projectLayout.js";`
);

const loadAnchor = `async function loadSpiceConfig(dataRoot: string, dieId: string): Promise<SpiceConfig | null> {
  try {
    const p = path.join(dataRoot, "dies", dieId, "spice_config.json");`;
must(src.includes(loadAnchor), "loadSpiceConfig");
src = src.replace(
  loadAnchor,
  `async function loadSpiceConfig(dataRoot: string, dieId: string): Promise<SpiceConfig | null> {
  try {
    const { dir } = await resolveProjectDir(dataRoot, dieId);
    const p = path.join(dir, "spice_config.json");`
);

const saveAnchor = `  const dir = path.join(dataRoot, "dies", dieId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "spice_config.json"),`;
must(src.includes(saveAnchor), "saveSpiceConfig");
src = src.replace(
  saveAnchor,
  `  const { dir } = await resolveProjectDir(dataRoot, dieId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "spice_config.json"),`
);

const exportAnchor = `      // Write output file
      const exportDir = path.join(config.dataRoot, "dies", dieId, "export");`;
must(src.includes(exportAnchor), "export dir");
src = src.replace(
  exportAnchor,
  `      // Write output file
      const { dir: projectDir } = await resolveProjectDir(config.dataRoot, dieId);
      const exportDir = path.join(projectDir, "export");`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
