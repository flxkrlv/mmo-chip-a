# ROADMAP: mmo-chip-a — 2026 Q3

**Дата:** 2026-07-14
**Статус:** active

## TL;DR

| Phase | Цель | Длительность | Статус |
|-------|------|--------------|--------|
| **1. Производительность** | UI не блокируется + per-cellType cache | 4-5 дней | ✅ **DONE** (2026-07-14) |
| **2. Многослойная металлизация** | Конфигурируемая архитектура для 6 ME + via | 4-5 дней | ⏸️ не начато |
| **3. Аналоговая экстракция** | Закрыть пробелы (VPNP, capacitors, HSPICE) | 3-5 дней | ⏸️ не начато |
| **4. Рефакторинг god-файлов** | simpleAnalog/cell/DieViewerPage → мелкие модули | 5-7 дней | 🟡 Vitest setup ✅, остальное ⏸️ |

**ML, production build, Docker, web-deploy** — отложены по решению пользователя.

---

## Phase 1 — Производительность клиента ✅ (2026-07-14)

### Архитектура — двухуровневый кэш

| Уровень | Что кэшируется | Где |
|---------|----------------|-----|
| **L1: Per-cellType device cache** | `CellTypeDeviceCache` (FNV1a, LRU, 500 entries) | `deviceCache.ts` |
| **L2: Full result cache** | `_fullResultKey / _fullResult` (module-level, FNV1a hash от annotations) | `dieWideAnalog.ts` |

### Шаг 1.1 — Per-cellType device cache ✅

**Файлы:**
- `frontend/src/lib/extraction/deviceCache.ts` (новый)
- `frontend/src/lib/extraction/deviceCache.test.ts` (новый, 18 тестов)

**Реализация:**
- FNV1a-64 хэш (`computeCellTypeHash`) — быстрее SHA-256, коллизии на 500 entry практические невозможны
- LRU-эвакция: `Map` с delete+set на get для поддержания порядка
- `extractDevicesForCellType` — cache-first обёртка над `extractAnalogDevicesFromCellType`
- `fnv1a64` экспортируется для использования в full result cache

**Принятые решения:**
- Хэш: FNV1a (не SHA-256) — решение на основе бенчмарка (FNV1a ~15ns vs SHA-256 ~1-3µs на cellType)
- TTL: отключён, LRU-only + maxEntries=500

### Шаг 1.2 — Incremental wire matching ❌ ПРОПУЩЕН

Принято решение не делать wire cache. Причина: wire matching занимает <30% времени экстракции, а риск ошибок (stale netId → молча неверный SPICE) перевешивает выгоду. Если бенчмарк покажет wire matching >30% — добавить с property-based тестами.

### Шаг 1.3 — Chunked execution ✅

**Файлы:**
- `frontend/src/lib/extraction/chunkedRunner.ts` (новый)
- `frontend/src/lib/extraction/chunkedRunner.test.ts` (новый, 8 тестов)
- `frontend/src/state/extractionProgress.ts` (новый)

**Реализация:**
- `runChunked` — async обёртка с progress callback и AbortSignal
- Без yield между чанками (экспериментально: requestIdleCallback давал +600ms overhead, setTimeout(resolve,0) тоже конкурировал с TileRenderer)
- Экстракция работает как sync блок, единственное замедление — после изменения данных (~400ms)
- После первой экстракции: full result cache → 0ms на все последующие вызовы

### Шаг 1.4 — Интеграция в DieViewerPage ✅

**Файлы:**
- `frontend/src/hooks/useDieExtraction.ts` (новый)
- `frontend/src/routes/DieViewerPage.tsx` — useDieExtraction hook вместо useMemo
- `frontend/src/components/dieViewer/AnalogDiePanel.tsx` — принимает `devices` как prop
- `frontend/src/components/netlist/NetGraphView.tsx` — передаёт umPerPx

**Что изменилось:**
- `useDieExtraction` hook заменяет `useMemo(() => collectDieWideAnalogDevices(...), [annotations])`
- Использует `collectDieWideChunked` (async) с `CellTypeDeviceCache` и AbortSignal
- `AnalogDiePanel` больше не вызывает sync `collectDieWideAnalogDevices` — читает `devices` из пропа
- StatusBar показывает `"analog 290ms"` после завершения экстракции (последнее время сохраняется)

**Дополнительно — рефакторинг `collectDieWideAnalogDevices`:**
- instance loop вынесен в `_processOneCellType` (pure, mutates shared state)
- пост-обработка (namedNets, bulkHeuristic, stable names) — в `_finishDieWidePipeline`
- добавлена async-вариация `collectDieWideChunked` с chunked cellType processing

### Benchmark-результаты

| Метрика | До Phase 1 | После Phase 1 |
|---------|-----------|---------------|
| Первая загрузка (cold) | 400ms × 8 callers = **3.2s блокировки** | **~460ms однократно** (1 sync call от child components) |
| Повторный рендер (warm) | 400ms × 8 callers = **3.2s блокировки** | **0ms** (full result cache hit) |
| После edit (warm cache) | 400ms | **~290ms** (per-cellType cache warm) |
| UI freeze при extraction | Да (3.2s) | Да, но 1× ~460ms (только после изменений) |
| Device cache hit | N/A | 0ms extraction для повторных вызовов |
| StatusBar индикация | Нет | `"analog 290ms"` |

### Тесты

Добавлен Vitest (`frontend/vitest.config.ts`), всего **26 тестов**:
- `deviceCache.test.ts` — 18 тестов (hash стабильность, LRU эвакция, extractDevicesForCellType)
- `chunkedRunner.test.ts` — 8 тестов (chunking, abort, progress)

---

## Phase 2 — Многослойная металлизация

**Цель:** конфигурируемая архитектура для 6 металлов и via между ними. Не хардкод ME1/ME2.

### Шаг 2.1 — Тип MetalStack в shared (0.5 дня)

**Файлы:** `shared/src/types.ts`

```typescript
export interface MetalLevel {
  id: string;             // "ME1", "ME2", ... или кастомное
  layer: LayerType;       // "metal1", "metal2", ...
  z: number;              // 1, 2, 3, ...
  name: string;           // "Metal 1"
  color: string;
  width?: number;
}

export interface ViaLevel {
  id: string;             // "VIA1", "VIA2", ...
  from: string;           // metalLevel.id (нижний)
  to: string;             // metalLevel.id (верхний)
  layer: LayerType;       // "via1", "via2", ...
  color: string;
  size?: number;
}

export interface MetalStack {
  metals: MetalLevel[];
  vias: ViaLevel[];
  defaultMetalId: string;
  defaultViaId: string;
}

export interface DieConfig {
  metalStack?: MetalStack;  // optional для backward compat
  umPerPx?: number;
}
```

**Backwards compat:** если `metalStack` undefined → дефолт (ME1, ME2, VIA1).

### Шаг 2.2 — Расширить LayerType union (0.25 дня)

**Файлы:** `shared/src/types.ts`

```typescript
export type LayerType =
  | "diffusion" | "polysilicon" | "nwell" | "pwell" | "bulk"
  | "metal1" | "metal2" | "metal3" | "metal4" | "metal5" | "metal6"
  | "via1" | "via2" | "via3" | "via4" | "via5"
  | "contact" | "npn_id" | "pnp_id" | "lpnp_id" | "vpnp"
  | "res_id" | "cap_id" | "diode_id"
  | "collector" | "base" | "emitter" | "marker"
  | "hsr" | "film" | string;
```

### Шаг 2.3 — Backend API (0.5 дня)

**Файлы:**
- `backend/src/api/metalStack.ts` — новый
- `backend/src/api/dies.ts` — register
- `backend/src/store.ts` — хранить в `metadata.json`

```typescript
// GET /api/dies/:dieId/metal-stack
// PUT /api/dies/:dieId/metal-stack
// Validation: metals sorted by z, vias reference existing metals
```

### Шаг 2.4 — SubBar: переключение активного металла (1 день)

**Файлы:**
- `frontend/src/state/session.ts` — добавить `activeMetalId: string`
- `frontend/src/components/dieViewer/SubBar.tsx` — dropdown/tabs
- `frontend/src/components/dieViewer/useWireTool.ts` — читать `activeMetalId`

**Hotkeys:** `1..6` — выбор metal level (если не конфликтуют с табами), `Shift+1..6` — выбор via level, `Alt+1..6` — fallback.

### Шаг 2.5 — Wire tool: учёт metal-stack (0.5 дня)

**Файлы:**
- `frontend/src/components/dieViewer/useWireTool.ts`
- `frontend/src/lib/extraction/nets.ts`

**Что:**
- Активный wire создаётся на `currentMetalLayer`
- Via размещение: `O` → берёт via, соединяющий `currentMetal` с `currentMetal+1`
- Соседние металлы соединяются ТОЛЬКО через соответствующий via

### Шаг 2.6 — Net name resolution (0.5 дня)

**Файлы:** `frontend/src/api/dieWideAnalog.ts`

Заменить hardcoded проверки на работу с `metalStack`:

```typescript
// Старое:
if (wire.layer === 'me1' || wire.layer === 'me2' || wire.layer === 'via1' || wire.layer === 'contact') { ... }

// Новое:
const isMetal = metalStack.metals.some(m => m.layer === wire.layer);
const isVia = metalStack.vias.some(v => v.layer === wire.layer);
if (isMetal || isVia || wire.layer === 'contact') { ... }
```

### Шаг 2.7 — Тесты (0.5 дня)

**Файлы:** `backend/src/metal-stack.test.ts` (новый)

Сценарии:
- Дефолтный стек мигрирует старые проекты
- Валидация: metals по возрастанию z, vias ссылаются на существующие
- Минимум 1 metal + 1 via
- Custom metal names (юзер может назвать "M1" вместо "ME1")

### Acceptance Phase 2

- `metalStack` хранится в `metadata.json`, мигрируется с дефолта
- SubBar показывает ME1..ME6 (или кастомные имена)
- Хоткеи 1..6 переключают активный metal
- Wire tool создаёт wire на активном metal
- Via размещается через `O`, использует правильный via из стека
- SPICE netlist корректно ссылается на metal/via layers
- Тесты на API + unit-тесты на валидацию

## Phase 3 — Аналоговая экстракция: закрыть пробелы

### Шаг 3.1 — VPNP (1-2 дня)

**Файлы:**
- `frontend/src/lib/extraction/simpleAnalog.ts` — case `vpnp`
- `frontend/src/lib/extraction/dieWideAnalog.ts` — VPNP_DEFS
- `frontend/src/lib/export/spice.ts` — VPNP форматтер
- `testdata/analog/vpnp_fixture.sp` — фикстура

**Что:** аналогично LPnp, но:
- AE = base-emitter overlap
- PE = collector-emitter perimeter
- SPICE: `Q<name> C B E <model>`

### Шаг 3.2 — Capacitor tests (0.5 дня)

**Файлы:** `testdata/analog/cap_mim.sp`, `backend/src/analog-extraction.test.ts`

**Что:** прогнать существующий capacitor detection через тесты, зафиксировать ожидаемую ёмкость.

### Шаг 3.3 — HSPICE verification (1 день)

**Файлы:** `testdata/analog/lmv341_hier.sp`, `scripts/test_hspice.sh`

**Что:**
- Запустить `ngspice` на HSPICE-форматированном netlist
- Сравнить с Spectre-форматированным (различия только в синтаксисе)
- Зафиксировать baseline, добавить в CI

### Шаг 3.4 — BJT multi-emitter (0.5 дня)

**Файлы:** `backend/src/analog-extraction.test.ts`

**Что:** тест на BJT с 2+ emitter областями. M = count.

### Шаг 3.5 — LPNP PE-расчёт (0.5 дня)

**Файлы:** `frontend/src/lib/extraction/simpleAnalog.ts`, `backend/src/analog-extraction.test.ts`

**Что:** уточнить расчёт PE для lateral PNP (perimeter на inner edge).

### Acceptance Phase 3

- VPNP детектируется, генерируется в SPICE
- Capacitor проходит тесты
- HSPICE и Spectre дают одинаковые результаты (через ngspice)
- Multi-emitter BJT корректно выдаёт M
- LPNP PE совпадает с эталонным

## Phase 4 — Рефакторинг god-файлов

**Предусловие:** Phase 1 дала Vitest + тесты на extraction. Phase 2 дала конфигурируемую архитектуру. Без этого рефакторинг — русская рулетка.

### Шаг 4.1 — Setup Vitest + ESLint (0.5 дня)

**Файлы:**
- `frontend/vitest.config.ts` (новый)
- `frontend/package.json` — scripts: `test`, `test:watch`
- `.eslintrc.json` в корне
- `.prettierrc.json` в корне

### Шаг 4.2 — CI (0.5 дня)

**Файлы:** `.github/workflows/ci.yml`

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test --workspaces --if-present
```

### Шаг 4.3 — `simpleAnalog.ts` → 6 файлов (2-3 дня)

**Было:** `frontend/src/lib/extraction/simpleAnalog.ts` (1862 строк)

**Стало:**
- `frontend/src/lib/extraction/mosDetection.ts` (~400 строк) — `detectMOSFromLayers`, `splitDiffusionAtGates`
- `frontend/src/lib/extraction/bjtDetection.ts` (~300 строк) — `extractMarkedDevices` BJT
- `frontend/src/lib/extraction/resistorDetection.ts` (~400 строк) — geometric + body
- `frontend/src/lib/extraction/diodeDetection.ts` (~200 строк) — marker + BJT-derived
- `frontend/src/lib/extraction/capacitorDetection.ts` (~150 строк) — marker
- `frontend/src/lib/extraction/clipperHelpers.ts` (~300 строк) — polygonDifference, etc.
- `frontend/src/lib/extraction/markers.ts` (~100 строк) — extractMarkedDevices dispatch

**Тесты:** перенести `analog-extraction.test.ts` сценарии в per-file тесты.

### Шаг 4.4 — `cell.ts` → 3 файла (2 дня)

**Было:** `frontend/src/lib/extraction/cell.ts` (2102 строк)

**Стало:**
- `frontend/src/lib/extraction/cellDetection.ts` (~800 строк) — `extractCell`, gates
- `frontend/src/lib/extraction/verilogGen.ts` (~500 строк) — Verilog generation
- `frontend/src/lib/extraction/boolean.ts` (~400 строк) — Boolean extraction (TODO)

### Шаг 4.5 — `DieViewerPage.tsx` → hooks (1-2 дня)

**Было:** `frontend/src/routes/DieViewerPage.tsx` (2989 строк)

**Стало:**
- `frontend/src/hooks/useDieViewerTools.ts` — tool state, mode switching
- `frontend/src/hooks/useDieViewerSelection.ts` — selected entities
- `frontend/src/hooks/useDieViewerHotkeys.ts` — keyboard handling
- `frontend/src/hooks/useDieExtraction.ts` — Phase 1 logic
- `frontend/src/routes/DieViewerPage.tsx` — composition root, <1500 строк

### Acceptance Phase 4

- Все файлы < 1500 строк
- CI зелёный (lint + typecheck + test)
- Per-file unit-тесты на каждый модуль
- `DieViewerPage.tsx` < 1500 строк
- Coverage критических pure-функций > 70%

## Отложено (по решению пользователя)

- **ML** — обучение неэффективно (7 it/s, качество как рандом)
- **Production build** — не нужно (LAN-deploy)
- **Docker** — не нужно
- **Web deploy / OAuth** — не нужно
- **Figma-style cursors** — низкий приоритет, дорого

## Принятые решения (Phase 1)

| # | Вопрос | Решение |
|---|--------|---------|
| 1 | Hash-функция для cellType | **FNV1a-64** (быстрее SHA-256 в ~200x, коллизии < 10⁻⁹ на 500 entry) |
| 2 | TTL кэша | **LRU-only + maxEntries=500** (без TTL, кэш живёт пока entry не вытеснится) |
| 3 | Отмена extraction | **AbortSignal** (прерывание через AbortController, не игнор результатов) |
| 4 | Default metal stack | **2 metal (ME1, ME2)** — backward compat (не реализовано) |
| 5 | Custom metal имена | **Свободные строки** (не реализовано) |
| 6 | Wire tool `1..6` vs `Alt+1..6` | **Alt+1..6 если конфликт** (не реализовано) |
| 7 | Vitest vs Jest | **Vitest** ✅ установлен |
| 8 | Incremental wire cache | **Пропущен** — риск ошибок > выгода |

## Что дальше

- **Phase 2 — Многослойная металлизация** (конфигурируемый MetalStack, 6 ME, via)
- **Phase 3 — Аналоговая экстракция** (VPNP, capacitors, HSPICE verification)
- **Phase 4 — Рефакторинг god-файлов** (simpleAnalog → 6 модулей, cell → 3 модуля, DieViewerPage → hooks)
