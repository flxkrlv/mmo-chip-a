// Keep project.json in sync with the final (de-duplicated) project name when
// importing a ZIP into a folder project. Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/api/projectIO.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("syncFolderManifest")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting without writing`);
    process.exit(1);
  }
}

const anchor = `    await fs.writeFile(path.join(stagedDieDir, "metadata.json"), \`\${JSON.stringify(updatedMeta, null, 2)}\\n\`, "utf8");`;
must(src.includes(anchor), "staged metadata write");
src = src.replace(
  anchor,
  `${anchor}
    if (targetFolder) {
      // Keep the on-disk marker consistent with the final name/id.
      await syncFolderManifest(dieDir, updatedMeta);
    }`
);

const helperAnchor = `/** Move every top-level entry of \`from\` into the existing directory \`to\`. */`;
must(src.includes(helperAnchor), "helper anchor");
src = src.replace(
  helperAnchor,
  `/** Refresh a folder project's project.json marker from its record. */
async function syncFolderManifest(dieDir: string, record: DieRecord): Promise<void> {
  const manifestPath = path.join(dieDir, "project.json");
  let createdAt = record.createdAt;
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { createdAt?: string };
    if (parsed?.createdAt) createdAt = parsed.createdAt;
  } catch {
    // fresh marker — use the record's createdAt
  }
  await fs.writeFile(
    manifestPath,
    \`\${JSON.stringify(
      {
        version: 1,
        id: record.id,
        name: record.name,
        createdAt,
        updatedAt: record.updatedAt
      },
      null,
      2
    )}\\n\`,
    "utf8"
  );
}

${helperAnchor}`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
