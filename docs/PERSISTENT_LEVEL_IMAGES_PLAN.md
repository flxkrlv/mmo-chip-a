# Persistent Level Images — отложенный план оптимизации tiled overlays

## Контекст

Текущий tiled overlay pipeline хранит пользовательский original и manifest, а финальные tiles строятся лениво. Это сохраняет быстрый upload, но при первом запросе tile на новом масштабе сервер может снова открыть и декодировать очень большой original. Для source порядка 500 MB это создаёт плавающую cold latency, хотя браузеру нужен только один небольшой tile.

## Цель

Сократить cold latency промежуточных zoom levels без изменения публичного tile API, многопользовательской изоляции или семантики верхнего видимого слоя для ML/CV.

> Каждый tile уровня `z` должен вырезаться из уже подготовленного raster-изображения близкого масштаба, а не каждый раз из полного original, когда это возможно.

## Целевая структура хранения

Для каждого user-scoped tiled overlay сохранить:

```text
overlay-images/{userId}/{dieId}/{sourceId}/
  manifest.json
  original.{png|jpg|webp}       # полный источник, нужен на максимальной детализации
  levels/
    level-0.{png|jpg}           # coarsest preview
    level-1.{png|jpg}
    level-2.{png|jpg}
    ...
  tiles/{z}/{x}/{y}.{png|jpg}   # финальные browser tiles, как сейчас
```

Непрозрачные levels следует сохранять в JPEG/WebP; уровни с alpha — в PNG/WebP lossless. Формат должен совпадать с alpha-семантикой manifest и не менять текущий формат tile endpoint.

## Поведение генерации

| Этап | Поведение |
|---|---|
| Upload | Сохранить original и manifest; вернуть результат без ожидания полной pyramid. |
| Первые 750 ms idle | Как сейчас, подготовить coarse tile levels 0–1 с низким приоритетом. |
| Background job | Построить persistent level images от coarse к detail, с ограниченной concurrency. |
| Cold tile request | Если level image для нужного `z` готов, открыть его и вырезать tile; иначе использовать существующий lazy fallback из original. |
| Повторный запрос | Использовать disk-cached tile без повторной генерации. |

Генерация должна быть resumable и idempotent: наличие валидного level file пропускает уже выполненную работу. При удалении overlay надо удалить original, manifest, levels и tiles в пределах user-scoped directory.

## Инварианты, которые нельзя менять

1. API tiles остаётся `/api/dies/:dieId/overlay-images/:sourceId/tiles/:z/:x/:y`.
2. `resolveOverlayOriginalPath` остаётся user-scoped; никаких произвольных filesystem paths из query/body.
3. ML/CV продолжает выбирать верхний видимый overlay layer через текущую логику.
4. Legacy static overlays остаются только backward compatibility и не требуют migration.
5. Coarse preview не должен исчезать: при недоступности persistent level всегда остаётся текущий lazy path.

## Реализация по шагам

1. Расширить manifest: версия схемы, `levelImages` с путями/status/format/размерами и error state.
2. Добавить helper `ensureLevelImage(manifest, z)` с temp file + atomic rename, аналогично безопасной генерации tiles.
3. Создать bounded background scheduler, отдельный от interactive tile scheduler; interactive viewport requests всегда приоритетнее.
4. Изменить `ensureTile`: выбирать ближайший готовый level image; fallback — original.
5. Добавить upload/job progress в metadata, без блокировки UI.
6. Добавить тесты на alpha, JPEG, restart/resume, user isolation, fallback и cleanup.
7. Измерить cold `X-Tile-Generation-Ms` до/после на крупном original и сравнить p50/p95.

## Ожидаемый эффект и компромиссы

Промежуточные zoom levels перестают требовать decode полного original для каждого cold tile. Это уменьшает CPU, I/O и latency при первом pan/zoom после cache eviction или рестарта. Максимальный zoom всё ещё может обращаться к original, потому что для полной детализации другого источника нет.

Цена оптимизации — дополнительная disk storage и фоновая обработка. Для геометрической пирамиды дополнительное число пикселей уровней имеет порядок одной трети исходного raster до учёта сжатия; фактический размер зависит от JPEG/PNG/WebP и alpha.

## Критерии приёмки

- После restart первый tile промежуточного zoom строится из persistent level, а не полного original.
- Current tile API, frontend renderer и hotkeys не требуют изменений.
- Пользователь не получает чужой original или level image.
- Coarse preview и stale queue supersession продолжают работать.
- Наблюдаемо сокращаются p95 `X-Tile-Generation-Ms` и пользовательское время до первого sharp tile.
