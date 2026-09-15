// Update daily-note progress for step 4. CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "memory/2026-09-15.md";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

const from = `- [ ] Шаг 4: backend/src/api/fs.ts (новый) — GET /api/fs/browse, POST /api/dies/open-folder, relocate`;
const to = `- [x] Шаг 4: backend/src/api/fs.ts (новый) — GET /api/fs/browse (roots для Windows/POSIX,
      скрывает dotfiles, флаг isProject по project.json), POST /api/dies/open-folder
      (существующий project.json → регистрируем как есть; пусто → новый id; коллизия id
      как у копии папки → новый id + суффикс имени), POST /api/dies/:dieId/relocate
      (проверяет совпадение manifest.id). Подключён в app.ts.
      + backend/src/api/fs.test.ts (4 теста: маркер+аннотации в папке, повторное открытие,
      relocate, browse). Добавлен в npm test: 32 tests / 31 pass / 1 fail (preexisting current_mirror).`;

if (!src.includes(from)) {
  console.error("ANCHOR NOT FOUND — aborting");
  process.exit(1);
}
src = src.replace(from, to);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
