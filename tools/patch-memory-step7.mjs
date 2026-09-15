// Update daily-note progress for step 7. CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "memory/2026-09-15.md";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

const from = `Осталось: Шаг 7 (frontend) и Шаг 8 (commit).`;
const to = `- [x] Шаг 7: frontend
      - api/dies.ts: browseFs/useFsBrowse, openProjectFolder/useOpenProjectFolder,
        relocateProject/useRelocateProject.
      - components/library/FolderPicker.tsx (новый): серверный браузер папок, диски/roots,
        ручной ввод пути, метка "project" у папок с project.json.
      - icons.tsx: +folder/+folderOpen.
      - routes/LibraryPage.tsx: кнопка "Open folder" + модалка.
      - components/library/ThumbCard.tsx: badge "folder project"/"folder missing" +
        кнопка "Relocate…" (FolderPicker, обработка 409 project_id_mismatch).
      Frontend tests: 129/129. Полный npm run build — OK.

## Итог: фича готова (backend + frontend). Осталось Шаг 8 (commit).`;

if (!src.includes(from)) {
  console.error("ANCHOR NOT FOUND — aborting");
  process.exit(1);
}
src = src.replace(from, to);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
