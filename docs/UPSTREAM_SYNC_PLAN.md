# UPSTREAM_SYNC_PLAN — перенос апдейта giulioz/mmo-chip в mmo-chip-a

Работа ведётся **локально, без пушей**. Источник фич — оригинальный проект
[giulioz/mmo-chip](https://github.com/giulioz/mmo-chip).

## Источник и база ветвления

Форк и оригинал разошлись от коммита `5536de4` (2026-06-05, "Initial commit").
Оригинал после этого:

| Коммит | Сообщение | Объём | Решение |
|--------|-----------|-------|---------|
| `ce03ef3` | selector for code search result | +43/-6 (`CodePage.tsx`) | берём (мелочь, Ф6) |
| `09efcd23` | README | мелкий | берём (Ф6) |
| `d81be68` | **new features** | +14809/-713, 94 файла | **целевой апдейт** |
| `d8a5fbd` | Add MIT license | мелкий | учесть (license) |
| `691db2e4` | Harden local API access and bound image/ML processing | +1398/-399 | **пропускаем** |

Важно: база апдейта `d81be68` = `09efcd23`, то есть отличается от базы форка
только `frontend/src/routes/CodePage.tsx` (commit `ce03ef3`). Поэтому текстовые
конфликты вызваны почти исключительно собственными правками форка.

Карта конфликтов: 43 новых файла (1 коллизия — `mergeCells/CellThumb.tsx`),
51 изменённый (6 из них форк не трогал → чистое слияние, 45 конфликтуют).

## Решения (locked)

- Стратегия — **тематический перенос**, не единый `git merge`.
- Детекция ячеек — **оба движка**: via-based оригинала как есть (метка
  «CV (via-based) — оригинал»), наш template CV адаптируем к общему интерфейсу
  proposals (панель/approve-dismiss — общие, движки сменные).
- **Clean specimens + wire-map — тянем в этой итерации.**
- **Cross-die cell library с масштабированием — ТЯНЕМ** (решение пересмотрено
  2026-10-17). Мотивация: типовые/generic аналоговые ячейки, подгонка по
  размеру, накопление общей базы элементов для родственных кристаллов одной
  технологии. Портируется целиком: backend `cellLibrary.ts` + shared +
  imaging-пулинг + детекция с `allDies` + frontend library UI (placement,
  die properties, badge). Временно вырезанные в Ф1/Ф2 куски возвращаются в ФЛ.
  Уточнение области: апстрим шарит **геометрию/битмап-кропы** между die одного
  «cell library»; параметрический override для аналоговых девайсов — это уже
  наше расширение, в апстрим-механизм не входит (см. ФЛ, п. 4).
- Hardening `691db2e4` — **пропущен**.
- `dieRegion` — отложен.
- Серверный `POST /api/dies/:id/batch` — если дёшево по конфликтам.
- Wire-tool чейнинг — тянем при отсутствии конфликта, иначе делаем сами.
- Мелочи die-viewer — делаем сами.
- **Фаза 1 не должна задеть аналог.**

## Ф0 — Подготовка

1. `git remote add upstream https://github.com/giulioz/mmo-chip.git`; `git fetch upstream`.
2. Ветка `upstream-sync` от `analog-re-wip`; тег-снапшот базы.
3. Новые файлы нормализовать в CRLF (`tools/crlf-patch.mjs`).

## Ф1 — Цифровое ядро (backend + shared, без UI)

Перенос (новые файлы):
- `backend/src/ml/cellDetect.ts` (+ `cellDetect.test.ts`)
- `backend/src/ml/cellDetectionStore.ts`
- `backend/src/api/cellDetection.ts` (+ test)

Адаптация (временно без library — **возврат в ФЛ**):
- `backend/src/ml/cellJobs.ts` — вырезать `../cellLibrary.js`
  (`effectiveCellTypes`, `libraryInstances`, `resolveCellType`), `allDies`,
  `buildPooledTemplate`, foreign/owner-template ветки; оставить `buildTemplate`
  по своему die.
- `cellDetection.test.ts` — убрать library-кейсы.
- Типы детекции в `shared/src/types.ts` / `backend/src/types.ts` — **без**
  `cellLibrary` / `cellScale` / `cellTypeDieId`.

Все вырезания в Ф1 помечены как временные: в ФЛ они восстанавливаются (через
`git revert`-стиль правок или повторный `git checkout d81be68 -- …`).

Интеграция (конфликты):
- `backend/src/app.ts` — смонтировать `createCellDetectionRouter` с общим
  predictor; `cellImagingRouter` подключается в Ф2.
- `backend/src/ws.ts` — добавить `cellJob` + `emitCellJob`.
- `backend/src/store.ts` — атомарная запись `writeMLJob` (temp + rename).
- `backend/src/ml/jobs.ts` + `backend/src/api/ml.ts` — no-wipe кэша при смене
  модели, 409 при активном sweep, sidecar resident checkpoint. Минимально:
  эти файлы косвенно влияют на аналог (ML-vias для авто-align).

Отложено в ФЛ: `api/dies.ts` PATCH, `api/tiles.ts` library-resolve/rect-crop,
`backend/src/cellLibrary.ts`, `shared/src/cellLibrary.ts`.

Проверка: `npm test -w backend` (портированные тесты) + существующие
analog-тесты из `frontend` (README: 22 extraction-теста).

## Ф2 — Clean specimens + wire-map

Перенос: `backend/src/imaging/{jobs,pixels,specimen,store,tileReader,wireMap}.ts`
(+ `pixels.test.ts`), `backend/src/api/cellImaging.ts` (+ test).
Адаптация (временно): убрать library-pooling / `ForeignInstance` /
`toCanonicalImageScaled` / `allDies` — **возврат в ФЛ**.

Фронт: `frontend/src/api/cellImaging.ts`, секция CellImaging в Cells-панели,
`renderer/layers/DieImageLayer.ts` (`DieImageSource`), `state/preferences.ts`
(`wireMapHidden/Opacity`, `useCleanSpecimens`), `OutlineTree`/`state/dieViewer`.

Проверка: адаптированные `pixels.test.ts` / `cellImaging.test.ts`.

## Ф3 — Детекция + Cells-панель (движко-агностично)

Перенос: `frontend/src/lib/cellDetection.ts`,
`frontend/src/renderer/annotations/cellDetections.ts`,
`frontend/src/api/cellDetection.ts`,
`frontend/src/components/dieViewer/CellDetectionPanel.tsx` (селектор метода),
`state/dieViewer.ts`, `state/preferences.ts`, `InspectorPanel.tsx`
(вкладка Cells), `OutlineTree.tsx` (ML-результаты).

Адаптер: `cvMatch`/template → `Proposal[]` в тот же store; `CVPanel` не ломаем.
Метка via-движка: «CV (via-based) — оригинал».
Апстрим-панель содержит library-блоки (`cellDetectAllDies`, `specimensAllDies`,
привязка к типу владельца) — их включаем/включаем как есть, снося гейты
(сначала вырезаны для Ф3-без-library; с ФЛ они оживают).

## ФЛ — Cross-die cell library (с масштабированием)  ⟵ решение пересмотрено

Цель: die одной «cell library» видят и размещают типы друг друга; чужой тип
рисуется/детектируется в масштабе `cellScale / их cellScale`. Generic-ячейки
подгоняются по размеру между кристаллами одной технологии; копится общая база.

1. **Backend/shared**
   - `backend/src/cellLibrary.ts`, `shared/src/cellLibrary.ts` + export
     `"./cellLibrary"` в `shared/package.json`.
   - вернуть в `shared/src/types.ts`: `DieSummary.cellLibrary/cellScale`,
     `DieUpdateRequest`, `Cell.cellTypeDieId`,
     `CellDetectionResult.templateSource/pooledFrom`,
     `CellDetectionOptions/StartRequest.allDies`, `CellSpecimenInfo.dies`.
   - вернуть в `ml/cellJobs.ts` library-ветки (`effectiveCellTypes`,
     pooled/foreign, `buildPooledTemplate`); в `api/cellDetection.ts` — `allDies`.
   - вернуть в `imaging/{jobs,specimen,pixels}.ts` пулинг (`ForeignInstance`,
     `toCanonicalImageScaled`, `allDies`); в `api/cellImaging.ts` — `allDies`.
   - `api/dies.ts`: `PATCH /api/dies/:dieId` (+ `parseDieUpdate`,
     `normalizeCellLibrary`), границы `cellScale` 1e-3..1e3; монтирование с
     `broadcaster`.
   - `ws.ts`: сообщение `die` + `emitDieChange` (в Ф1 пропущено).
   - `api/tiles.ts`: library-resolve/rect-crop части (сверить конфликты).

2. **Frontend**
   - перенести `api/cellLibrary.ts`, `lib/cellLibrary.ts` (568 строк),
     `lib/libraryPlacement.ts`, `lib/cellLibrary.test.ts`,
     `components/cellLibrary/OtherDieBadge.tsx`.
   - `DieProperties.tsx` (пустой выбор в inspector: имя library + scale),
     `LibraryCellOverlay.tsx`, `useLibraryCellTool.ts` (272 строки) +
     `ToolKind "libraryCell"`, кнопка в `DieToolbar.tsx`.
   - `DieSocketMessage` += `die`; инвалидация списка dies/типов по WS.
   - `preferences.ts` += `cellDetectAllDies`, `specimensAllDies`.
   - `state/dieViewer.ts` += ToolKind/состояние library-размещения.

3. **Actions across dies**: апстрим оборачивает правки чужого die в `onDie`
   (история per-die). У форка уже есть `historyDieId`/`ensureHistoryFor` —
   состыковать; не сломать аналоговые actions и `netChangesToAction`.

4. **(Fork-extension, вне апстрима)** параметрический override / «условная»
   разметка элементов generic-ячейки — после ФЛ. Апстрим шарит только
   геометрию/битмап-кропы и масштаб.

Проверка: `npm test` (backend pooling + `lib/cellLibrary.test.ts`), typecheck;
ручной смоук: свести 2 die в library с разными scale → разместить чужой тип →
проверить размер/детекцию с `allDies`.

## Ф4 — Мелочи своими руками + wire-tool + ориентация

- Wire-tool чейнинг (`frontend/src/components/dieViewer/useMultiWireTool.ts`).
- Снять гейт `CELL_DETAIL_ZOOM` (`renderer/annotations/style.ts` + `dieAnnotations.ts`).
- Выбор типа = все инстансы (`OutlineTree.tsx` + `InspectorPanel.tsx`).
- Мини-инфо die в inspector (пустой выбор).
- Унификация ориентации (`lib/geometry.toCanonical`, `rotateView`, `orientOnDie`).

## Ф5 — Merge (выборочно, по конфликтам)

Whole-type orient/merge, member-score sort, `TypeThumb`. Сохранить наш
warp/multi-overlay/auto-align. `CellThumb.tsx` — add/add, объединить вручную.

## Ф6 — `/batch` (условно) и хвосты

`POST /api/dies/:id/batch` + адаптация `frontend/src/api/actions.ts` (если
дёшево); `ce03ef3` CodePage; README; test-скрипты; `frontend/tsconfig.json`
exclude.

## Ф7 — Валидация

`npm test` по воркспейсам; сборка/typecheck фронта; ручной смоук
(specimens/wire-map, via-детекция approve/dismiss, template CV → proposals,
чейнинг wire, cell details); запись в `memory/YYYY-MM-DD.md`.

## Явно исключено

- Hardening `691db2e4` (bounded image/ML processing, README-limits).
- `dieRegion` (отложен — не входит в этот апдейт).

Cross-die cell library **больше не исключён** — переносится в ФЛ.

## Риски

- `ml/jobs.ts` / `api/ml.ts` косвенно влияют на аналог (ML-vias) — держать
  аддитивно + регресс-тесты.
- `shared/src/types.ts` / `backend/src/types.ts` — поля добавлять аккуратно, не
  трогая аналоговые типы.
- `useMultiWireTool.ts` — реальный конфликт (у форка 4 коммита в файле).
- Адаптер CV не должен ломать существующий `CVPanel`.
- **ФЛ:** `lib/cellLibrary.ts` (568) / `useLibraryCellTool.ts` (272) /
  `DieProperties.tsx` (364) — крупные новые файлы; зависят от `mergeCells`/
  `cellFootprint`/ориентации, у форка они расходятся (адаптировать).
- **ФЛ:** `api/dies.ts` PATCH в форке отсутствует (additive) — но апстрим
  зовёт `emitDieChange`, которого нет: добавить WS-сообщение `die`.
- **ФЛ:** fork-овый action-dispatcher расширен аналогом; чужие die-правки
  (`onDie`) надо состыковать с форковым `historyDieId`/`ensureHistoryFor`.
- **ФЛ:** dangling-ссылки — `Cell.cellTypeDieId` на тип удалённого/потерявшего
  library die. Проверить поведение `foreignCellTypes` при недоступном владельце
  и решить (skip/предупреждение).
- **ФЛ:** `DieProperties.tsx` может дублировать форковый `SettingsPanel` —
  сверить размещение в `InspectorPanel` (вкладка без выделения).
- **ФЛ:** масштаб `cellScale` — семантика (пикселей на library-unit) должна
  совпасть у масштабирования битмапов, детекции (`ratio`) и рендера; покрыть
  тестом на паре die с известным отношением.
