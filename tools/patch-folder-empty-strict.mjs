// Enforce that a folder project can only be created in a completely empty
// directory. Replaces the previous artefact-only guard (which ignored loose
// unrelated files) with a strict readdir() emptiness check.
// CRLF-safe, idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const file = "backend/src/projectLayout.ts";
let raw;
try {
  raw = readFileSync(file, "utf8");
} catch (error) {
  console.error("cannot read", file, error.message);
  process.exit(1);
}

if (raw.includes("must be completely empty")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

let src = raw.replace(/\r\n/g, "\n");
const must = (cond, what) => {
  if (!cond) {
    console.error("ANCHOR NOT FOUND:", what);
    process.exit(1);
  }
};

// 1) Update the doc comment to describe the strict emptiness rule.
const docFrom =
  " * Used by the import flows when the user chooses to create the project in an\n" +
  " * independent folder (\"save to folder\"). The directory must be empty of any\n" +
  " * project artefacts - we never overwrite a folder that is already a project\n" +
  " * (that would silently destroy data).\n" +
  " *\n" +
  " * Throws an error carrying a `status` for the caller to surface:\n" +
  " *   - 400 folder_missing    - the path is not an existing directory\n" +
  " *   - 409 project_exists    - a project.json is already present\n" +
  " *   - 409 folder_not_empty  - metadata.json / tiles / original already present";
const docTo =
  " * Used by the import flows when the user chooses to create the project in an\n" +
  " * independent folder (\"save to folder\"). The directory must be completely\n" +
  " * empty - we never write into a folder that already holds anything (a project\n" +
  " * we would clobber, or unrelated user files we would mix into the project).\n" +
  " *\n" +
  " * Throws an error carrying a `status` for the caller to surface:\n" +
  " *   - 400 folder_missing    - the path is not an existing directory\n" +
  " *   - 409 project_exists    - a project.json is already present\n" +
  " *   - 409 folder_not_empty  - the folder contains any other entry at all";
must(src.includes(docFrom), "doc comment");
src = src.replace(docFrom, docTo);

// 2) Replace the artefact loop with a strict emptiness check.
const guardFrom =
  "  // Guard against clobbering a folder that holds loose project artefacts but no\n" +
  "  // marker (e.g. a hand-copied managed directory).\n" +
  "  for (const artefact of [\"metadata.json\", \"tiles\", \"original\", \"annotations.json\"]) {\n" +
  "    try {\n" +
  "      await fs.access(path.join(dir, artefact));\n" +
  "      throw Object.assign(new Error(`Folder already contains ${artefact}`), {\n" +
  "        status: 409,\n" +
  "        code: \"folder_not_empty\"\n" +
  "      });\n" +
  "    } catch (error) {\n" +
  "      if ((error as { code?: string }).code !== \"ENOENT\") throw error;\n" +
  "    }\n" +
  "  }";
const guardTo =
  "  // The destination folder must be completely empty. We never create a project\n" +
  "  // alongside pre-existing content: that would either clobber a project copied\n" +
  "  // without its marker, or silently mix unrelated user files into the project.\n" +
  "  const existing = await fs.readdir(dir);\n" +
  "  if (existing.length > 0) {\n" +
  "    throw Object.assign(\n" +
  "      new Error(\"Folder is not empty (must be completely empty)\"),\n" +
  "      {\n" +
  "        status: 409,\n" +
  "        code: \"folder_not_empty\"\n" +
  "      }\n" +
  "    );\n" +
  "  }";
must(src.includes(guardFrom), "artefact guard loop");
src = src.replace(guardFrom, guardTo);

writeFileSync(file, src.replace(/\n/g, "\r\n"));
console.log("patched:", file);
