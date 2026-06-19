# mmo-chip — analog-re-wip

**Форк [mmo-chip](https://github.com/openclaw/mmo-chip) для реверс-инжиниринга аналоговых и mixed-signal ИС.**  
Исходный проект ориентирован на цифровые CMOS Gate Array / Standard Cell чипы и извлекает логические вентили и Verilog-нетлист.  
Этот форк расширяет его до **BJT, BiCMOS, резисторов, конденсаторов, диодов** — всей аналоговой периферии, которая не укладывается в модель стандартных ячеек.

## Благодарности (ENG)
Many thanks to the developers of the original [mmo-chip](https://github.com/openclaw/mmo-chip ).  
Clean architecture, thoughtful modularity, and clear interfaces between the frontend, backend, and shared types are an excellent base for custom extensions, for example, for RE analog blocks and chips.

Оригинальный CMOS-маршрут (стандартные ячейки, логика, Verilog) **не тронут** — аналоговая экстракция работает как надстройка. Мы старались не сломать цифровой маршрут, но это нуждается в проврерке - у нас нет опыта в цифровой логике и примеров снимков таких кристалов. 

```
┌─────────────────────────────────────────┐
│                mmo-chip                  │
├────────────────┬────────────────────────┤
│  CMOS Logic    │  Analog Extraction      │
│  (оригинал)    │  (наша ветка)           │
├────────────────┼────────────────────────┤
│ extractCell()  │ extractMarkedDevices()  │
│ gates.ts       │ simpleAnalog.ts         │
│ logic.ts       │ dieWideAnalog.ts        │
│ verilog.ts     │ spice.ts                │
├────────────────┼────────────────────────┤
│ Standard cells │ NPN, LPNP, MOS, R, C, D │
│ Gate-level     │ Transistor-level        │
│ Verilog        │ SPICE/CDL/Spectre       │
└────────────────┴────────────────────────┘
```

---

## Поддерживаемые устройства

| Устройство | Детекция | Параметры |
|---|---|---|
| **NMOS / PMOS** (3-/4-терминальные) | **Well-based**: nwell→PMOS, pwell→NMOS. Без маркеров — автоматически по пересечению diffusion + polysilicon | W, L, fingers (M). Bulk: контакт на nwell/pwell вне diffusion/poly. Если нет — PMOS=VCC, NMOS=GND |
| **NPN** | Маркер `npn_id` с collector + base + emitter | AE (overlap base∩emitter), multiplier M |
| **PNP / LPnp** (латеральный PNP) | Маркер `pnp_id` | AE, PE (периметр эмиттера), multiplier M |
| **Диод** | Маркер `diode_id` **или** NPN/PNP без коллектора — base=анод(+), emitter=катод(-) | Площадь (AE из base-emitter overlap) |
| **Резистор** | Маркер `res_id` + body-слой (poly/base/emitter/hsr/film). Можно рисовать polyline-меандр (пока несколько кривая отрисовка и редактирование) | Ω или squares×Rₛ. Поддерживаются body-слои: poly-R, p-base (pb), n+ (npl), HSR (high-sheet), thin film |
| **Конденсатор** | Маркер `cap_id` — ёмкость из overlap-области | fF = площадь × плотность (1 fF/µm² по умолчанию) - проверить |

---

## Как рисовать устройства

### MOS-транзистор (well-based, маркеры не нужны)

MOS детектируется **автоматически** по пересечению слоёв — отдельно рисовать маркеры не требуется.

| Слой | Назначение |
|---|---|
| `nwell` | PMOS-транзисторы ищутся внутри nwell |
| `pwell` | NMOS-транзисторы ищутся внутри pwell |
| `diffusion` | Тело транзистора (исток + сток) |
| `polysilicon` | Затворы, пересекающие diffusion |

1. Нарисуйте `nwell` (для PMOS) или `pwell` (для NMOS) на Cell RE.
2. Внутри well нарисуйте `diffusion` — это область истока и стока.
3. Нарисуйте `polysilicon` поперёк diffusion — это затвор.
4. **Bulk:** нарисуйте `cont` (contact) на nwell/pwell **вне** diffusion и polysilicon. Если контакт попадает и на diffusion — он считается S/D, не bulk. Если bulk-контакта нет — PMOS будет подтянут к VCC, NMOS к GND.
5. **Металлизация:** соедините diffusion-области через контакты («via») и metal1 с остальной схемой. 
W/L и количество пальцев (fingers) вычисляются автоматически.


#### Пример (N-канальный) - позже добавим изображение-пример:

```
       pwell
┌─────────────────────┐
│    diffusion         │
│  ┌──────────────┐   │
│  │   polysilicon │   │  ← затвор пересекает diffusion
│  │  ┌──────┐    │   │
│  │  │      │    │   │
│  │  └──────┘    │   │
│  └──────────────┘   │
│         ∙           │  ← contact на pwell = bulk (подтяжка к GND)
└─────────────────────┘
```

### BJT (NPN / PNP)

| Слой | Назначение |
|---|---|
| `npn_id` | Bounding box NPN |
| `pnp_id` | Bounding box PNP |
| `collector` | Область коллектора |
| `base` | Область базы |
| `emitter` | Область эмиттера |

1. **Выберите bounding box:** нарисуйте `npn_id` (NPN) или `pnp_id` (PNP / LPnp) — прямоугольник, охватывающий весь прибор.
2. **Нарисуйте слои:** collector, base, emitter — в виде rect или polygon внутри bbox.
3. **Контакты:** поставьте `cont` (contact) на каждый слой. Инструмент сам сопоставит контакты с выводами.
4. **Для PNP / LPnp** PE (perimeter) = периметр эмиттера — используется как основной параметр.
5. **Multi-emitter:** нарисуйте несколько эмиттеров внутри одного bbox — инструмент сложит их площади и выставит multiplier M.

> **Важно:** emitter должен лежать **внутри** base (или пересекаться с ней). Это layout-ориентированный физический подход, понятный для топологов

### Диод

**Способ 1 — маркер `diode_id`:**  
Нарисуйте `diode_id` — прямоугольник вокруг области диода. Не тестировался

**Способ 2 — из BJT без коллектора (рекомендуемый):**  
Нарисуйте `npn_id` (или `pnp_id`) с `base` + `emitter`, но **без** `collector`.  
Инструмент автоматически распознает прибор как диод:
- Base = анод (PLUS)
- Emitter = катод (MINUS)
- AE (overlap base ∩ emitter) = площадь диода

### Резистор

| Слой | Назначение |
|---|---|
| `res_id` | Bounding box резистора |
| `poly` / `polysilicon` | Тело (poly-резистор) |
| `base` | Тело (p-base diffusion) |
| `emitter` | Тело (n+ diffusion) |
| `hsr` | Тело (High Sheet Resistance — ионная имплантация) |
| `film` | Тело (тонкоплёночный) |
| `contact` | Контакты (минимум 2) |

1. Нарисуйте `res_id` — bounding box для экстракции. 
2. Выберите **body-слой** из списка: poly, base, emitter, hsr, film. Нарисуйте тело резистора используя polyline tool.
3. Нарисуйте me-1 прямоугольник, перекрывающийся с телом резистора. Поставьте минимум 2 контакта (`contact`) на нарисованные me-1 области — они станут PLUS и MINUS выводами резистора.
4. **Polyline-режим:** для меандров используйте инструмент Polyline (клавиша `L`).  
   Каждый сегмент polyline суммируется в общую длину. Ширина задаётся в панели инструментов (по умолчанию в пикселях).  
   Polyline автоматически привязывается к ортогональным направлениям (90° snap). Но отрисовка в процессе рисования не орготональная.. Баг или фича? но пока так.. 

> **Sheet R₀:** настраивается в GUI (по умолчанию: poly=25 Ω/□, hsr=1500 Ω/□, pb=200 Ω/□, npl=5 Ω/□, film=500 Ω/□). Это базовые ориентировные значения, которые могут меняться в широких пределах
> Сопротивление = squares × sheetR₀. Можно переключать отображение между Ω и sq·Rs.

### Конденсатор (не тестировался)

1. Нарисуйте `cap_id` — bounding box (overlap-область = ёмкость).
2. PLUS и MINUS — оба на `contact` слое.

---

## Управление (горячие клавиши)

### Die Viewer — инструменты

| Клавиша | Инструмент |
|---|---|
| `S` | Select (выделение) |
| `W` | Wire (трасса) |
| `B` | Multi-wire / Bus |
| `O` | Via (контактное окно) |
| `K` | Ruler / Measurement (линейка) |
| `R` | Add Cell (добавить ячейку) |
| `P` | I/O Point (вход/выход) |
| `F` | Fit to Screen / Pan |
| `+` / `=` | Zoom in |
| `-` | Zoom out |

### Die Viewer — навигация по вкладкам

| Клавиша | Вкладка |
|---|---|
| `1` | Die viewer |
| `2` | Merge cells |
| `3` | RE cell |
| `4` | Code |
| `5` | Analog Netlist |

### Cell RE — инструменты

| Клавиша | Инструмент |
|---|---|
| `R` | Rect (прямоугольник) |
| `P` | Polygon (многоугольник) |
| `O` | Point / via (точка / контакт) |
| `L` | Polyline (меандр-резистор) |

### Undo / Redo

| Клавиши | Действие |
|---|---|
| `Ctrl+Z` / `⌘Z` | Undo |
| `Ctrl+Shift+Z` / `⌘⇧Z` | Redo |

### Overlay-изображения (общие)

| Клавиши | Действие |
|---|---|
| `Ctrl+Shift+B` | Показать / скрыть базовое изображение (фото кристалла) |
| `]` | Показать **только** следующий overlay-слой (N+1), остальные скрыть |
| `[` | Показать **только** предыдущий overlay-слой (N-1), остальные скрыть |
| `Ctrl+Shift+1..8` | Показать **только** overlay-слой №1..8, остальные скрыть |

Работают на всех трёх вкладках: Die Viewer, Merge Cells, RE Cell. (надо проверять)

### Cell RE — прочее

| Клавиши | Действие |
|---|---|
| `Ctrl+C` / `⌘C` | Копировать выделенные фигуры |
| `Ctrl+V` / `⌘V` | Вставить |
| Пробел (hold) | Временный Pan (в любом инструменте) |

---

## Ключевые изменения относительно оригинального mmo-chip (main)

- **Well-based MOS** — единственный путь для MOS. 
- **Diode из BJT** — рисование NPN/PNP без коллектора автоматически даёт диод. Base = PLUS, Emitter = MINUS.
- **BJT с multiple emitter** — AE суммируется, multiplier M = количество эмиттеров (надо проверять)
- **Polyline Tool** — рисование резисторов-меандров с 90° ортогональным snap, редактируемой шириной.
- **Ruler Tool** (клавиша `K`) — измерение расстояний на кристалле. Режимы: free, horizontal, vertical, orthogonal, diagonal (45°). Double-click → ввод размера в µm → umPerPx сохраняется.
- **Overlay-изображения** — мультислойные SEM / doping / металл-изображения, загружаемые с сервера или из файла, с горячими клавишами управления.
- **Analog overlay на die viewer** — каждый обнаруженный прибор: цветной прямоугольник с подписью (`M1 pmos`, `Q3 npn`, `R5 poly res`...) и параметрами. Терминальные метки (G, S/D, C, B, E) при зуме >0.7×, параметры >0.5×.
- **SPICE/CDL/Spectre экспорт** — корректный Spectre-формат. MOS: w/l/m без AS/AD/PS/PD. BJT: AE, PE, M. Резисторы: r=Ω. Диоды: are a=AREA. Три диалекта. (надо проверять совместимость - не тестировалось)
- **BJT normalisation** — поиск минимального AE (NPN) / PE (PNP) → это m=1, остальные масштабируются.
- **Cell RE device review** — force override W/L, AE, R, fingers через GUI. (надо проверять)
- **Layout CSV + SKILL шаблон** для импорта в Cadence.
- **Net Graph** (Cytoscape.js) — force-directed граф соединений приборов. Режимы: пока только D2D (device-to-device) 
- **Per-net color override** — цвета выводов сохраняются в preferences.
- **uuid polyfill** — `crypto.randomUUID()` не работает через Network IP; заменён на `uuid()` с fallback Math.random() для v4.
- **Overlay-изображения на Merge Canvas + RE Cell Canvas** — с clipping по cell area и глобальными hotkeys.

---

## Что ещё не сделано (нужно и приоритетно)

- **DMOS** (LDMOS / VDMOS) — нет ни детекции, ни маркеров
- **Диод Шоттки** — отдельный маркер / детекция
- **VPNP** (вертикальный PNP) — слой `vpnp` добавлен в типы, но не детектится
- **JFET** — маркеры и geometry params в зачаточном состоянии
- **Multi-emitter BJT с эмиттерами разного размера** — пока все считаются одинаковыми
- **Wire matching на die-wide уровне** — потенциально нестабилен на плотных разводках
- **Редактирование polyline после размещения** — только перерисовать заново
- **Сериализация overlay-изображений** в JSON аннотаций (пока статика)
- **L-хоткей для polyline** — указан в тулбаре, но не зарегистрирован в центральном hotkey registry
- **Cell RE hotkeys: select (V) и pan** — документированы в тулбаре, но не все могут быть зарегистрированы

---

## ⚠️ Предупреждение

**Всё ещё альфа / WIP.** Код покрыт только unit-тестами extraction pipeline (29/30 pass; 1 pre-existing resistor R= fail).  
Нет сквозных (e2e) тестов, нет тестов на overlay, wire matching, SPICE-экспорт, cross-tab навигацию.
Не было тестирования пользователями.

**Возможны:**
- Критические ошибки и потеря данных
- Некорректные нетлисты (особенно на сложной разводке)
- Ложные срабатывания / пропуски при детекции на плотных аналоговых блоках

Проверяйте результаты визуально и перекрёстно с оригиналом (даташит / layout / SEM).  
Пишите баг-репорты и тестовые кейсы.

---

## Структура репозитория

```
frontend/     Vite + React + TypeScript — die viewer, cell RE, analog netlist, overlay
backend/      Node + TypeScript API — import, tiling, JSON persistence, WebSocket
shared/       Shared TypeScript types (annotation schema + analog device types)
ml/           Python U-Net (опционально, для assisted annotation)
docs/         Документация (analog-devices.md — полное описание детекции и API)
```

Ключевые файлы аналоговой экстракции:

```
frontend/src/
  api/dieWideAnalog.ts           ← DEVICE_TERMINAL_DEFS, resolveDeviceContacts, collectDieWideAnalogDevices
  lib/extraction/
    simpleAnalog.ts               ← extractMarkedDevices, detectMOSFromLayers
    analogDevices.ts              ← computeMOSParams, computeBJTParams, etc.
  lib/export/spice.ts             ← netlist generation (CDL/Spectre/HSPICE)
  components/dieViewer/
    AnalogDeviceHighlights.tsx    ← canvas overlay
  components/cellRE/
    CellREToolbar.tsx             ← инструменты Cell RE
    useLayerPolylineTool.ts       ← polyline (резистор-меандр)
  state/cellRE.ts                 ← TOOL_LAYERS, ReToolKind, polyline state
  lib/hotkeys.ts                  ← центральный registry горячих клавиш
  lib/useOverlayHotkeys.ts        ← overlay-хоткеи
  routes/
    AnalogNetlistPage.tsx          ← Analog Netlist вкладка
    RECellPage.tsx                 ← RE Cell страница
```

---

## Запуск

```sh
# Node ≥ 20
npm install

# Запуск всего (бэкенд + фронтенд + ML sidecar):
npm run dev

# По отдельности:
npm run dev -w backend    # http://localhost:3001
npm run dev -w frontend   # http://localhost:5173
```

Тесты:

```sh
npm test                                             # все тесты
node --import tsx --test backend/src/analog-extraction.test.ts  # только extraction
```

---

