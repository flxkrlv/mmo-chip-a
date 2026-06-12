# ANALOG RE — План и состояние 2026-06-12 (конец сессии)

## ✅ Работает стабильно

| Компонент | Статус |
|-----------|--------|
| **BJT нетлист** (NPN/PNP, C/B/E, M=N, diode-connected, без B/E shorts) | ✅ |
| **Wire-to-terminal snapping** (contact-based, оранжевый гало) | ✅ |
| **Device overlay** (Q/R/M/C/D цветные боксы, toggle, terminal labels PLUS/MINUS/C/B/E) | ✅ |
| **Dual-emitter BJT** (M=2, M=6, AREA per-finger) | ✅ |
| **Wire matching** (уник. контакты + proximity 10px + segment-rect intersection) | ✅ |
| **SPICE/CDL export** (правильные model cards NPN_GEN/PNP_GEN) | ✅ |
| **Polyline tool** (рисование, 90° орто, Enter, W input в тулбаре) | ✅ |
| **Резисторы** (bbox+polyline извлечение, SQUARES, параметры в правой панели) | ✅ |
| **Editing resistor width** (W input в правой панели меняет все линии) | ✅ |
| **Resistor rendering** (grouped path, lineJoin=round углы, lineCap=butt концы) | ✅ |
| **Outline tree cell naming** (UUID → Q1/Q2/R1) | ✅ |
| **Device Inspector** (двойной клик в дереве → параметры W/L/AE) | ✅ |

## ⚠️ Частично / с багами

| Компонент | Проблема |
|-----------|----------|
| Device Inspector overlay click | Отключён (pointer-events ломает pan/zoom). Работает через OutlineTree |
| AnalogDiePanel | Сломанные импорты `detectAnalogDevices`/`shapeToPolygon` — latent bug |

## ❌ Ещё нет

MOS транзисторы, конденсаторы, диоды, иерархические subcircuit'ы, netlist visualization

## Ключевые файлы

| Файл | Что |
|------|-----|
| `frontend/src/api/dieWideAnalog.ts` | collectDieWideAnalogDevices, matchWireToTerminal, terminalLayersOf |
| `frontend/src/lib/extraction/simpleAnalog.ts` | extractMarkedDevices (NPN/PNP/resistor/MOS) |
| `frontend/src/lib/extraction/terminalDetect.ts` | detectCellTypeTerminals (contact-based snapping) |
| `frontend/src/lib/export/spice.ts` | SPICE/CDL/Spectre генераторы |
| `frontend/src/components/dieViewer/useWireTool.ts` | Wire tool + terminal snapping |
| `frontend/src/components/dieViewer/AnalogDeviceHighlights.tsx` | Device overlay canvas |
| `frontend/src/components/dieViewer/DeviceInspector.tsx` | Device parameter panel |
| `frontend/src/components/dieViewer/OutlineTree.tsx` | Cell tree with Q1/R1 names |
| `frontend/src/components/cellRE/useLayerPolylineTool.ts` | Polyline drawing tool |
| `frontend/src/components/cellRE/CellREToolbar.tsx` | Toolbar with W input |
| `frontend/src/renderer/annotations/shapes.ts` | Line grouping renderer |
| `frontend/src/state/cellRE.ts` | CellREStore (polylineDraft, polylineWidth) |
| `frontend/src/routes/DieViewerPage.tsx` | Main integration |
| `frontend/src/routes/RECellPage.tsx` | Cell RE page integration |

## Следующий шаг

Чистка кода → MOS транзисторы → иерархические нетлисты.
