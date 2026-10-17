# UPSTREAM_SYNC_PLAN — перенос апдейта giulioz/mmo-chip в mmo-chip-a

Работа ведётся **локально, без пушей**. Источник фич — оригинальный проект
[giulioz/mmo-chip](https://github.com/giulioz/mmo-chip).

## Источник и база ветвления

Форк и оригинал разошлись от коммита `5536de4` (2026-06-05, "Initial commit").
Оригинал после этого:

| Коммит | Сообщение | Объём | Решение |
|--------|-----------|-------|---------|
| `ce03ef3` | selector for code search result | +43/-6 (`CodePage.tsx`) | берём (мелочь, Ф7) |
| `09efcd23` | README | мелкий | берём (Ф7) |
| `d81be68` | **new features** | +14809/-713, 94 файла | **целевой апдейт** |
| `d8a5fbd` | Add MIT license | мелкий | учесть (license) |
| `691db2e4` | Harden local API access and bound image/ML processing | +1398/-399 | **пропускаем** |

Важно: база апдейта `d81be68` = `09efcd23`, то есть отличается от базы форка
только `frontend/src/routes/CodePage.tsx` (commit `ce03ef3`). Поэтому текстовые
конфликты вызваны почти исключительно собственными правками форка.

Карта конфликтов: 43 новых файла (1 коллизия — `mergeCells/CellThumb.tsx`),
51 изменённый (6 из них форк не трогал → чистое слияние, 45 конфликтуют).

**Порядок фаз (пересмотрен 2026-10-17):** Ф0 подготовка → Ф1 цифровое ядро →
Ф2 clean specimens + wire-map → Ф3 детекция + Cells-панель → **Ф4 cross-die cell
library** → Ф5 мелочи/wire-tool/ориентация → Ф6 merge → Ф7 `/batch` + хвосты →
Ф8 валидация. Library перенесена вперёд (до merge), чтобы merge не пришлось
делать дважды, а library-блоки в Cells-панели ожили сразу после Ф3.

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
  die properties, badge). Временно вырезанные в Ф1/Ф2 куски возвращаются в Ф4.
  Уточнение области: апстрим шарит **геометрию/битмап-кропы** между die одного
  «cell library»; параметрический override для аналоговых девайсов — это уже
  наше расширение, в апстрим-механизм не входит (см. Ф4, п. 4).
- Hardening `691db2e4` — **пропущен**.
- `dieRegion` — был отложен, но **втянут в Ф4** (нужен `LibraryCellOverlay`).
- Серверный `POST /api/dies/:id/batch` — **не делаем**: у форка `batch` уже
  пишет атомарно одним `PUT /annotations`.
- Wire-tool чейнинг — тянем при отсутствии конфликта, иначе делаем сами.
- Мелочи die-viewer — делаем сами.
- **Фаза 1 не должна задеть аналог.**

## Сводная таблица: что тянем / адаптируем / отказываемся

Легенда: **Т** = тянем как есть (порт без переделки), **А** = адаптируем
(тематический перенос, конфликты с форком), **О** = отказываемся полностью.
Источник — `git diff --name-status 09efcd23 d81be68` (94 файла).

| Группа | Файлы апстрима | Статус | Фаза |
| --- | --- | --- | --- |
| backend · детекция (ядро) | `ml/cellDetect.ts`+test, `ml/cellDetectionStore.ts`, `api/cellDetection.ts`+test, `ml/cellJobs.ts`, `ml/jobs.test.ts` | **Т** | Ф1 |
| backend · интеграция | `app.ts`, `ml/jobs.ts`, `store.ts`, `api/ml.ts`, `types.ts`, `package.json` | **А** | Ф1 |
| backend · ml sidecar | `ml/sidecar.py` (resident checkpoint) | **Т** | Ф1 |
| backend · imaging | `imaging/{jobs,pixels,pixels.test,specimen,store,tileReader,wireMap}.ts`, `api/cellImaging.ts`+test | **Т** | Ф2 |
| backend · ws | `ws.ts` (`cellJob`/`imagingJob`/`die`) | **А** | Ф1/Ф4 |
| backend · tiles | `api/tiles.ts` (crop; library-resolve/rect в Ф4) | **А** | Ф1/Ф4 |
| backend · cell library | `cellLibrary.ts`, `api/dies.ts` (PATCH `/api/dies/:id`) | **Т** | Ф4 |
| shared · library | `shared/src/cellLibrary.ts`, `shared/package.json` (export) | **Т** | Ф4 |
| shared · types | `shared/src/types.ts` (detection/imaging/library-поля) | **А** | Ф1/Ф4 |
| frontend · api (new) | `api/cellImaging.ts`, `api/cellDetection.ts`, `api/cellLibrary.ts` | **Т** | Ф2/Ф3/Ф4 |
| frontend · api (edit) | `api/annotationsWebSocket.ts`, `api/client.ts` (`apiPatch`), `api/dies.ts`, `api/actions.ts`+test | **А** | Ф2/Ф4/Ф7 |
| frontend · lib (new) | `lib/cellDetection.ts`, `lib/cellLibrary.ts`, `lib/libraryPlacement.ts` (+`*.test.ts`) | **А** | Ф3/Ф4 |
| frontend · lib (edit) | `lib/cellLayers.ts`, `lib/mergeCells.ts`, `lib/viaAlign.ts` | **А** | Ф5/Ф6 |
| frontend · lib (clean) | `lib/geometry.ts`, `lib/cellRE.ts` | **Т** | — |
| frontend · renderer | `renderer/annotations/cellDetections.ts`, `cellFrame.ts` | **Т** | Ф3 |
| frontend · renderer (edit) | `dieAnnotations.ts`, `style.ts`, `layers/DieImageLayer.ts` | **А** | Ф3/Ф5 |
| frontend · dieViewer (new) | `LibraryCellOverlay.tsx` | **Т** | Ф4 |
| frontend · dieViewer (new) | `CellDetectionPanel.tsx`, `DieProperties.tsx`, `useLibraryCellTool.ts` | **А** | Ф3/Ф4 |
| frontend · dieViewer (edit) | `InspectorPanel.tsx`, `OutlineTree.tsx`, `DieToolbar.tsx`, `DieContextMenu.tsx`, `useMultiWireTool.ts` | **А** | Ф3/Ф5 |
| frontend · library/cellRE (new) | `cellLibrary/OtherDieBadge.tsx`, `cellRE/CellTypeContextMenu.tsx` | **Т** | Ф4/Ф6 |
| frontend · mergeCells (new) | `mergeCells/TypeThumb.tsx` | **Т** | Ф6 |
| frontend · mergeCells (edit) | `mergeCells/CellThumb.tsx` (add/add), `Filmstrip/MergeBottomBar/MergeCanvas/MergeContextMenu/MergeLeftPanel.tsx` | **А** | Ф6 |
| frontend · cellRE (edit) | `CellRECanvas.tsx`, `CellRELeftPanel.tsx`, `ShapeContextMenu.tsx` | **А** | Ф6 |
| frontend · state | `dieViewer.ts`, `preferences.ts`, `cellRE.ts`, `mergeCells.ts` | **А** | Ф2–Ф4 |
| frontend · routes (edit) | `DieViewerPage.tsx`, `MergeCellsPage.tsx`, `RECellPage.tsx` | **А** | Ф2/Ф3/Ф6 |
| frontend · routes (clean) | `CodePage.tsx` | **Т** | Ф7 |
| frontend · прочее | `icons.tsx` (**А**), `package.json` (**А**), `tsconfig.json` (**Т**) | А/Т | Ф3/Ф7 |
| docs | `README.md` | **А** | Ф7 |
| frontend · renderer (new) | `renderer/dieRegion.ts` + `dieRegion.test.ts` | **Т** (втянут в Ф4) | Ф4 |
| **отказ** | hardening `691db2e4` + README «Local access and processing limits» | **О** (не берём) | — |

Итого: **Т** ~27 файлов, **А** ~30, **О** 1 (README-раздел из hardening).

## Ф0 — Подготовка

1. `git remote add upstream https://github.com/giulioz/mmo-chip.git`; `git fetch upstream`.
2. Ветка `upstream-sync` от `analog-re-wip`; тег-снапшот базы.
3. Новые файлы нормализовать в CRLF (`tools/crlf-patch.mjs`).

## Ф1 — Цифровое ядро (backend + shared, без UI)

Перенос (новые файлы):
- `backend/src/ml/cellDetect.ts` (+ `cellDetect.test.ts`)
- `backend/src/ml/cellDetectionStore.ts`
- `backend/src/api/cellDetection.ts` (+ test)

Адаптация (временно без library — **возврат в Ф4**):
- `backend/src/ml/cellJobs.ts` — вырезать `../cellLibrary.js`
  (`effectiveCellTypes`, `libraryInstances`, `resolveCellType`), `allDies`,
  `buildPooledTemplate`, foreign/owner-template ветки; оставить `buildTemplate`
  по своему die.
- `cellDetection.test.ts` — убрать library-кейсы.
- Типы детекции в `shared/src/types.ts` / `backend/src/types.ts` — **без**
  `cellLibrary` / `cellScale` / `cellTypeDieId`.

Все вырезания в Ф1 помечены как временные: в Ф4 они восстанавливаются (через
`git revert`-стиль правок или повторный `git checkout d81be68 -- …`).

Интеграция (конфликты):
- `backend/src/app.ts` — смонтировать `createCellDetectionRouter` с общим
  predictor; `cellImagingRouter` подключается в Ф2.
- `backend/src/ws.ts` — добавить `cellJob` + `emitCellJob`.
- `backend/src/store.ts` — атомарная запись `writeMLJob` (temp + rename).
- `backend/src/ml/jobs.ts` + `backend/src/api/ml.ts` — no-wipe кэша при смене
  модели, 409 при активном sweep, sidecar resident checkpoint. Минимально:
  эти файлы косвенно влияют на аналог (ML-vias для авто-align).

Отложено в Ф4: `api/dies.ts` PATCH, `api/tiles.ts` library-resolve/rect-crop,
`backend/src/cellLibrary.ts`, `shared/src/cellLibrary.ts`.

Проверка: `npm test -w backend` (портированные тесты) + существующие
analog-тесты из `frontend` (README: 22 extraction-теста).

## Ф2 — Clean specimens + wire-map

Перенос: `backend/src/imaging/{jobs,pixels,specimen,store,tileReader,wireMap}.ts`
(+ `pixels.test.ts`), `backend/src/api/cellImaging.ts` (+ test).
Адаптация (временно): убрать library-pooling / `ForeignInstance` /
`toCanonicalImageScaled` / `allDies` — **возврат в Ф4**.

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
(сначала вырезаны для Ф3-без-library; с Ф4 они оживают).

## Ф4 — Cross-die cell library (с масштабированием)  ⟵ решение пересмотрено

**Статус: ✅ сделано** — backend/shared `dac3939`, frontend `eb39cba`
(frontend `tsc` чисто, `vitest` 304 теста зелёные; backend — 24 теста).

Отклонения от исходного плана Ф4 (зафиксировано при реализации):
- `dieRegion.ts` + тест **втянуты** (были в О) — нужны `LibraryCellOverlay`.
- Серверный `/batch` **не делаем** — форковый `batch` уже атомарный (`PUT`).
- Orientation-рефактор (`DieOrientOp`, generic `orientOnDie`, алгебра
  `composeOrient`/`invertOrient`/`orientVector`) **втянут в Ф4** (из Ф5), т.к.
  pipeline `onDie`/`routeLibraryAction` на него опирается.
- «Выбор типа = все инстансы» (`OutlineTree`+`InspectorPanel`) сделано в Ф4.
- Тесты апстрима переведены на vitest (`node:test` → vitest + shim `assert`).
- Осталось на Ф5/Ф7: multi-wire `continued`, Alt-drag-копия/групповой драг
  ячеек, контекстное меню flip/rotate ячеек (`orientCells`).

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
   разметка элементов generic-ячейки — после Ф4. Апстрим шарит только
   геометрию/битмап-кропы и масштаб.

Проверка: `npm test` (backend pooling + `lib/cellLibrary.test.ts`), typecheck;
ручной смоук: свести 2 die в library с разными scale → разместить чужой тип →
проверить размер/детекцию с `allDies`.

## Ф5 — Мелочи своими руками + wire-tool + ориентация

**Статус: ✅ сделано** (frontend `tsc` чисто, `vitest` 305 тестов зелёные).

Отклонения от исходного плана Ф5 (зафиксировано при реализации):
- Форковый multi-wire движок (`paths`/`locked`/`pending`/`placeCorner`) сильно
  отличается от апстрима (`ends`/`finalize`), поэтому чейнинг перенесён
  тематически: `busCommit` возвращает `{ actions, starts }`, `finalize`
  переоткрывает phase-2 с концов коммита (`continued: true`), `undo` в
  цепочке без несохранённого откатывает коммит, Enter/Esc останавливает цепь.
- Контекстное меню flip/rotate ячеек **уже было** у форка (`onOrientCell` +
  multi-select); добавили только пункт `rotateCcw` и перевели тип на
  `DieOrientOp` (4 операции).
- Групповой драг ячеек **уже был**; добавлена Alt-drag-копия, а округление
  смещения (`offset`) заменило округление позиции (сохраняет footprint на
  целых пикселях у повёрнутых типов).

- Wire-tool чейнинг (`frontend/src/components/dieViewer/useMultiWireTool.ts`),
  включая `continued` (мультивире continuation) в `DieViewerPage.tsx`.
- Снять гейт `CELL_DETAIL_ZOOM` (`renderer/annotations/style.ts` + `dieAnnotations.ts`).
- Alt-drag-копия / групповой драг ячеек; контекстное меню flip/rotate ячеек
  (`orientCells` в `DieViewerPage.tsx` + `DieContextMenu`).
- ~~Выбор типа = все инстансы~~ (сделано в Ф4).
- ~~Мини-инфо die в inspector (пустой выбор)~~ (`DieProperties` — Ф4).
- ~~Унификация ориентации (`rotateView`, `orientOnDie`)~~ (сделано в Ф4).

## Ф6 — Merge (выборочно, по конфликтам)

Whole-type orient/merge, member-score sort, `TypeThumb`. Сохранить наш
warp/multi-overlay/auto-align. `CellThumb.tsx` — add/add, объединить вручную.

## Ф7 — `/batch` (условно) и хвосты

`POST /api/dies/:id/batch` + адаптация `frontend/src/api/actions.ts` (если
дёшево); `ce03ef3` CodePage; README; test-скрипты; `frontend/tsconfig.json`
exclude.

## Ф8 — Валидация

`npm test` по воркспейсам; сборка/typecheck фронта; ручной смоук
(specimens/wire-map, via-детекция approve/dismiss, template CV → proposals,
чейнинг wire, cell details); запись в `memory/YYYY-MM-DD.md`.

## Явно исключено

- Hardening `691db2e4` (bounded image/ML processing, README-limits).
- ~~`dieRegion`~~ — втянут в Ф4 (см. выше).

Cross-die cell library **больше не исключён** — переносится в Ф4.

## Риски

- `ml/jobs.ts` / `api/ml.ts` косвенно влияют на аналог (ML-vias) — держать
  аддитивно + регресс-тесты.
- `shared/src/types.ts` / `backend/src/types.ts` — поля добавлять аккуратно, не
  трогая аналоговые типы.
- `useMultiWireTool.ts` — реальный конфликт (у форка 4 коммита в файле).
- Адаптер CV не должен ломать существующий `CVPanel`.
- **Ф4:** `lib/cellLibrary.ts` (568) / `useLibraryCellTool.ts` (272) /
  `DieProperties.tsx` (364) — крупные новые файлы; зависят от `mergeCells`/
  `cellFootprint`/ориентации, у форка они расходятся (адаптировать).
- **Ф4:** `api/dies.ts` PATCH в форке отсутствует (additive) — но апстрим
  зовёт `emitDieChange`, которого нет: добавить WS-сообщение `die`.
- **Ф4:** fork-овый action-dispatcher расширен аналогом; чужие die-правки
  (`onDie`) надо состыковать с форковым `historyDieId`/`ensureHistoryFor`.
- **Ф4:** dangling-ссылки — `Cell.cellTypeDieId` на тип удалённого/потерявшего
  library die. Проверить поведение `foreignCellTypes` при недоступном владельце
  и решить (skip/предупреждение).
- **Ф4:** `DieProperties.tsx` может дублировать форковый `SettingsPanel` —
  сверить размещение в `InspectorPanel` (вкладка без выделения).
- **Ф4:** масштаб `cellScale` — семантика (пикселей на library-unit) должна
  совпасть у масштабирования битмапов, детекции (`ratio`) и рендера; покрыть
  тестом на паре die с известным отношением.
