# ANALOG RE — План и состояние 2026-06-12 (конец сессии)

## ✅ Реализовано и стабильно

| Компонент | Файлы | Комментарий |
|-----------|-------|-------------|
| **BJT netlist** — NPN/PNP, C/B/E, M=N multiplier, diode-connected, без B/E shorts | `simpleAnalog.ts`, `dieWideAnalog.ts`, `spice.ts` | Уник. контакты + proximity 10px + segment-rect intersection |
| **Wire-to-terminal snapping** — orange halo, contact-based | `terminalDetect.ts`, `useWireTool.ts`, `snapHalo.ts` | Одна точка снаппинга на каждый contact под металлом |
| **Device overlay** — Q/R/M/C/D цветные боксы + terminal labels (C/B/E, PLUS/MINUS) + toggle | `AnalogDeviceHighlights.tsx` | LiveValue-driven, без render-loop |
| **Dual-emitter BJT** — сумма emitter areas, M=N, AREA per-finger | `simpleAnalog.ts`, `spice.ts` | Проверено на M=2, M=6 |
| **Resistor extraction** — bbox + polyline, формула (L−corners×W)/W + 0.55×corners, SQUARES | `simpleAnalog.ts` | Терминалы PLUS/MINUS |
| **Polyline tool** Cell RE — рисование, 90° орто, ширина в тулбаре, Enter, ⌘Z | `useLayerPolylineTool.ts`, `CellRECanvas.tsx`, `CellREToolbar.tsx` | Основан на `useLayerPolyTool` |
| **Редактирование ширины** — W input в правой панели меняет все lines разом | `CellRERightPanel.tsx`, `RECellPage.tsx` | Один action на все сегменты |
| **Рендеринг резисторов** — grouped path, lineJoin=round углы, lineCap=butt концы | `shapes.ts` | Нет закруглений на концах, углы заполнены |
| **Outline tree naming** — UUID → Q1/Q2/R1/M1 | `OutlineTree.tsx`, `DieViewerPage.tsx` | `_cellId` на устройстве, маппинг |
| **Device Inspector** — двойной клик в дереве → параметры W/L/AE | `DeviceInspector.tsx`, `OutlineTree.tsx` | Код был готов, подключён |
| **SPICE model cards** — NPN_GEN / PNP_GEN / RES_GEN | `spice.ts` | Генерируются автоматически |
| **mergeCells fix** — защита от undefined name | `mergeCells.ts` | `name ?? ""` |

## ⚠️ Известные ограничения

| Компонент | Ограничение |
|-----------|-------------|
| Device overlay click | Отключён (pointer-events ломает pan/zoom). Инспектор через дерево |
| AnalogDiePanel die-level extraction | Застаблен (сломанные импорты). Cell-level extraction работает |
| Resistor rendering | P/N регионы визуально не отсекаются (res NOT me1) |
| Polyline width | Не обновляется в превью при смене в тулбаре без ререндера |

## ❌ Не реализовано

| Компонент | Приоритет |
|-----------|-----------|
| MOS транзисторы (D/G/S/B) | 🔴 Critical |
| Конденсаторы / диоды | 🔵 Nice-to-have |
| Иерархические subcircuit'ы | 🔵 Nice-to-have |
| Netlist visualization | 🔵 Nice-to-have |
| Авто-определение типа контакта (p_base NOT emit) | 🔵 Nice-to-have |
| Клик на оверлей для инспектора | 🟡 Secondary |

## Архитектурные задачи

| Задача | Приоритет |
|--------|-----------|
| Вынести геометрию из `dieWideAnalog.ts` в отдельный модуль | 🟡 Secondary |
| Объединить `terminalDetect` и wire matching логику | 🟡 Secondary |
| Device↔cell instance обратная связь | 🟡 Secondary |
| Polyline canvas rendering тесты | 🟡 Secondary |

## Ключевые файлы

```
frontend/src/api/dieWideAnalog.ts        — collectDieWideAnalogDevices, wire matching
frontend/src/lib/extraction/simpleAnalog.ts — marker-based device extraction
frontend/src/lib/extraction/terminalDetect.ts — contact-based terminal detection
frontend/src/lib/export/spice.ts          — SPICE/CDL/Spectre generators
frontend/src/components/dieViewer/
  AnalogDeviceHighlights.tsx              — device overlay
  DeviceInspector.tsx                     — device parameter panel
  OutlineTree.tsx                         — cell tree (Q1/R1 names)
  useWireTool.ts                          — wire tool + terminal snapping
  snapHalo.ts                             — orange terminal halo
frontend/src/components/cellRE/
  useLayerPolylineTool.ts                 — polyline drawing hook
  CellREToolbar.tsx                       — toolbar (polyline W input)
  CellRERightPanel.tsx                    — right panel (resistor params)
  CellRECanvas.tsx                        — canvas (polyline rendering)
frontend/src/renderer/annotations/
  shapes.ts                               — line grouping renderer
frontend/src/state/cellRE.ts              — CellREStore (polyline)
frontend/src/routes/
  DieViewerPage.tsx                       — main die viewer integration
  RECellPage.tsx                          — Cell RE page integration
```

## Ближайшие задачи

1. **MOS транзисторы** (D/G/S/B) — инфраструктура готова, нужен wire matching для 4-pin устройств
2. **Конденсаторы** — bbox-area, два терминала, capType
3. **Клик на оверлей** — Device Inspector через клик на устройство (не ломая pan)
4. **Иерархический нетлист** — .SUBCKT на каждый cell type

## Git

- Ветка: `analog-re-wip`
- Милестоуны: `bjt-netlist-mvp`, `resistor-polyline-mvp`, `bjt-resistor-mvp` (latest)
- Коммитов сегодня: 40+
