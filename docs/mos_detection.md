# MOS Transistor Detection (well-based)

## Как это работает

Детекция NMOS/PMOS транзисторов из аннотированных слоёв без использования
маркеров (`mos_id`/`drain`/`gate`/`source`/`bulk`).

### Принцип

```
nwell слой (или pwell)
  └── определяет тип транзистора:
        nwell = PMOS (p-type diffusion в nwell)
        pwell = NMOS (n-type diffusion в pwell)
  └── определяет bulk (подложку):
        есть contact на well (НЕ на diffusion, НЕ на poly) → positive netId
        нет контакта на well → sentinel -2 → VDD (PMOS) / GND (NMOS)
```

### Какие слои используются

| Слой | Роль |
|---|---|
| `nwell` / `pwell` | Определяет PMOS/NMOS + bulk terminal |
| `diffusion` | Тело транзистора (должна быть внутри well) |
| `polysilicon` | Затвор (gate) — должен пересекать diffusion |
| `contact` | Контакты на diffusion → S/D; на well (без diff/poly) → bulk |

### Clipper2 diffusion split (all MOS) — Единый подход

Любой MOS-транзистор **обязательно** использует Clipper2 `polygonDifference()`
для физического разрезания diffusion между затворами. Без Clipper2 MOS-детекция
невозможна — устройства не создаются, а пользователю показывается warning.

Разрез даёт отдельные synthetic LayerShape сегменты для drain и source,
благодаря чему `mergeMetalConnectedTerminals` видит разные polygon shapes
и не закорачивает D и S.

**Single-finger** (1 gate → 2 сегмента):
```
          gate[0]
  ┌────┼────┼────┐
  │  S │    │  D │  diffusion
  └────┼────┼────┘
       │    │
   seg[0] seg[1]
```

**Multi-finger** (N gates → N+1 сегментов):
```
    gate[0]   gate[1]   gate[2]
  ┌────┼────┼────┼────┼────┼────┐
  │  S │ D=S│ D=S│ D=S│ D  │    │  diffusion
  └────┼────┼────┼────┼────┼────┘
       │    │    │    │    │
  seg[0] seg[1] seg[2] seg[3]
```

- N gate fingers → N+1 сегментов diffusion
- Каждый gate → отдельный MOS с `id = mos_well_${well}_${n}_finger${i}`
- Shared сегмент `seg[i+1]` = D для gate[i] и S для gate[i+1]
- Shared сегменты → одинаковый netId при wire matching
- Сегменты кешируются в `_segmentShapesCache` (module-level Map).
  **Важно:** записи не удаляются после первого чтения — один и тот же
  cell type инстанциируется многократно (клоны/merged cells), и каждому
  экземпляру нужны те же synthetic segment shapes для корректной
  resolution контактов `resolveDeviceContacts()`.

### W/L/fingers/multiplier

- **W**: ширина diffusion вдоль poly gate (bbox intersection)
- **L**: длина poly gate поперёк diffusion
- **Fingers**: число poly-затворов, пересекающих одну diffusion
- **Multiplier**: группировка устройств по `type + W + L`; если в одном well
  несколько diffusion с одинаковыми параметрами → multiplier > 1

### Well tap — LVS layer exclusion

Контакт считается well tap ТОЛЬКО если:
1. Лежит внутри bbox well-а
2. НЕ лежит на diffusion (иначе это S/D контакт)
3. НЕ лежит на polysilicon (иначе это gate контакт)

Это классический Calibre LVS-подход: контакт принадлежит самому специфичному слою.

### Gate marker → well-based

Раньше существовал marker-based подход (`mos_id` + `drain`/`gate`/`source`/`bulk`).
Он удалён — well-based детекция покрывает все случаи.

### Edge cases

- **well есть, diffusion есть → всегда транзистор**, даже без poly-затвора
  (в этом случае gates.length = 0 → устройство не создаётся)
- **well contact есть, но нет metal1**: contact → positive netId (уникальный
  внутренний net, не VDD/GND). Это корректно — пользователь явно поставил
  well tap, даже если он никуда не подключён.
- **well contact совпадает с S/D контактом**: исключается LVS правилом —
  контакт на diffusion → S/D, не bulk.

## Gate net grouping (polyGateNetMap)

### Проблема

В реальных аналоговых ячейках один физический поликремниевый полигон часто
является затвором для нескольких транзисторов — PMOS и NMOS в разных
диффузиях. При этом контакт к затвору может быть только один (на общей
poly-шине), а внутри cell нет die-level wire, соединяющей затворы.

### Решение: connected components

Перед детекцией устройств строится `polyGateNetMap` — маппинг poly shape ID →
gate netId. Полисиликоновые shapes, соединённые физически, получают один
gate netId:

```
             poly[2] (shared bus)
    ┌───────────┼───────────┐
    │           │           │
 poly[0]    poly[1]    poly[3]
 (gate)     (gate)     (gate)
    │           │           │
   ─┼─diff1    ─┼─diff2    ─┼─diff3
   NMOS       NMOS        PMOS
```

poly[0] + poly[1] + poly[2] → один gate netId (connected component)
poly[3] → отдельный gate netId

**Механизм:**
- Все poly shapes преобразуются в полигоны через `shapeToPolygon()`
- Bbox-фильтр + `polygonsIntersect()` (Clipper2) определяют пересечение
- Union-Find строит connected components (транзитивное замыкание)
- Каждая компонента → один gate netId

> Clipper2 загружается асинхронно при старте приложения (в `cellExtraction.ts`).
> Если Clipper2 не загрузился — это ошибка приложения, деградации нет.

### Код

- `detectMOSFromLayers()` в `simpleAnalog.ts` — построение polyGateNetMap
- `gateNetFor(polyId)` — кэшированный lookup gate netId по poly shape ID
- `allPolyIdsForGateNet(netId)` — обратный lookup: все poly shape IDs
  для данного gate netId (используется для подсветки overlay)

### Debug-логи

```
[analog] polyGateNetMap: 8 polys, clipperLoaded=true
[analog]  poly[0] id=... bbox=(71.0,86.0,16.0,215.0)
[analog]  poly[1] id=... bbox=(115.0,86.0,20.0,214.0)
[analog]  MERGE poly[0](...) ↔ poly[2](...)
[analog]  MERGE poly[1](...) ↔ poly[2](...)
[analog]  merged 5 pairs into 3 component(s)
[analog]  body ...: 2 gate(s): id1, id2 → gateNets: 1000, 1000
```

## Die-level net dedup (cellNetCache)

### Проблема

`detectMOSFromLayers()` присваивает одинаковый gate netId (например 1000)
нескольким устройствам в cell type. Но die-level pipeline
(`collectDieWideAnalogDevices` в `dieWideAnalog.ts`) для каждого device
заново маппит терминалы на die-level nets через `matchWireToPoint()`. Без
дополнительной логики два device с G=1000 в одном instance получали разные
die-level nets (`net2231` и `net2241`).

### Решение: instance-level cache

Добавлен `cellNetCache` — `Map<string, number>` с ключом
`"${instCell.id}:${cellLevelNetId}"`:

```
Device A (M14): G=1000 → matchWireToPoint → net2231 → cache[instX:1000] = 2231
Device B (M15): G=1000 → cellNetCache HIT → net2231  ← тот же net!
```

**Правила:**
- Ключ включает `instCell.id` — разные экземпляры cell type независимы
- Все пути (wire match найден / fresh fallback) кэшируются
- `t.netId < 0` (неразрешённые терминалы) не участвуют
- Bulk auto-connect (VDD/GND) не затрагивается

### Код

- `frontend/src/api/dieWideAnalog.ts` → `collectDieWideAnalogDevices()`
- `cellNetCache` объявлен перед циклом по cell type'ам
- Cache lookup перед wire-matching: `const cacheKey = \`${instCell.id}:${t.netId}\``

## Overlay pin highlighting (shapeIds expansion)

### Проблема

Die viewer overlay подсвечивает gate pin только на поли shapes, которые
напрямую пересекают diffusion («режущие» затворы). Shared poly-шина,
физически соединяющая несколько затворов (но не пересекающая diffusion),
остаётся без подсветки.

### Решение: все poly shapes из компоненты

Gate terminal теперь включает в `shapeIds` все поли shapes из той же
`polyGateNetMap` компоненты, не только пересекающие diffusion:

**Все MOS (единый код, `simpleAnalog.ts`):**
```typescript
const gShapeIds = allPolyIdsForGateNet(gN);  // все polys с netId=gN
{ name: "G", netId: gN, shapeIds: gShapeIds }
```

### Результат

Для конфигурации из примера выше gate terminal будет содержать shapeIds:
- poly[0] (режущий gate в diff₁)
- poly[1] (режущий gate в diff₂)
- poly[2] (shared bus — теперь тоже подсвечивается!)

## Metal-connected D/S terminal merging (mergeMetalConnectedTerminals)

### Проблема

В аналоговых ячейках drain/source разных транзисторов часто соединяются
металлом (ME1, ME2) через контакты внутри ячейки. Два транзистора могут
внутри ячейки иметь общую metal-1 шину на drain/source, без die-level
wire, соединяющей их на верхнем уровне. Без специальной обработки такие
терминалы получали разные cell-level netId (nextNet()), а на die-level —
разные fresh nets (2000+).

### Решение

После детекции всех устройств запускается post-processing
`mergeMetalConnectedTerminals()`, который строит граф связности
металлических слоёв и объединяет netId drain/source терминалов,
соединённых внутри ячейки:

```
Транзистор A                   Транзистор B
┌──────────┐                   ┌──────────┐
│ diffusion│◄──contact──┐  ┌──contact──►│ diffusion│
└──────────┘            │  │            └──────────┘
                        │  │
                     ┌──┴──┴──┐
                     │  ME1   │  ← общая metal-1 шина
                     └────────┘
                         ↓
           A.D + A.S + B.D + B.S → один cell-level netId
                        ↓
            die-level: cellNetCache → один SPICE net
```

### Механизм

1. **Union-Find по металлическим слоям** (идентично cell.ts Step 2):
   - ME1 shapes, пересекающиеся → union
   - Contact overlaps ME1 → union (contact соединяет diffusion с ME1)
   - Via1 overlaps ME1 + ME2 → union (ME1↔VIA1↔ME2 цепочка)

2. **Для каждого D/S терминала** — поиск contacts, геометрически
   пересекающих терминал (через shapeId → LayerShape).

3. **Группировка по UF компоненте** — все терминалы, чьи контакты
   принадлежат одной компоненте UnionFind → один cell-level netId
   (через `nextNet()`).

4. **Die-level dedup** — существующий `cellNetCache` (см. выше)
   смерживает одинаковые cell-level netId в один die-level SPICE net.

### Поддерживаемые слои

| Слой | Роль |
|---|---|
| `metal1` (ME1) | Основной внутриячеечный металл |
| `via1` | Соединяет ME1 и ME2 |
| `metal2` (ME2) | Второй уровень металла |
| `contact` | Соединяет diffusion/poly с ME1 |

### Соединительная цепочка

```
diffusion → contact → ME1 → via1 → ME2 → …
```

VIA1 соединяется с ME1 и ME2 через `polygonsIntersect()` — если via
пересекает оба слоя, вся цепочка попадает в одну UF компоненту.

### Gate и bulk не затрагиваются

- **Gate** — уже обрабатывается `polyGateNetMap` (отдельная логика)
- **Bulk** — обрабатывается через sentinel -2 (VDD/GND fallback)

### Код

```typescript
// simpleAnalog.ts → detectMOSFromLayers() → после multiplier detection
mergeMetalConnectedTerminals(devices, allLayers);
```

Функция `mergeMetalConnectedTerminals()` — локальная (не экспортируется).

### Debug-логи

```
[analog] mergeMetalConnectedTerminals: 1 metal component(s)
[analog]  merge: mos_well_nwell_1.DS → net=1006
[analog]  merge: mos_well_nwell_3.D → net=1006
[analog]  merge: mos_well_nwell_3.S → net=1006
```

## GUI Warning (Clipper not loaded)

При загрузке Analog Netlist страницы проверяется `isClipperLoaded()`.
Если Clipper2 не загружен, в панель предупреждений (warnings) добавляется
сообщение: `"Clipper2 is not loaded — all MOS detection is disabled."`

MOS-детекция полностью отключается, если Clipper2 недоступен:
- `detectMOSFromLayers()` возвращает пустой массив при `!isClipperLoaded()`
- Показывается console.warn + GUI warning
- Никакого fallback на старую single-finger детекцию нет

Код: `frontend/src/api/dieWideAnalog.ts` → `collectDieWideAnalogDevices()`

## Интеграция

Код: `frontend/src/lib/extraction/simpleAnalog.ts` → `detectMOSFromLayers()`
Вызывается из:
- `cellExtraction.ts` — для отображения в RE Cell правой панели
- `dieWideAnalog.ts` → `extractAnalogDevicesFromCellType()` — для die-wide
  коллекции устройств
- `dieWideAnalog.ts` → `collectDieWideAnalogDevices()` — SPICE экспорт + overlay

Кэш die-level nets: `frontend/src/api/dieWideAnalog.ts`
