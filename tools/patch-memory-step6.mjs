// Update daily-note progress for steps 5d-6. CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "memory/2026-09-15.md";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

const from = `- [ ] Шаг 5d: api/overlayImages.ts — оверлеи (манифесты с абсолютными originalPath)
- [ ] Шаг 5e: mlExport/exporter.ts, api/mlExport.ts
- [ ] Шаг 6: api/dies.ts — measureProjectStorage + location/available/folderPath в списках
- [ ] Шаг 7: frontend — FolderPicker, кнопки, индикатор`;

const to = `- [x] Шаг 5d: api/overlayImages.ts — dieOverlayDir/sourceDir/manifestPath стали async и
      берут overlayDir из резолвера; previews оверлеев -> в папку проекта. Все call-sites
      уже были в async-функциях.
- [x] Шаг 5e: mlExport/exporter.ts — overlayDir из резолвера. ml_exports/ (производная
      выходная папка) намеренно оставлена в dataRoot. api/ml.ts ходит через
      readDieRecord/readAnnotations (уже резолвятся) + глобальные ml-jobs.
- [x] Шаг 6: api/dies.ts — measureProjectStorage и withOverlaySourceStorage через резолвер;
      toSummary/toPublicRecord отдают location ("managed"|"folder"), available,
      folderPath. GET /api/dies и GET /api/dies/:dieId прокидывают metadata.

## Итог по бэкенду: ГОТОВО

Изменено 12 файлов, +227/-67. Все per-die пути идут через resolveProjectDir.
Typecheck backend+frontend OK. Тесты: 32 / 31 pass / 1 fail (preexisting current_mirror).
Работа управляемого (managed) режима не изменилась — регрессий нет.

Осталось: Шаг 7 (frontend) и Шаг 8 (commit).`;

if (!src.includes(from)) {
  console.error("ANCHOR NOT FOUND — aborting");
  process.exit(1);
}
src = src.replace(from, to);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
