# MOS D/S Assignment — План реализации

## Проблема

D/S транзисторов назначается чисто позиционно (seg[0]=S, seg[1]=D) без
электрического смысла. Для SPICE это неважно, но для схемного рендера
(схемы нечитаемы, транзисторы «вверх ногами»).

## Фазы

### Фаза 0 — Overlay терминалов в RE Cell

**Цель:** Показать подписи D/S/G/B на сегментах транзисторов прямо в RE Cell,
синхронизированные с die viewer.

**Архитектурное требование:** RE Cell и die viewer должны использовать
**один и тот же pipeline** для разрешения контактов → терминалов. Иначе
неизбежен баг: контакт покажет D в RE Cell и S в die viewer.

**Как сейчас:**

```
RE Cell:
  detectMOSFromLayers() → devices с shapeIds
  НЕТ вызова mergeMetalConnectedTerminals
  НЕТ вызова resolveDeviceContacts
  → термпоинты не вычисляются

Die viewer (collectDieWideAnalogDevices):
  extractAnalogDevicesFromCellType()
    → detectMOSFromLayers() + extractMarkedDevices()
    → mergeMetalConnectedTerminals()
  resolveDeviceContacts() → termPoints с именами D/S/G/B
  → термпоинты вычислены, рендерятся на канвасе
```

**План Фазы 0:**

1. **Рефакторинг:** вынести `resolveDeviceContacts()` из `dieWideAnalog.ts`
   в общий модуль (например `simpleAnalog.ts` или `common.ts`), чтобы он
   был доступен и для RE Cell pipeline. Функция уже принимает `(dev, ctLayers, cx, cy)`,
   для RE Cell будет `(dev, cellType.layers + segmentShapes, 0, 0)`.

2. **RE Cell pipeline** (`useCellExtraction` / `cellExtraction.ts`):
   - После `detectMOSFromLayers()` + `extractMarkedDevices()`:
     - вызвать `mergeMetalConnectedTerminals()` (сейчас не вызывается)
     - для каждого устройства: `resolveDeviceContacts(dev, layersWithSegs, 0, 0)`
     - сохранить `_termPoints` на устройстве

3. **Рендер термпоинтов** (`AnalogDeviceLayer.tsx` или отдельный компонент):
   - Для каждого `_termPoints[]` нарисовать кружок + подпись (D/S/G/B/E/C...)
   - Цвета по типу терминала (D=жёлтый, S=зелёный, G=белый, B=серый)
   - Показывать при zoom > порога (как в die viewer)

4. **Обеспечение консистентности:**
   - RE Cell и die viewer вызывают **одну и ту же** `resolveDeviceContacts()`
   - RE Cell подставляет `(cx=0, cy=0)`, die viewer — `(cx, cy)` инстанции
   - Имена терминалов (`D`, `S`, `G`, `B`) приходят из `dev.terminals[ti].name`
     — это одно и то же поле в обоих контекстах
   - `mergeMetalConnectedTerminals` вызывается одинаково
   - Гарантия: контакт всегда получает одну и ту же метку

5. **Verification:** после внедрения открыть один и тот же транзистор
   в RE Cell и в die viewer — подписи контактов должны совпадать 1:1

---

### Фаза 1 — Bulk connection heuristic

Автоматическое переопределение D/S, когда source соединён с bulk внутри
ячейки через металл.

**Где:** после `mergeMetalConnectedTerminals()` в `detectMOSFromLayers()`.

**Логика:**
```
for (dev of devices) {
  sTerm = dev.terminals.find("S")
  dTerm = dev.terminals.find("D")
  bTerm = dev.terminals.find("B")

  if (bTerm.netId < 0) continue  // нет well contact → пропуск

  // После metal merge D и S могут иметь одинаковый netId.
  // Сравниваем с bulk netId:
  if (sTerm.netId === bTerm.netId && dTerm.netId !== bTerm.netId)
    continue // S уже на bulk — правильно
  if (dTerm.netId === bTerm.netId && sTerm.netId !== bTerm.netId)
    swapDS(dev) // D на bulk — переставить
}
```

**Ограничения:**
- Работает только когда well tap есть (positive netId)
- Требует metal-соединения source↔bulk (характерно не для всех схем)
- Не работает с bulk sentinel -2 (auto VDD/GND)

---

### Фаза 2 — Маркерный слой source_mark

Ручная маркировка истока. Пользователь рисует shape на слое `source_mark`
поверх diffusion-сегмента → этот сегмент гарантированно Source.

**Что сделать:**
1. Добавить `source_mark` в `LayerType` (shared/types.ts)
2. Добавить в `TOOL_LAYERS` (cellRE.ts)
3. В `detectMOSFromLayers()` перед D/S: проверить overlap source_mark с сегментами
4. Нарисовать маркер в RE Cell (спеццвет, иконка)

**Приоритет:** source_mark > manual swap override > bulk heuristic > default

---

### Фаза 3 — Swap D/S в UI

Кнопка "Swap D/S" в AnalogDeviceInspector.

**Хранилище:**
```typescript
// shared/types.ts → CellType
mosDSOverride?: Record<string, "swapped">
// Ключ = gate poly shape ID (стабильный, user-drawn, не меняется при реэкстракции)
```

**UI:** кнопка "Swap D/S" в инспекторе → upsertCellType → реэкстракция.

---

### Фаза 4 — Make Unique

Instance-level override: отвязать инстанцию от родительского CellType,
создать копию, применить D/S override только к ней.

**Функция:**
1. Deep-clone CellType → новый UUID
2. Скопировать layers + mosDSOverride
3. Обновить `Cell.cellTypeId` → новый UUID
4. Сохранить upsertCellType + upsertCell

**UI:** кнопка "Make Cell Unique" на die viewer при клике на instance.

---

### Фаза 5 — Schematic viewer использует правильные D/S

D/S из терминалов (уже после всех override) → правильная ориентация
NMOS/PMOS символов в netlist2svg.


manual · 1m ago
199 077 to 2 249 tokens

                                          ## Goal
- Разработать систему определения и отображения истока (Source) и стока (Drain) для MOS-транзисторов, детектируемых из геометрии (well-based MOS detection).
- **Новое**: Внедрить D/S assignment: force SOURCE через ПКМ + Bulk connection heuristic, с корректным отображением лейблов "S"/"D" вместо "S/D" когда resolution сработал.

## Constraints & Preferences
- В RE Cell и die viewer терминалы должны показываться **одинаково** — единый pipeline через `extractAnalogDevicesFromCellType()`.
- D/S assignment priority: (1) Force SOURCE > (2) Bulk heuristic > (3) Default "S/D".
- Force SOURCE через ПКМ на contact shape (LayerShape "contact"), а не через отдельный маркерный слой.
- Bulk heuristic после `mergeMetalConnectedTerminals` (теперь включает B в UF): если D.netId === B.netId → swap; если S.netId === B.netId → S правильный.
- После resolution, если `_dsResolved === true` → показывать "S"/"D", иначе "S/D".
- План действий: `F:\MMOCHIP_WORKDIR\mmo-chip\docs\mos_ds_assignment_plan.md`

## Progress
### Done
- [x] Прочитаны и проанализированы `README.md` и `mmo-chip\docs\mos_detection.md`
- [x] Составлен план из 5 фаз (`mos_ds_assignment_plan.md`)
- [x] Изучена архитектура `CellType`/`Cell`, D/S назначается позиционно
- [x] Выявлен риск консистентности: разные pipeline в RE Cell и die viewer
- [x] **Фаза 0 — Overlay терминалов в RE Cell** ✅
  - `resolveDeviceContacts()` перенесена в `simpleAnalog.ts`
  - Единый pipeline: оба вьювера через `extractAnalogDevicesFromCellType()`
  - `CellRECanvas.tsx` рендерит термпоинты с "S/D" для D/S
  - Консистентность гарантирована
- [x] **Фаза 1 — D/S assignment: force SOURCE + Bulk heuristic** ✅
  - `forcedSourceContacts?: string[]` добавлен в `CellType` (в `shared/src/types.ts`)
  - `resolveDeviceContacts()` возвращает `contactId` в termPoints
  - `mergeMetalConnectedTerminals()` теперь обрабатывает B (well tap) в UF — находит well tap контакт (на well, не на diffusion/poly), включает его в UF
  - `applyBulkHeuristic()`: если D.netId === B.netId → `_swapDSTerminals` (swap + обновление termPoints + `_dsResolved = true`); если S.netId === B.netId → `_dsResolved = true` (без swap)
  - `applySourceOverride()`: если контакт в `forcedSourceContacts` маппится на "D" → `_swapDSTerminals`
  - `_swapDSTerminals()` теперь сам обновляет termPoints (меняет "D"↔"S") и ставит `_dsResolved = true`
  - Die-level: `collectDieWideAnalogDevices` перезапускает `applyBulkHeuristic` после wire matching (чтобы catch die-level annotation wires)
  - UI: ПКМ на contact shape → "Force SOURCE" / "Clear SOURCE override" (через `ShapeContextMenu` + `buildToggleForceSourceAction` в `cellLayers.ts`)
  - Рендер: в `CellRECanvas.tsx` и `AnalogDeviceHighlights.tsx` — проверка `_dsResolved` перед показом "S/D"
  - Сборка чистая (0 TS errors)

### In Progress
- [ ] Фаза 4 — Make Unique (instance-level override)
- [ ] Фаза 5 — Schematic viewer использует правильные D/S

### Blocked
- (none)

## Key Decisions
- **Единый pipeline**: RE Cell и die viewer через `extractAnalogDevicesFromCellType()`
- **D/S assignment priority**: (1) Force SOURCE > (2) Bulk heuristic > (3) Default "S/D"
- **Force SOURCE через ПКМ**: вместо отдельного маркерного слоя — contact shape ID в `forcedSourceContacts[]` на CellType
- **Bulk heuristic**: после `mergeMetalConnectedTerminals` (теперь включает B в UF), если D.netId === B.netId → swap; если S.netId === B.netId → правильный
- **Очередность в pipeline**: сначала bulk heuristic (на оригинальных netId), потом source override (перебивает)
- **`_dsResolved` флаг**: ставится при любом resolution (swap или подтверждение S); display проверяет его для показа "S"/"D" vs "S/D"
- **`_swapDSTerminals`**: единая точка swap — и terminals, и _termPoints, и _dsResolved
- **Die-level re-run**: `applyBulkHeuristic` перезапускается после die-level wire matching, чтобы аннотационные провода тоже определяли D/S

## Next Steps
1. ~~Force SOURCE + UI~~ ✅
2. ~~Bulk heuristic (cell + die level)~~ ✅
3. ~~Fix termPoint update after swap~~ ✅
4. ~~Fix `_dsResolved` for S-on-bulk case~~ ✅
5. Make Unique (Фаза 4) — когда instance-level override нужен
6. Schematic viewer (Фаза 5) — D/S из терминалов

## Current State
- **Фаза 0 ✅** — Overlay терминалов в RE Cell, консистентность
- **Фаза 1 ✅** — Force SOURCE (ПКМ) + Bulk heuristic. Priority chain работает.
- **D/S** — после resolution показывает "S" и "D" раздельно; иначе "S/D"
- `_swapDSTerminals` обновляет terminals + termPoints + ставит `_dsResolved = true`
- Die-level: `applyBulkHeuristic` перезапускается после wire matching для обработки die-level annotation wires

## Critical Context
- **Ключевые файлы**:
  - `F:\MMOCHIP_WORKDIR\mmo-chip\shared\src\types.ts` — `CellType` с `forcedSourceContacts?: string[]`
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\lib\extraction\simpleAnalog.ts` — `detectMOSFromLayers()`, `mergeMetalConnectedTerminals()`, `resolveDeviceContacts()`, `applyBulkHeuristic()`, `applySourceOverride()`, `_swapDSTerminals()`
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\api\dieWideAnalog.ts` — `extractAnalogDevicesFromCellType()`, `collectDieWideAnalogDevices()` (с die-level re-run heuristic)
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\api\cellExtraction.ts` — `useCellExtraction()` (RE Cell pipeline)
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\CellRECanvas.tsx` — рендер термпоинтов с `_dsResolved` check
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\dieViewer\AnalogDeviceHighlights.tsx` — `drawTerminalLabels()` с `_dsResolved` check
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\ShapeContextMenu.tsx` — ПКМ "Force SOURCE" / "Clear SOURCE override"
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\lib\cellLayers.ts` — `buildToggleForceSourceAction()`
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\routes\RECellPage.tsx` — обработчик `onForceSource`
- **План фаз**: `F:\MMOCHIP_WORKDIR\mmo-chip\docs\mos_ds_assignment_plan.md`

---

**Turn Context (split turn):**

## Original Request
Пользователь сообщает о проблеме с multi-finger транзисторами: оверлей (подписи) рисуется неправильно — лейблы накладываются друг на друга на shared сегментах. Предлагает: при force SOURCE на одном контакте вся цепочка multi-finger должна автоматически разрешаться, т.к. сегменты всегда чередуются S, D, S, D...

## Early Progress
- **Понял логику:** multi-finger транзисторы создаются как N отдельных устройств в `detectMOSFromLayers`, каждое использует 2 из N+1 сегментов. Соседние устройства делят сегмент (seg[1] = D для gate0 и S для gate1)
- **Проблема 1:** один контакт на shared сегменте → два лейбла от двух устройств в одной точке (overlap)
- **Проблема 2:** force SOURCE на одном контакте должен распространяться на всю цепочку, т.к. S/D всегда чередуются
- **Решение:** написал функцию `propagateMultiFingerDS`, которая:
  1. Группирует MOS-устройства по shared сегментам (Union-Find)
  2. Если хотя бы одно устройство в группе разрешено (`_dsResolved`), определяет чередующийся паттерн (S, D, S, D...)
  3. Распространяет: если seg[i] = S → seg[i-1] = D, seg[i+1] = D и т.д.
  4. Меняет D/S местами (`_swapDSTerminals`) в устройствах, где S-терминал не совпадает с паттерном
- Исправил баг: убрал лишний flip segAssignment при каждом swap
- Добавил вызовы в pipeline: на cell-level (`extractAnalogDevicesFromCellType`) и die-level (`collectDieWideAnalogDevices`)

## Context for Suffix
- Функция `propagateMultiFingerDS` добавлена в `simpleAnalog.ts` и импортирована в `dieWideAnalog.ts`
- Вызывается после `applyBulkHeuristic` и `applySourceOverride` в обоих местах pipeline
- `_swapDSTerminals` корректно переносит netId вместе с функциями терминалов
- Компиляция TypeScript прошла без ошибок (`npx tsc --noEmit` — no output)

<read-files>
F:\MMOCHIP_WORKDIR\mmo-chip\README.md
F:\MMOCHIP_WORKDIR\mmo-chip\docs\mos_detection.md
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\api\cellExtraction.ts
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\AnalogDeviceInspector.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\AnalogDeviceLayer.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\SchematicCanvas.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\lib\extraction\common.ts
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\lib\extraction\index.ts
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\state\cellRE.ts
</read-files>

<modified-files>
F:\MMOCHIP_WORKDIR\mmo-chip\docs\mos_ds_assignment_plan.md
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\api\dieWideAnalog.ts
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\CellRECanvas.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\ShapeContextMenu.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\dieViewer\AnalogDeviceHighlights.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\lib\cellLayers.ts
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\lib\extraction\simpleAnalog.ts
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\routes\RECellPage.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\shared\src\types.ts
</modified-files>
                                        
Branch from checkpoint
Restore checkpoint
manual · 2h ago
153 404 to 1 915 tokens

                                          ## Goal
- Разработать систему определения и отображения истока (Source) и стока (Drain) для MOS-транзисторов, детектируемых из геометрии (well-based MOS detection).
- Начать с Фазы 0: отображение терминалов транзисторов (D/S/G/B) в RE Cell, с гарантией консистентности с die viewer.

## Constraints & Preferences
- В RE Cell и die viewer терминалы должны показываться **одинаково** — нельзя допустить, чтобы один контакт в разных вьюшках получил разные метки (D vs S).
- План действий уже записан в `F:\MMOCHIP_WORKDIR\mmo-chip\docs\mos_ds_assignment_plan.md`.
- D/S сейчас неразличимы геометрически (physically symmetric). Пока не будут внедрены heuristic (Фаза 1) или source_mark (Фаза 2), оба терминала показывать как "S/D" (как уже делает die viewer).
- Начинаем с Фазы 0.

## Progress

### Done
- [x] Прочитаны и проанализированы `README.md` и `mmo-chip\docs\mos_detection.md` (понимание well-based MOS детекции, Clipper2 разрезки diffusion, текущего архитектурного pipeline).
- [x] Составлен и записан структурированный план из 5 фаз (`mos_ds_assignment_plan.md`): Фаза 0 (Overlay терминалов в RE Cell), Фаза 1 (Bulk connection heuristic), Фаза 2 (Маркерный слой source_mark), Фаза 3 (Swap D/S в UI), Фаза 4 (Make Unique), Фаза 5 (Schematic viewer).
- [x] Изучена архитектура: `CellType` (шаблон без per-device метаданных) vs `Cell` (instance с `cellTypeId`, `x`, `y`, rotation, flip). Устройства пересчитываются каждый раз из геометрии. D/S назначается позиционно (seg[0]=S, seg[1]=D).
- [x] Выявлен риск консистентности: die viewer использует `extractAnalogDevicesFromCellType()` (с `mergeMetalConnectedTerminals` и `resolveDeviceContacts`), а RE Cell — прямой вызов `detectMOSFromLayers() + extractMarkedDevices()` (без `merge` и без контакт-резольвера). Это два разных pipeline, которые могут дать разное распределение контактов по D/S.

### In Progress
- [ ] Фаза 0 — разработка не начата.

### Blocked
- (none)

## Key Decisions
- **Единый pipeline**: RE Cell должен использовать ту же функцию `extractAnalogDevicesFromCellType()` (с `mergeMetalConnectedTerminals` + `resolveDeviceContacts`), что и die viewer, чтобы гарантировать консистентность. Разница только в том, что die viewer бежит по инстанциям с `(cx, cy)`, а RE Cell — один раз с `(0, 0)`.
- **Вынос resolveDeviceContacts**: функция `resolveDeviceContacts()` сейчас не экспортируется из `dieWideAnalog.ts`. Её нужно переместить в `simpleAnalog.ts` (рядом с `detectMOSFromLayers` и `mergeMetalConnectedTerminals`), чтобы оба pipeline могли её использовать.
- **"S/D" до поры**: пока D/S assignment ненадёжно (Фазы 1-2 не реализованы), и RE Cell, и die viewer показывают "S/D" для обоих терминалов (уже реализовано в die viewer через `const displayName = pt.name === "D" || pt.name === "S" ? "S/D" : pt.name`).

## Next Steps
1. **Перенести `resolveDeviceContacts()`** из `dieWideAnalog.ts` в `simpleAnalog.ts` (или `common.ts`). Экспортировать её вместе с нужными утилитами (`terminalDefMap`, `defsHavePriority`, `contactTolerance`, `shapeBounds`, `centerOfShape`, `pointInShape`).
2. **Добавить вызов `resolveDeviceContacts` в `extractAnalogDevicesFromCellType()`** (в `dieWideAnalog.ts`), чтобы устройства получали `_termPoints`.
3. **Переключить RE Cell pipeline** (в `cellExtraction.ts` → `useCellExtraction`) с отдельных `extractMarkedDevices` + `detectMOSFromLayers` на единый `extractAnalogDevicesFromCellType`.
4. **Добавить рендер терминалов в `CellRECanvas.tsx`** (Canvas 2D, аналогично `drawTerminalLabels` в `AnalogDeviceHighlights.tsx`). Рендерить кружки+подписи для `_termPoints` на сегментах.
5. **Убедиться в консистентности**: открыть один и тот же транзистор в RE Cell и die viewer — подписи на контактах должны совпадать.

## Critical Context
- **Ключевые файлы**:
  - `F:\MMOCHIP_WORKDIR\mmo-chip\shared\src\types.ts` — типы `CellType`, `AnalogDevice`, `DeviceTerminal`, `LayerShape`
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\lib\extraction\simpleAnalog.ts` — `detectMOSFromLayers()`, `mergeMetalConnectedTerminals()`, `extractMarkedDevices()`, `_segmentShapesCache`
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\api\dieWideAnalog.ts` — `extractAnalogDevicesFromCellType()`, `resolveDeviceContacts()`, `collectDieWideAnalogDevices()`
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\api\cellExtraction.ts` — `useCellExtraction()` (RE Cell pipeline)
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\CellRECanvas.tsx` — Canvas-рендер RE Cell (HTML Canvas 2D, не SVG)
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\dieViewer\AnalogDeviceHighlights.tsx` — `drawTerminalLabels()` (Canvas 2D, референс для стилизации)
  - `F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\AnalogDeviceLayer.tsx` — **dead code** (SVG-компонент, не импортируется никуда, не используется)
- **План фаз**: `F:\MMOCHIP_WORKDIR\mmo-chip\docs\mos_ds_assignment_plan.md`
- **Текущее состояние D/S в die viewer**: оба терминала показываются как "S/D" (см. `AnalogDeviceHighlights.tsx:405`). RE Cell не показывает терминалы вообще.
- **Токен контекста**: запрос на выполнение получен. Начинаем Фазу 0 с перемещения `resolveDeviceContacts` в `simpleAnalog.ts`.

---

**Turn Context (split turn):**

## Original Request
User confirmed "да, давай. делаем" (yes, let's do it) after the assistant proposed implementing Phase 0 — moving `resolveDeviceContacts` and helper functions from `dieWideAnalog.ts` to `simpleAnalog.ts`, then updating the RE Cell pipeline.

## Early Progress
- Assistant read `dieWideAnalog.ts` and `common.ts` to understand the dependency graph
- Planned the full changes: (1) move terminal defs + helpers + `resolveDeviceContacts` to `simpleAnalog.ts`, (2) update `extractAnalogDevicesFromCellType` to call it, (3) update `cellExtraction.ts` to use `extractAnalogDevicesFromCellType`, (4) add terminal labels in `CellRECanvas.tsx`
- Started Step 1: added import of `rectsIntersect` from geometry and appended all the moved code to `simpleAnalog.ts` (TerminalDef interface, all terminal definitions, helper functions, exported `resolveDeviceContacts`)

## Context for Suffix
The edit to `simpleAnalog.ts` succeeded — the new code is appended to the file. Next steps in the suffix will be:
- Update `dieWideAnalog.ts` to import from `simpleAnalog` and remove the moved duplicate code
- Update `extractAnalogDevicesFromCellType` in `simpleAnalog.ts` to call `resolveDeviceContacts`
- Update `cellExtraction.ts` pipeline for RE Cell
- Update `CellRECanvas.tsx` rendering

<read-files>
F:\MMOCHIP_WORKDIR\mmo-chip\README.md
F:\MMOCHIP_WORKDIR\mmo-chip\docs\mos_detection.md
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\api\cellExtraction.ts
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\api\dieWideAnalog.ts
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\AnalogDeviceInspector.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\AnalogDeviceLayer.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\CellRECanvas.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\cellRE\SchematicCanvas.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\components\dieViewer\AnalogDeviceHighlights.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\lib\cellLayers.ts
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\lib\extraction\common.ts
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\lib\extraction\index.ts
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\routes\RECellPage.tsx
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\state\cellRE.ts
F:\MMOCHIP_WORKDIR\mmo-chip\shared\src\types.ts
</read-files>

<modified-files>
F:\MMOCHIP_WORKDIR\mmo-chip\docs\mos_ds_assignment_plan.md
F:\MMOCHIP_WORKDIR\mmo-chip\frontend\src\lib\extraction\simpleAnalog.ts
</modified-files>
                                        