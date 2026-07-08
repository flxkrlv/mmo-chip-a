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

## Архитектура решения

### Position-based device identity

Устройство идентифицируется по физическому положению внутри cell instance:

```
cellLevelKey = `${dev.kind}:${round(cx*100)}:${round(cy*100)}[:subtype]`
dieLevelKey  = `${instCell.id}:${cellLevelKey}`
```

Подтип (`:nmos` / `:pmos`) добавляется для MOS-девайсов — без него nmos и pmos на одной
позиции получали одинаковый ключ и одинаковое имя.

Для multi-finger MOS ключ считается от центроида gate (`_gateAnchor`), а не от
центра body-диффузии — иначе все пальцы одного транзистора имеют идентичный
`bbox: bodyBox` и получают одинаковый ключ.

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
     — вычисляет _cellLevelKey на device
  2. Die-level collection (per-cell-type instance loop)
     — вычисляет _dieLevelKey = cellLevelKey + instCell.id
  3. assignStableInstanceNames()
     — читает nameMap из localStorage
     — для каждого device: если _dieLevelKey в map → берёт имя
     — если нет → counter[prefix] + 1 → новое имя
     — сохраняет activeKeys
     — сохраняет map (только при изменениях)

buildAnalogNetlist()
  1. collectDieWideAnalogDevices() — уже со stable names
  2. applyAnalogOverrides() — модифицирует geometry
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
| `dieWideAnalog.ts` | `_cellLevelKey`, `_dieLevelKey` на devices. `assignStableInstanceNames()`, `renameDeviceInstance()`, `validateDeviceName()`, `getRenameVersion()`. |
| `analogNetlist.ts` | `applyAnalogOverrides()` с `_overriddenParams`. Передача overrides через pipeline. |
| `spice.ts` | `normalizeBJTM()` пропускает overridden multiplier. `generateSpiceNetlist` не перезаписывает existing names. Hierarchical path — `alreadyNamed` check. |
| `simpleAnalog.ts` | Убран пустой debug-блок в `detectMOSFromLayers()`. |
| `CellRERightPanel.tsx` | Ключ override: `device.id` → `_cellLevelKey` (position-based). |
| `DeviceInspector.tsx` | Rename UI, мутация `device.instanceName` для мгновенной обратной связи. |
| `AnalogNetlistPage.tsx` | Чтение `analogOverrides` из preferences передача в pipeline. InstanceOutline rename. |
| `NetGraphView.tsx` | `nameDevices()` сохраняет stable names. `getRenameVersion()` в deps. |
| `SchematicViewPanel.tsx` | Удалён `assignInstanceNames()` (имена уже stable). `getRenameVersion()` в deps. |
| `preferences.ts` | Удалены `instanceNameMap`, `instanceNameCounters`. |
