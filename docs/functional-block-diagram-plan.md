# Functional Block Diagram — план реализации

## Цель
Для иерархических (per-region) нетлистов генерировать функциональную блок-диаграмму:
- Каждый floorplan-регион = прямоугольник-блок
- Порты на блоках с именами, direction (input/output)
- Сигналы слева направо (direction="RIGHT")
- netlistsvg default skin (не analog)
- Питание VDD/GND — глобальные символы сверху/снизу

аналовый схемный рендер ОСТАВЛЯЕМ как есть, ДОБАВИМ к нему новый функционал - блок схемы на основе иерархии

## Формат Yosys JSON
```json
{
  "modules": {
    "mmo_chip_top": {
      "ports": {
        "AIN0": {"direction": "input", "bits": [10]},
        "DOUT_0": {"direction": "output", "bits": [50]}
      },
      "cells": {
        "IO_Block": {
          "type": "block_io_pads",
          "port_directions": {"AIN0": "input", "DOUT_0": "output"},
          "connections": {"AIN0": [10], "DOUT_0": [50]}
        },
        "MUX_Block": {
          "type": "block_mux_core",
          "port_directions": {"SEL": "input", "IN0": "input", "OUT": "output"},
          "connections": {"IN0": [10], "OUT": [20], "SEL": [70]}
        },
        "PGA_Block": {
          "type": "block_pga_core",
          "port_directions": {"IN": "input", "OUT": "output"},
          "connections": {"IN": [20], "OUT": [30]}
        }
      }
    }
  }
}
```

## Данные на вход
- `Map<regionId, AnalogDevice[]>` — уже есть в `n2sData.floorplanDevices`
- `namedNets: Map<number, string>` — имена нетов
- `ioNetIds: Set<number>` — IO пины кристалла
- `vdd` / `gnd` имена из конфига

## Алгоритм для каждого региона
1. **Собрать все netId**, которые используются устройствами региона
2. **Собрать все netId**, которые используются устройствами из других регионов (или IO пины)
3. **Пересечение** = внешние порты региона
4. **Определить direction** для каждого порта:
   - Есть хоть один MOS в регионе с этим нетом на gate → `"input"`
   - Нет gate-соединений, только drain/source/passive → `"output"`
   - И gate, и drain/source → `"inout"` (редко для аналога)
   - VDD/GND → исключить (глобальное питание)
5. **Создать cell** для региона: `type="block_<normalized_region_id>"`

## Эвристика direction
```typescript
function inferPortDirection(regionDevices, netId): "input" | "output" | "inout" {
  let hasGate = false, hasPassive = false;
  for (const d of regionDevices) {
    for (const t of d.terminals) {
      if (t.netId !== netId) continue;
      if (isGateTerminal(d, t)) hasGate = true;
      else hasPassive = true;
    }
  }
  if (hasGate && hasPassive) return "inout";
  if (hasGate) return "input";
  return "output";
}
```

## Минимальный skin для блок-диаграммы
- Только `vcc`, `gnd`, `inputExt`, `outputExt` — известные типы
- Все `block_*` типы не имеют матчинга в скине → netlistsvg рисует авто-прямоугольники
- layout direction = `"RIGHT"` (сигнал слева направо)

## UI (SchematicViewPanel.tsx)
- Кнопка "Analog" / "Functional" (рядом с "Spice-TS" / "Netlist2SVG")
- Functional доступен только когда `hierarchical=true` и есть floorplan-регионы
- Layout strategy selector не показывается в Functional mode (там свой скин)

## Файлы
- `frontend/src/lib/schematic/blockDiagramFormat.ts` — генерация Yosys JSON
- Изменения в `SchematicViewPanel.tsx` — новая кнопка
- Изменения в `Netlist2SvgView.tsx` — поддержка разных скинов

## Приоритет
1. ❌ НЕ сейчас — сначала чиним analog skin (ELK crash)
