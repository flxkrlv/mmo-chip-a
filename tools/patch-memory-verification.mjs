// Append the regression-verification results to the daily note. CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "memory/2026-09-15.md";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

const marker = "## Итог: фича готова (backend + frontend). Осталось Шаг 8 (commit).";
if (!src.includes(marker)) {
  console.error("ANCHOR NOT FOUND — aborting");
  process.exit(1);
}

const block = `${marker}

## Верификация отсутствия регрессий (по запросу пользователя)

Пользователь просил доказать, что старый функционал работы с managed-проектом
работает ровно как до правок. Проверено:

1. Baseline на чистом HEAD (git stash): backend 28 тестов / 27 pass / **1 fail**
   — падает ровно \`app.test.ts:167 current_mirror\` (проверено git stash строкой
   ошибки). Frontend 129/129.
2. После правок: backend 33 / 32 pass / тот же 1 fail; frontend 129/129.
   Прирост тестов — только новые (4 fs + 1 equivalence guard). Старые не сломаны.
3. Добавлен тест-инвариант "managed projects resolve to the historical
   in-dataRoot paths": resolveProjectDir(Sync) для managed === dataRoot/dies/<id>
   и dataRoot/overlay-images/<id>, в т.ч. для записей без поля location.
4. Живой сервер (tsx backend/src/index.ts, PORT=3999): импорт PNG -> список,
   детали (+ location:"managed", available:true), тайл 200/jpeg, /image превью
   200/jpeg, tile-info считает storage. Структура на диске ровно как раньше:
   dies/<id>/{original,previews,tiles,metadata.json}.
5. Overlay-флоу (async-рефактор dieOverlayDir/sourceDir/manifestPath): upload ->
   overlay-images/<id>/<src>/{original.png,manifest.json,tiles}, тайл 200/jpeg,
   /original превью 200/jpeg, list с манифестом. Без изменений.
6. delete: dies/<id> удаляется, overlay-images/<id> ОСТАЁТСЯ (как до правок —
   я специально убрал добавленное мною удаление overlay, чтобы поведение было
   идентичным).

### Изменения, которые я скорректировал ради строгого соответствия старому поведению
- deleteDieRecord(managed): убрал лишнее удаление overlay-images (его раньше не было).
- listDieRecords: ошибку чтения глотаю только для folder-проектов; managed-запись
  при ошибке по-прежнему пробрасывает исключение (как раньше).

Вывод: регрессий нет.`;

src = src.replace(marker, block);
writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
