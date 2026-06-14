# Plan — mmo-chip mixed-signal RE

## Progress (2026-06-14 — end of day)

### ✅ Done today

**Frontend — новые вкладки и навигация:**

1. **Analog Netlist tab** (`/analog-netlist`)
   - CDL/Spectre/HSPICE просмотрщик с подсветкой, поиском, навигацией
   - Левая панель: instances по типам устройств с цветовыми swatches
   - Dialect picker, copy/download, warnings

2. **Net Graph (Cytoscape.js)** — визуализация соединений
   - Force-directed D2D граф устройств
   - Device type labels (M1·NMOS, Q1·NPN, R1·RES…)
   - VDD/GND rail nodes (детектятся по именам nets)
   - IO pins как diamond nodes (жёлтые)
   - Клик → die viewer с фокусом на ячейку
   - Hover подсветка соединений
   - Code ↔ Graph переключение в тулбаре

3. **Cross-tab навигация**
   - Analog Netlist → die viewer: double-click device → камера фреймит cell + выбирает device
   - Die viewer → RE Cell: double-click на любом cell на die (Q10 или rect)
   - Die viewer → RE Cell: 🔗 иконка в Items panel
   - URL query params (`?focusCell=&focusDevice=`) для передачи фокуса

4. **Горячие клавиши**
   - `1`-`5` для переключения вкладок (NAV_HOTKEYS в hotkeys.ts)

**Bugfixes и производительность:**

5. Исправлен crash netlist вкладки (stale `useCrossTabSelection` reference)
6. Исправлен захват мыши — AnalogDeviceHighlights canvas блокировал pan/zoom
7. Исправлена производительность — TiledCanvas перерендеривался каждый WS-тик (через `analogDevicesRef`)
8. Убран спам console.log из `dieWideAnalog.ts`
9. Починено переключение double-click zoom / RE cell navigation в OutlineTree
10. `overlayLayers.ts` — убран duplicate key

---

### 🚧 Текущее состояние архитектуры

```
frontend/
├── routes/
│   ├── DieViewerPage.tsx        ← основная: die image + аннотации + тулы
│   ├── RECellPage.tsx           ← RE ячейки
│   ├── CodePage.tsx             ← цифровой Verilog
│   ├── AnalogNetlistPage.tsx    ← CDL + Net Graph
│   ├── MergeCellsPage.tsx
│   └── LibraryPage.tsx
├── components/
│   ├── dieViewer/
│   │   └── AnalogDeviceHighlights.tsx  ← device bbox overlay на die
│   ├── netlist/
│   │   └── NetGraphView.tsx           ← Cytoscape.js граф
│   └── ...
├── api/
│   └── dieWideAnalog.ts         ← device extraction + wire matching
├── lib/
│   └── export/spice.ts          ← SPICE/CDL generation
└── state/
    └── session.ts               ← dieId, preferences
```

---

### 🔴 Топ-5 задач сейчас

1. **Net Graph — drag to fix node positions**
   Сейчас force layout пересчитывается при каждом изменении аннотаций (WS tick). Нужно: сохранять позиции нод после ручной корректировки, layout только для новых нод.

2. **Die viewer — analog device overlay as toggle layer (не чекбокс)**
   Сейчас `deviceOverlayOn` — чекбокс в боковой панели. Лучше: кнопка в DieToolbar + видимость в Items panel как у других слоёв.

3. **SPICE netlist — named nets из pin labels**
   IO pin names уже используются для namedNets. Нужно: экранирование SPICE-спецсимволов в именах, user-friendly имена для unnamed nets.

4. **CDL preview на die viewer — синхронизация с Netlist tab**
   Сейчас оба независимо вызывают `collectDieWideAnalogDevices`. Нужно: вынести выделение device в shared state — клик на device в любом месте подсвечивает везде.

5. **RE Cell — аналоговая схема для multi-device cell types**
   Если cell type содержит >1 device — показать schematic внутри RE Cell (используя существующие `analogSymbols.tsx`).

---

### ⚠️ Архитектурные проблемы и риски

1. **`collectDieWideAnalogDevices` тормозит на больших dies**
   Бегает по всем cell types × все instances × все terminals × все wire edges. На dies с сотнями ячеек и тысячами соединений — секунды вычислений. Сейчас вызывается при каждом WS тике.
   → Нужен debounce или мемоизация с глубоким сравнением `annotations`.

2. **Wire matching (terminal → net) — хрупкий эвристический алгоритм**
   `matchWireToPoint` ищет wire edge в пределах 10px от центра контакта. Если контакт дальше — fallback (device есть, но не подключен). Для реальной RE нужно intersection-based matching с учётом слоёв.
   → При current точности часть устройств в графе будет «висеть» без соединений.

3. **Нет разделения die-level и cell-level аналоговых устройств**
   `collectDieWideAnalogDevices` собирает всё в кучу. Die-level shapes (нарисованные прямо на die) и cell-level devices (извлечённые из слоёв cell types) смешаны.
   → При редактировании die-level shapes неясно, что пересчитывать.

4. **React Router и WebSocket — гонки при переключении вкладок**
   При смене вкладки старый WebSocket закрывается, новый открывается. Если annotations приходят во время размонтирования — ошибка в консоли. Не критично, но может вызывать моргание данных.

5. **Нет тестов**
   Весь аналоговый пайплайн (`collectDieWideAnalogDevices` → wire matching → SPICE gen → net graph) без единого теста. Изменение в любой функции может сломать всё остальное без предупреждения.

---

### Планы на будущее (после топ-5)

- Simulation integration (ngspice WASM) — запуск симуляции из CDL
- Net Graph → bi-directional: дроп ноды на die → создаёт annotation
- Undo/redo для analog слоёв
- Export CDL/Spectre/HSPICE с сервера
- Multi-die проекты
