// Update daily-note progress for step 5 (partial). CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "memory/2026-09-15.md";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

const from = `- [ ] Шаг 5: tiles.ts, analogExport.ts, tileScheduler.ts, overlayImages.ts, mlExport — на резолвер`;
const to = `- [x] Шаг 5a: tileScheduler.ts + dieImport/importer.ts — ensureTileForRecord принимает
      projectDir?; tileScheduler резолвит его из record.location/folderPath (sync, горячий путь).
- [x] Шаг 5b: api/tiles.ts — cell-crops, previews, original -> через resolveProjectDir.
- [x] Шаг 5c: api/analogExport.ts — spice_config.json + export/ -> через резолвер.
      (analog-layers уже шли через writeAnnotations.)
- [ ] Шаг 5d: api/overlayImages.ts — оверлеи (манифесты с абсолютными originalPath)
- [ ] Шаг 5e: mlExport/exporter.ts, api/mlExport.ts
- [ ] Шаг 6: api/dies.ts — measureProjectStorage + location/available/folderPath в списках
- [ ] Шаг 7: frontend — FolderPicker, кнопки, индикатор`;

if (!src.includes(from)) {
  console.error("ANCHOR NOT FOUND — aborting");
  process.exit(1);
}
src = src.replace(from, to);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
