# Релизный журнал — tiled overlay migration

**Дата:** 14 августа 2026  
**Целевой тег:** `v1.4-alpha`  
**Ветка:** `analog-re-wip`

## Итог

В приложение внедрён **многослойный динамический tiled renderer для overlay images**. Он заменяет прежнюю модель, в которой крупный overlay загружался в браузер как единый `HTMLImageElement`. Новая архитектура сохраняет привычную логику overlay layers, но запрашивает и декодирует только необходимые части изображения для текущего viewport.

## Что реализовано сегодня

| Область | Реализовано |
|---|---|
| Per-user storage | Пользовательские tiled overlays хранятся изолированно по `userId`; для каждого изображения создаются manifest и tile pyramid. |
| Форматы | PNG/JPEG/WebP принимаются сервером; alpha сохраняется в PNG tiles, непрозрачный контент — в JPEG tiles. |
| Многослойный renderer | Любое число tiled overlay layers, с сохранением visibility, opacity, order, offsets, автозагрузки и legacy-state. |
| Progressive rendering | Сначала отображается coarse preview, затем sharp target tiles; это предотвращает чёрный кадр при zoom. |
| Приоритизация | Browser requests идут center-first; viewport epoch вытесняет stale queued tiles после pan/zoom. |
| Server scheduler | Bounded priority queue, coalescing одинаковых cold requests, `Server-Timing` и cache/queue/generation метрики. |
| Coarse warm-up | Levels 0–1 подготавливаются после upload во время idle grace period и не конкурируют с interactive requests. |
| ML/CV semantics | Inference/training и jobs используют original **верхнего видимого overlay layer** в scope текущего пользователя. |
| GUI | Overlay Layers отделены от Base Images; новые tiled изображения добавляются только в Overlay Layers; legacy static upload сохранён как backward compatibility. |
| Live render status | Status bar показывает количество visible tiles, состояние preview/loading и время текущей render wave. |
| Static previews | Merge Cells, RE Cell и Filmstrip используют компактные серверные JPEG crops из выбранного tiled original; hotkeys `[` / `]` и номерные shortcuts меняют source preview. |
| Security/cache | Crop preview source разрешается только через user-scoped `resolveOverlayOriginalPath`; cache разделён по `userId` и `overlaySourceId`. |

## Совместимость и инварианты

1. Legacy static overlays остаются доступными для старых сохранённых данных, но новые uploads используют tiled путь.
2. ML/CV выбирает последний видимый layer с положительной opacity, как и до миграции.
3. Обычный tiled API и private original routing не принимают произвольные filesystem paths.
4. Base Images и Overlay Layers остаются логически раздельными в UI.
5. Невидимые overlays не инициируют rendering work; нижние видимые overlays по-прежнему поддерживают смешивание через opacity.

## Отложенная следующая оптимизация

План persistent intermediate level images сохранён отдельно в [`PERSISTENT_LEVEL_IMAGES_PLAN.md`](./PERSISTENT_LEVEL_IMAGES_PLAN.md). Он описывает хранение промежуточных downsampled levels, resumable background generation и fallback к original. Цель — уменьшить cold latency на промежуточных zoom levels, где сервер сейчас иногда должен декодировать очень большой original ради небольшого tile.

## Проверки перед релизом

| Команда | Результат |
|---|---|
| `npm run build -w frontend` | успешно |
| `npm run build -w backend` | успешно |
| `npm run test -w backend` | 15/15 успешно |
| `git diff --check` | ошибок whitespace нет; остались только предупреждения LF/CRLF в ранее изменённых файлах |

## Основные затронутые компоненты

- `backend/src/api/overlayImages.ts`
- `backend/src/api/ml.ts`
- `backend/src/api/tiles.ts`
- `backend/src/ml/jobs.ts`
- `frontend/src/state/overlayLayers.ts`
- `frontend/src/renderer/layers/OverlayImageLayer.ts`
- `frontend/src/renderer/TiledCanvas.tsx`
- `frontend/src/routes/DieViewerPage.tsx`
- `frontend/src/routes/MergeCellsPage.tsx`
- `frontend/src/routes/RECellPage.tsx`
- `frontend/src/components/mergeCells/Filmstrip.tsx`
- `frontend/src/components/dieViewer/OutlineTree.tsx`

## English summary

**v1.4-alpha implements a multilayer dynamic tiled overlay renderer.** Large user overlays are stored privately per user, rendered progressively from a tile pyramid, prioritized for the active viewport, and selected consistently by ML/CV from the top visible layer. Merge Cells and RE Cell retain lightweight static server-side crop previews, now sourced from the selected tiled overlay and updated by the existing layer hotkeys.
