// Append a regression test: creating a folder project in a non-empty folder
// must be rejected with 409 folder_not_empty (strict emptiness rule).
// CRLF-safe, idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/dieImport/folderImport.test.ts";
let raw;
try {
  raw = readFileSync(file, "utf8");
} catch (error) {
  console.error("cannot read", file, error.message);
  process.exit(1);
}

if (raw.includes("non-empty folder fails with 409")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

const anchor = `test("import image into a non-existent folder fails with 400", async () => {`;
if (!raw.replace(/\r\n/g, "\n").includes(anchor)) {
  console.error("ANCHOR NOT FOUND: last test");
  process.exit(1);
}

const addition =
  `test("import image into a non-empty folder fails with 409", async () => {\n` +
  `  const { app } = await createHarness();\n` +
  `  const target = await createFolder("chip-nonempty-");\n\n` +
  `  // A single unrelated file is enough to make the folder ineligible.\n` +
  `  await fs.writeFile(path.join(target, "notes.txt"), "not a project");\n\n` +
  `  const response = await request(app)\n` +
  `    .post("/api/dies/import")\n` +
  `    .field("targetFolder", target)\n` +
  `    .attach("file", await pngBuffer(), { filename: "chip.png", contentType: "image/png" });\n\n` +
  `  assert.equal(response.status, 409);\n` +
  `  assert.equal(response.body.error, "folder_not_empty");\n\n` +
  `  // The pre-existing file is left untouched (no partial import happened).\n` +
  `  const entries = await fs.readdir(target);\n` +
  `  assert.deepEqual(entries, ["notes.txt"]);\n` +
  `});\n\n`;

let src = raw.replace(/\r\n/g, "\n");
src = src.replace(anchor, addition + anchor);
writeFileSync(file, src.replace(/\n/g, "\r\n"));
console.log("patched:", file);
