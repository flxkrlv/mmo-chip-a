#!/usr/bin/env node
/**
 * crlf-patch.mjs — safe helper for editing the CRLF files in this repo.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every source file in this repository is checked out with CRLF line
 * endings. Editing them with a naive editor (or an LF-only replacement)
 * rewrites the whole file to LF and produces a 1-line-per-file diff that is
 * impossible to review and can break tooling. This helper performs
 * LF-anchored, idempotent, guarded replacements while preserving CRLF.
 *
 * THE RULE (do not bypass it)
 * ---------------------------
 *   1. Read the file as utf8.
 *   2. Normalise: src = raw.replace(/\r\n/g, "\n").
 *   3. For every edit, FIRST assert the anchor is present with
 *      includes() / a must() guard. THROW BEFORE writing if it is missing —
 *      never write a half-applied patch.
 *   4. Write back with .replace(/\n/g, "\r\n") so the file stays CRLF.
 *
 * USAGE
 * -----
 *   // As a library, inside a throwaway script:
 *   import { patchFile } from "./crlf-patch.mjs";
 *   patchFile("shared/src/types.ts", {
 *     id: "project-location-types",   // marker; skip if already present
 *     edits: [
 *       { find: "OLD ANCHOR", replace: "NEW TEXT" },        // replace
 *       { append: "BEFORE", value: "AFTER" },               // insert after
 *     ],
 *   });
 *
 *   // As a CLI, applying a JSON patch descriptor:
 *   node tools/crlf-patch.mjs tools/my-patch.json
 *
 * Descriptor JSON shape:
 *   {
 *     "file": "backend/src/foo.ts",
 *     "id":   "unique-marker-string",   // if already in the file -> no-op
 *     "edits": [
 *       { "find": "...", "replace": "..." },
 *       { "append": "...", "value": "..." }
 *     ]
 *   }
 *
 * Notes:
 *  - `id` (or `find`) is the idempotency marker: if `id` is already present
 *    the script prints "already patched" and exits 0 without writing.
 *  - Every `find` / `append` anchor is checked for presence and for
 *    UNIQUENESS by default; pass `{ unique: false }` to allow multiple hits
 *    (then the first is used). Missing / ambiguous anchors abort before any
 *    write, so a failed run never leaves a partially edited file.
 */
import { readFileSync, writeFileSync } from "node:fs";

function toLf(raw) {
  return raw.replace(/\r\n/g, "\n");
}

function toCrlf(lf) {
  return lf.replace(/\n/g, "\r\n");
}

/**
 * Apply a list of anchored edits to `file`, preserving CRLF and guarding
 * every step. Throws (without writing) if any anchor is missing/ambiguous.
 *
 * @param {string} file  Path relative to the repo root.
 * @param {{ id?: string, edits: Array<object> }} spec
 * @returns {{ changed: boolean, reason?: string }}
 */
export function patchFile(file, spec) {
  if (!spec || !Array.isArray(spec.edits)) {
    throw new Error("patchFile: spec.edits must be an array");
  }
  const raw = readFileSync(file, "utf8");
  let src = toLf(raw);

  const marker = spec.id ?? null;
  if (marker && src.includes(marker)) {
    return { changed: false, reason: "already patched" };
  }

  // Validate ALL anchors before mutating, so a missing one aborts cleanly.
  for (const edit of spec.edits) {
    const anchor = edit.find ?? edit.append;
    if (typeof anchor !== "string") {
      throw new Error("patchFile: each edit needs a string `find` or `append`");
    }
    if (!src.includes(anchor)) {
      throw new Error(`patchFile: anchor not found in ${file}:\n---\n${anchor}\n---`);
    }
    if (edit.unique !== false && src.split(anchor).length > 2) {
      throw new Error(
        `patchFile: anchor is ambiguous in ${file} (use unique:false to allow):\n---\n${anchor}\n---`
      );
    }
  }

  for (const edit of spec.edits) {
    if (edit.find !== undefined) {
      src = src.replace(edit.find, edit.replace ?? "");
    } else if (edit.append !== undefined) {
      // Insert `value` immediately after every `append` anchor.
      src = src.split(edit.append).join(edit.append + (edit.value ?? ""));
    }
  }

  writeFileSync(file, toCrlf(src), "utf8");
  return { changed: true };
}

/** CLI entry point: `node tools/crlf-patch.mjs <descriptor.json>` */
function main(argv) {
  const path = argv[2];
  if (!path) {
    console.error("usage: node tools/crlf-patch.mjs <patch-descriptor.json>");
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(path, "utf8"));
  try {
    const result = patchFile(spec.file, spec);
    console.log(
      result.changed ? `patched ${spec.file}` : `${spec.file}: ${result.reason}`
    );
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(1);
  }
}

// Run as CLI only when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, "/")) {
  main(process.argv);
}
