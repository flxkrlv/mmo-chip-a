// Update the progress checklist in the daily note. CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "memory/2026-09-15.md";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

const from = `- [ ] Шаг 3: backend/src/store.ts — перевод per-die путей на резолвер`;
const to = `- [x] Шаг 3: backend/src/store.ts — все per-die функции (readDieRecord, writeDieRecord,
      deleteDieRecord, readAnnotations, writeAnnotations) идут через resolveProjectDir;
      listDieRecords добавляет folder-проекты из ярлыков; delete folder-проекта НЕ удаляет
      папку пользователя (только ярлык). backend/src/types.ts: +location/+folderPath в DieRecord.
      Backend tests: 27/28 (1 fail — preexisting, current_mirror assistant test, падал и до правок).
- [ ] Шаг 4: backend/src/api/fs.ts (новый) — GET /api/fs/browse, POST /api/dies/open-folder, relocate
- [ ] Шаг 5: tiles.ts, analogExport.ts, tileScheduler.ts, overlayImages.ts, mlExport — на резолвер
- [ ] Шаг 6: api/dies.ts — location/available/folderPath в списках
- [ ] Шаг 7: frontend — FolderPicker, кнопки, индикатор
- [ ] Шаг 8: commit в конце`;

if (!src.includes(from)) {
  console.error("ANCHOR NOT FOUND — aborting");
  process.exit(1);
}
src = src.replace(from, to);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
