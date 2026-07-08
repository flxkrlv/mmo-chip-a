# Analog fixes — 2026-07-08

## Проблемы

1. **instanceName не стабилен** — при каждом extraction имена M1, Q3, R5… назначались
   заново. Удаление устройства приводило к сдвигу всей нумерации.

2. **Override W/L/AE/R/fingers/multiplier в Cell RE не влиял на netlist** —
   override сохранялся в preferences, но pipeline его не читал.

3. **Override instanceName не сохранялся** — rename не переживал перезагрузку.

4. **Q1 не освобождался для ручного rename** — даже после удаления Q1, имя Q1
   оставалось "занято" (stale entry в nameMap блокировала rename).

5. **Graph / Schematic view не обновлялись после rename** — держали отдельные
   `useMemo` без зависимости от renameVersion.

6. **normalizeBJTM затирал override multiplier** — override применялся, но
   normalizeBJTM пересчитывал multiplier из AE_um2/minAE и перезаписывал.

7. **Multi-finger MOS: все пальцы получали одно имя M{N}** — `bbox` у всех
   пальцев общий (`bodyBox`), `_cellLevelKey` совпадал → React duplicate key.

8. **nmos и pmos на одной позиции получали одинаковое имя M{N}** — `kind === "mos"`
   у обоих, ключ `mos:posX:posY` без дискриминации типа.

9. **Любое движение слоёв внутри ячейки → переименование** — даже после фиксов
   выше, position-based ключ не переживает внутренние правки. Нужна стабильная
   per-device identity, не зависящая от позиции.

## Архитектура решения

### Device Registry (UUID-keyed identity)

Создан `frontend/src/state/deviceRegistry.ts` — single source of truth для
per-device identity, имён и override'ов. Хранится в localStorage как:

```ts
{
  v: 1,
  byUUID: { "<uuid>": { uuid, kind, subType, fingerprint, instanceName, overrides, ... } },
  byFingerprint: { "<fingerprint>": "<uuid>" },
  legacyOverrides?: { ... },   // one-time migration shim
}
```

**UUID назначается один раз** при первом обнаружении устройства через
`matchOrCreateDevice(fingerprint)`. На последующих extraction'ах UUID
восстанавливается:

1. **Exact match** — тот же fingerprint → тот же UUID
2. **Fuzzy match** — тот же (kind, subType), позиция в пределах 5px → тот же UUID
3. **No match** — новый UUID

Это значит:
- Внутренние правки слоёв (bbox сдвинулся на пару пикселей) → **тот же UUID**
- Переэкстракция с тем же контентом → **тот же UUID**
- Двинул слой на 50px → **новый UUID** (но counter не уменьшается)

Counter для auto-имён строится из ВСЕХ records (включая deleted), так что
новые device получают M{max+1}, M{max+2}, ... без коллизий с прошлым.

### Position-based device identity (legacy fingerprint)

Устройство fingerprint'ится по физическому положению внутри cell instance:

```
fingerprint = `${dev.kind}:${round(cx*100)}:${round(cy*100)}[:subtype]`
```

Подтип (`:nmos` / `:pmos`) добавляется для MOS-девайсов — без него nmos и pmos на одной
позиции получали одинаковый ключ и одинаковое имя.

Для multi-finger MOS fingerprint считается от центроида gate (`_gateAnchor`), а не от
центра body-диффузии — иначе все пальцы одного транзистора имеют идентичный
`bbox: bodyBox` и получают одинаковый fingerprint.

Fingerprint используется ТОЛЬКО для lookup в registry — не как ключ для
override'ов. Override'ы и имена теперь идут через registry по UUID.

### Хранение: прямой localStorage

Имена хранятся в `localStorage["mmo-chip-analog-names"]` как плоский JSON
`Record<dieLevelKey, instanceName>`. Отдельно хранится `activeKeys` —
множество ключей устройств, существующих в текущей экстракции.

- Чтение/запись — синхронные, никаких race conditions
- Counter = max(всех имён в map) — никогда не уменьшается
- Stale entries (удалённые устройства) остаются в map для counter,
  но не блокируют manual rename (проверка по activeKeys)

### Pipeline

```
collectDieWideAnalogDevices()
  1. Cell-level extraction (extractAnalogDevicesFromCellType)
     — вычисляет fingerprint на device
     — matchOrCreateDevice(fingerprint) → устанавливает _uuid
  2. Die-level collection (per-cell-type instance loop)
     — пробрасывает _uuid + _cellLevelKey (fingerprint) на die-level device
  3. assignStableInstanceNames()
     — для каждого device: registry.byUUID[_uuid].instanceName ?? legacy nameMap ?? auto-counter
     — reconcileWithLiveDevices() — soft-delete + resurrect

buildAnalogNetlist()
  1. collectDieWideAnalogDevices() — уже со stable names
  2. applyAnalogOverrides() — для каждого device читает registry.byUUID[_uuid].overrides
     — сохраняет _overriddenParams = Set<paramName>
  3. matchGeometry() — averaging (опционально)
  4. generateSpiceNetlist() / generateHierarchicalNetlist()
     — normalizeBJTM() проверяет _overriddenParams.has("multiplier")
       → пропускает overridden устройства
```

### Rename

- `DeviceInspector` (die viewer) + `InstanceOutline` (netlist page)
- `renameDeviceInstance(key, name)` → пишет в localStorage
- `validateDeviceName(key, name)` → проверяет формат + активные ключи
- `getRenameVersion()` → модульный счётчик, инкрементится при rename
  — включён в deps всех useMemo, потребляющих device list

## Файлы

| Файл | Изменения |
|------|-----------|
| `state/deviceRegistry.ts` (новый) | `matchOrCreateDevice()`, `setDeviceOverride()`, `setDeviceInstanceName()`, `reconcileWithLiveDevices()`, `getRegistryVersion()`. UUID-based identity + storage. |
| `api/dieWideAnalog.ts` | `_cellLevelKey` (fingerprint), `_uuid` на devices. `assignStableInstanceNames()` через registry. `renameDeviceInstance(uuid, ...)`. |
| `api/analogNetlist.ts` | `applyAnalogOverrides()` читает registry по `_uuid`. Legacy migration через `setLegacyOverrides()`. Outline leaves получают `uuid`. |
| `lib/export/spice.ts` | `normalizeBJTM()` пропускает overridden multiplier. `generateSpiceNetlist` не перезаписывает existing names. Hierarchical path — `alreadyNamed` check. |
| `lib/extraction/simpleAnalog.ts` | Убран пустой debug-блок в `detectMOSFromLayers()`. |
| `components/cellRE/CellRERightPanel.tsx` | Override UI пишет в registry по UUID. Читает из registry (с legacy fallback). Poll `getRegistryVersion()` для re-render. |
| `components/dieViewer/DeviceInspector.tsx` | Rename UI по `_uuid`. Мутация `device.instanceName` для мгновенной обратной связи. |
| `routes/AnalogNetlistPage.tsx` | InstanceOutline rename по `leaf.uuid`. |
| `components/netlist/NetGraphView.tsx` | `nameDevices()` сохраняет stable names. `getRenameVersion()` в deps. |
| `components/netlist/SchematicViewPanel.tsx` | Удалён `assignInstanceNames()` (имена уже stable). `getRenameVersion()` в deps. |
| `state/preferences.ts` | `analogOverrides` помечен deprecated, мигрирует в registry при первом запуске. Удалены `instanceNameMap`, `instanceNameCounters`. |

## Будущие фичи

- **Copy/Paste devices** в die viewer — план в `docs/future-work.md`
- **Make unique** — отвязать один device от группы, план там же
