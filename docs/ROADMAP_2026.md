# ROADMAP: mmo-chip-a — 2026 Q3

**Дата:** 2026-07-12
**Статус:** draft, утверждён пользователем

## TL;DR

| Phase | Цель | Длительность | Блокирует |
|-------|------|--------------|-----------|
| **1. Производительность** | UI не блокируется + incremental extraction | 4-5 дней | Все остальные (без тестов нельзя рефакторить) |
| **2. Многослойная металлизация** | Конфигурируемая архитектура для 6 ME + via | 4-5 дней | Phase 3 (новые тесты на новом стеке) |
| **3. Аналоговая экстракция** | Закрыть пробелы (VPNP, capacitors, HSPICE) | 3-5 дней | — |
| **4. Рефакторинг god-файлов** | simpleAnalog/cell/DieViewerPage → мелкие модули | 5-7 дней | Phase 1 (нужен CI + тесты) |

**ML, production build, Docker, web-deploy** — отложены по решению пользователя.

## Архитектура кэширования (Phase 1)

Трёхуровневый кэш + incremental invalidation + chunked execution:

| Уровень | Что кэшируется | Когда пересчитывается |
|---------|----------------|------------------------|
| **L1: Per-cellType device extraction** | `Map<cellTypeId, { hash, devices }>` | Только когда изменились слои этой cellType |
| **L2: Wire matching** | `Map<dieWireHash, { deviceId, terminalName, netId }>` | Когда изменился die-level wire или пересчитался L1 |
| **L3: Net graph** | `Map<fullAnnotationsHash, NetGraph>` | Полный пересчёт только если изменилось что-то вне L1/L2 |

**Chunked extraction ≠ incremental.** Chunked размазывает работу по времени (UI отзывчив, но 5 сек = 5 сек). Incremental пропускает неизменённые cellType (5 сек → 50 ms на типичном изменении).

## Phase 1 — Производительность клиента

### Шаг 1.1 — Per-cellType device cache (1 день)

**Файлы:**
- Новый: `frontend/src/lib/extraction/deviceCache.ts`
- `frontend/src/lib/extraction/simpleAnalog.ts` — вынести pure-функции
- `frontend/src/routes/DieViewerPage.tsx` — заменить sync-вызов на cached

**API:**
```typescript
interface DeviceCacheEntry {
  hash: string;          // hash(cellType.layers, cellType.umPerPx)
  devices: AnalogDevice[];
  computedAt: number;
}

const deviceCache = new CellTypeDeviceCache({
  maxEntries: 500,
  ttlMs: 30 * 60 * 1000
});

function computeCellTypeHash(ct: CellType): string {
  return sha256(JSON.stringify({
    id: ct.id,
    version: ct.version ?? 0,
    umPerPx: ct.umPerPx,
    layers: canonicalizeLayers(ct.layers)
  }));
}
```

**Логика:**
```typescript
function extractDevicesForCellType(
  ct: CellType,
  cache: CellTypeDeviceCache
): AnalogDevice[] {
  const hash = computeCellTypeHash(ct);
  const cached = cache.get(ct.id);
  if (cached && cached.hash === hash) return cached.devices;

  const devices = extractMarkedDevices(ct).concat(detectMOSFromLayers(ct));
  cache.set(ct.id, { hash, devices, computedAt: Date.now() });
  return devices;
}
```

**Acceptance:**
- Повторный зум/пан без изменения → 0 ms
- Изменение 1 cellType → пересчёт только этой cellType
- Unit-тест: `cellTypeHash` стабилен, `extractDevicesForCellType` корректно использует кэш

### Шаг 1.2 — Incremental wire matching (1.5-2 дня)

**Файлы:**
- Новый: `frontend/src/lib/extraction/wireCache.ts`
- `frontend/src/api/dieWideAnalog.ts` — заменить sync-вызов на cached

**Архитектура:**
```typescript
class WireMatchingCache {
  private byCellType = new Map<string, WireCacheEntry>();
  private spatialIndex = new RBush<{ x: number; y: number; w: number; h: number; ctId: string }>();

  getMatches(cellType: CellType, dieAnnotations: DieAnnotations): WireMatch[] | null {
    const dieHash = computeDieWireHash(dieAnnotations);
    const ctHash = computeCellTypeHash(cellType);
    const entry = this.byCellType.get(cellType.id);
    if (entry && entry.dieWireHash === dieHash && entry.cellTypeHash === ctHash) {
      return entry.matches;
    }
    return null;
  }

  invalidateForWires(changedWireIds: string[]): void {
    // spatial query: which cellType bboxes overlap changed wires
    // mark those entries as stale
  }
}
```

**Acceptance:**
- Изменение 1 cellType + 0 die-wires → wire matching для этой cellType
- Изменение 1 die-wire (без изменения cellTypes) → wire matching ТОЛЬКО для пересекающихся bbox
- Unit-тест: spatial index корректно находит зависимые device-bbox

### Шаг 1.3 — Chunked execution (1 день)

**Файлы:**
- Новый: `frontend/src/lib/extraction/chunkedRunner.ts`
- `frontend/src/routes/DieViewerPage.tsx` — добавить прогресс в StatusBar
- `frontend/src/components/shell/StatusBar.tsx` — убрать `<!-- TODO -->`, добавить прогресс

**API:**
```typescript
interface ChunkedRunnerOptions {
  chunkSize?: number;        // default 10
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number; canceled: boolean }) => void;
  yieldAfter?: number;       // default 5ms
}

export async function runChunked<T, R>(
  items: T[],
  fn: (item: T) => R,
  options: ChunkedRunnerOptions = {}
): Promise<R[]> {
  const { chunkSize = 10, signal, onProgress, yieldAfter = 5 } = options;
  const results: R[] = [];

  for (let i = 0; i < items.length; i += chunkSize) {
    if (signal?.aborted) {
      onProgress?.({ done: i, total: items.length, canceled: true });
      throw new DOMException('Aborted', 'AbortError');
    }

    const chunk = items.slice(i, i + chunkSize);
    results.push(...chunk.map(fn));

    onProgress?.({ done: Math.min(i + chunkSize, items.length), total: items.length, canceled: false });

    await new Promise(resolve => {
      if ('requestIdleCallback' in window) {
        (window as any).requestIdleCallback(resolve, { timeout: yieldAfter });
      } else {
        setTimeout(resolve, yieldAfter);
      }
    });
  }

  return results;
}
```

**Acceptance:**
- На 100 cellTypes — StatusBar показывает прогресс
- Cancel → `AbortSignal` → прерывание
- Animation/zoom/pan работают во время extraction

### Шаг 1.4 — Интеграция в DieViewerPage (1 день)

**Файлы:**
- `frontend/src/routes/DieViewerPage.tsx`
- `frontend/src/state/extractionProgress.ts` — новый Zustand store

**Что:**
- `useDieExtraction()` hook с прогрессом и cancel
- Заменить `useMemo(() => collectDieWideAnalogDevices(...), [deps])` на:
  ```typescript
  const [devices, setDevices] = useState<AnalogDevice[]>([]);
  const { progress, cancel, isRunning } = useDieExtraction();

  useEffect(() => {
    const ctrl = new AbortController();
    runChunked(cellTypes, ct => {
      const hash = computeCellTypeHash(ct);
      const cached = deviceCache.get(ct.id);
      if (cached?.hash === hash) return cached.devices;
      const devs = extractDevicesForCellType(ct, deviceCache);
      return wireCache.attachMatches(devs, ct, dieAnnotations);
    }, { signal: ctrl.signal, onProgress: setProgress })
      .then(setDevices)
      .catch(err => { if (err.name !== 'AbortError') throw err; });

    return () => ctrl.abort();
  }, [annotationsHash]);
  ```

**Acceptance:**
- Изменение 1 cellType → 50 ms total
- Изменение 1 wire → 200 ms (spatial-overlap devices)
- Изменение всего → 5 sec с прогрессом, отзывчивый UI
- Cancel работает

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

## Решения, которые нужно принять ДО старта

| # | Вопрос | Варианты | Default |
|---|--------|----------|---------|
| 1 | Hash-функция для cellType | sha256 vs fnv1a | sha256 — коллизии сломают кэш незаметно |
| 2 | TTL кэша | 30 мин vs бесконечно vs LRU-only | LRU-only + maxEntries=500 |
| 3 | Отмена extraction | AbortSignal vs ignore results | AbortSignal |
| 4 | Default metal stack | 2 metal (ME1, ME2) vs 6 metal (полный) | 2 metal — backward compat |
| 5 | Custom metal имена | Свободные строки vs enum | Свободные строки |
| 6 | Wire tool `1..6` vs `Alt+1..6` | Проверить конфликт с табами | Alt+1..6 если конфликт |
| 7 | Vitest vs Jest | Vitest (быстрее) vs Jest (зрелость) | Vitest |

## Файлы для первого touch (Phase 1.1)

1. `frontend/src/lib/extraction/simpleAnalog.ts` — вынести `extractMarkedDevices` и `detectMOSFromLayers` как pure
2. `frontend/src/api/dieWideAnalog.ts` — изучить `collectDieWideAnalogDevices` сигнатуру
3. `frontend/src/routes/DieViewerPage.tsx` — найти useEffect на extraction
