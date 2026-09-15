# tools/

Utility scripts for the repo. Run them with `node` (no build step needed).

## `crlf-patch.mjs` — safe editor for this repo's CRLF files

**Every source file in this repository is checked out with CRLF line endings.**
Editing one with a naive tool (or an LF-only string replacement) rewrites the
whole file to LF and produces a diff where every line shows as changed — noise
that hides the real edit and can break tooling.

`crlf-patch.mjs` exists so that doesn't happen. It does LF-anchored,
idempotent, **guarded** replacements while writing the file back as CRLF.

### The rule (do not bypass it)

1. Read the file as utf8.
2. Normalise to LF: `raw.replace(/\r\n/g, "\n")`.
3. For every edit, **assert the anchor is present first** (`includes()` /
   the built-in guard). **Throw before writing** if it is missing — never save
   a half-applied patch.
4. Write back with `src.replace(/\n/g, "\r\n")` so the file stays CRLF.

### Use as a library

```js
import { patchFile } from "./crlf-patch.mjs";

patchFile("shared/src/types.ts", {
  id: "project-location-types",          // marker; skip if already present
  edits: [
    { find: "OLD ANCHOR", replace: "NEW TEXT" }, // replace (must be unique)
    { append: "BEFORE", value: "AFTER" },        // insert after anchor
  ],
});
```

- `id` is the idempotency marker. If it already appears in the file, the call
  is a no-op (`{ changed: false }`).
- Every `find` / `append` anchor must be present and **unique** by default;
  a missing or ambiguous anchor throws *before* anything is written.
  Pass `{ unique: false }` to allow multiple hits (first is used).

### Use as a CLI

```sh
node tools/crlf-patch.mjs tools/my-patch.json
```

Descriptor JSON:

```json
{
  "file": "backend/src/foo.ts",
  "id": "unique-marker-string",
  "edits": [
    { "find": "...", "replace": "..." },
    { "append": "...", "value": "..." }
  ]
}
```

### After any edit

Always confirm nothing unexpected changed and the tree still builds:

```sh
git diff --stat
npx tsc -p tsconfig.json --noEmit      # backend / shared
cd frontend; npx tsc --noEmit          # frontend
```

### Creating new files

New files written via shell redirection / editor helpers come out as **LF**.
Normalise them to CRLF (or run them through `crlf-patch.mjs`) before committing
so the whole tree stays consistent.
