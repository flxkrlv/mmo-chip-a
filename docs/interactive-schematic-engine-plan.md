# План: динамический (интерактивный) схемный рендер аналоговых схем

Дата: 2026-09-02 · Ветка: `analog-re-wip` · Статус: MVP реализован (см. §10)

## 10. Реализация (2026-09-02, MVP)

Отклонения от исходного плана (согласованы в ходе работы):

- **Начальная раскладка — ELK с портами** (как netlist2svg, но отдаёт layout-данные,
  не SVG): `portConstraints: FIXED_POS` + якоря пинов из skin — приём `netlist.tsx`.
  Placement-only из §4.2 заменён: качество = статик.
- **Locked-устройства исключаются из ELK-графа** — проверено эмпирически на
  elkjs 0.11.1: layered не умеет фиксировать отдельные ноды (INTERACTIVE сохраняет
  только y-порядок), `fixed` сохраняет координаты, но не роутит рёбра, отдельного
  orthogonal-роутера в бандле нет. Провода к locked якорям — локальный роутер.
- **Drag-роутер** — не голый L/Z: кандидаты (L/Z + detour-рельсы вокруг ближайших
  препятствий) со скорингом по перекрытию bbox устройств. Пересчёт только
  затронутых net, rAF-коалесинг.

Модули: `interactiveSymbols.ts` (+тесты), `interactiveAnalogLayout.ts` (+тесты),
`state/interactiveSchematic.ts` (+тесты), `InteractiveAnalogSchematic.tsx`,
тумблер Static/Interactive в `SchematicViewPanel.tsx`.
Drag-реплика `computeJunctions` из `netlist.tsx` (export, поведение не менялось).

## 1. Цель

Дать пользователю интерактивный schematic-рендер аналоговых устройств дай, визуально
совпадающий с текущим статичным netlist2svg, но с возможностью:

- двигать устройства мышью по канвасу;
- **фиксировать** вручную поставленные позиции (они переживают re-layout и перезагрузку);
- автоматически перерисовывать связи при перемещении устройства;
- переключаться Static / Interactive в ui.

Это дифференциатор, которого нет ни у CircuitLLM (fra00/CircuitLLM), ни в netlist2svg:
у CircuitLLM `relayout()` затирает ВСЕ позиции (в коде нет `pinned`/`locked`), позиции не
персистятся; мы строим этот механизм с нуля.

## 2. Решения (согласовано)

| Вопрос | Решение | Обоснование |
|---|---|---|
| Движок канваса | Свой SVG-канвас в стиле `LogicSchematicCanvas` | ноль новых зависимостей; переиспользуем ELK (root `node_modules/elkjs`) и приём netlist.tsx; сохраняет вид настоящих схем |
| Провода | Наш простой ортогональный L/Z-роутер + хаб для N-пиновых; пересчёт только затронутых net | дёшево, детерминированно, без крашей ELK в real-time |
| Символы | **Импорт SVG-шаблонов из `netlist2svgSkin.ts` дословно** (`<g s:type>` + пины), а не перерисовка в TSX | 4-terminal MOS с bulk (`nmos_v`/`pmos_v`) кастомный и долго рисованный; перевод в TSX-компоненты рискован и долог |
| Лимит устройств | Нет (интерактив всегда) | честно по требованию; ELK placement асинхронно, fallback на grid при провале |
| Lock-позиций | Zustand + localStorage, слоты по scope | дифференциатор; персист через F5/navigations |

## 3. Статус и место в кодовой базе

Текущий статичный путь (не трогаем):

- `frontend/src/components/netlist/SchematicViewPanel.tsx` → `Netlist2SvgView`);
- `Netlist2SvgView` вызывает vendored `window.netlist2svg.render(skin, netlistJson)` →
  готовый SVG → `container.innerHTML` (только pan/zoom/tooltip);
- данные: `collectDieWideAnalogDevices` → `formatDevicesAsNetlist2Svg` (Yosys JSON);
- символы: `frontend/src/lib/schematic/netlist2svgSkin.ts` (`CUSTOM_ANALOG_SKIN`,
  `<g s:type>`), алиасы `nmos_v/pmos_v/r_v/c_v/q_npn/d_v/…`;
- терминалы→пины: `DEVICE_PORT_MAP` в `netlist2svgFormat.ts` (D/G/S/B, A/B, +/-, C/B/E);
- интерактивный паттерн, который берём за основу: `LogicSchematicCanvas` +
  `lib/schematic/netlist.tsx` (`layoutNetlist` → `NetlistLayout` с полилиниями);
  этот движок обслуживает ТОЛЬКО цифровые схемы original mmochip — не изменяем.

ELK подключается как `import ELK from "elkjs/lib/elk.bundled.js"` (root node_modules,
`elkjs@0.11.1`). `@xyflow/react` не нужен и не добавляется.

## 4. Архитектура

### 4.1 Новый модуль `frontend/src/lib/schematic/interactiveSymbols.ts`

- один раз парсит `CUSTOM_ANALOG_SKIN` → `symbolTemplates: Record<type, { body, width, height, pins: Record<pid,{dx,dy,position}> }>`;
- рендер через `<defs>` + `<use href="#sym_<type>">` (либо inline-body) — внешне
  идентично статику;
- пины дают anchor-таблицу терминалов (точная геометрия, совпадает с визуалом);
- сопоставление `терминал → pid` через `DEVICE_PORT_MAP`.

### 4.2 Новый модуль `frontend/src/lib/schematic/interactiveAnalogLayout.ts`

- `layoutInteractiveAnalog(devices, namedNets, opts)` → ELK **placement-only**
  (ноды без портов, edges component→component по цепочкам `net.connections`, приём
  CircuitLLM против ELK-crash на портах); async, `{ positions, bbox }`;
- `routeNet(net, termWorldPositions, anchorTable)` → ортогональные полилинии:
  - 2 терминала: L/Z-путь;
  - N>2: хаб + junction-точка;
- `recomputeWiresForNet(netId, positions)` — пересчитывается только затронутая net
  при drag;
- fallback: ошибка ELK → grid-раскладка + warning (движение/провода работают).

### 4.3 Новый стор `frontend/src/state/interactiveSchematic.ts`

- `positions: Record<deviceKey, {x,y}>`, `locked: Record<deviceKey, boolean>`,
  keyed `(dieId, scopeKey)`;
- слоты scope: `"full"` / регион (`region:<id>`) / `"fragment:<hash>"` — смена
  датасета не портит чужой layout;
- localStorage-персист (по образцу `assistantSession`);
- actions: `setPosition`, `setLocked`, `applyElkLayout()` (пропускает locked),
  `resetLayout`.

### 4.4 Новый компонент `frontend/src/components/netlist/InteractiveAnalogSchematic.tsx`

- паттерн `LogicSchematicCanvas`: pan/zoom (wheel+ctrl zoom, pointer-drag по фону),
  auto-fit, hover-подсветка net;
- устройства: `<g data-device-id>` → `<use>` символа; **drag устройства**
  (pointerdown на `[data-device-id]`, не на фоне) → `store.setPosition` → `recomputeWires`;
- провода: полилинии + junction-точки;
- тулбар: **Re-layout (ELK)** (locked не двигаются), **Auto-arrange** (все),
  **Lock/Unlock**, **Reset layout**.

### 4.5 Правка `SchematicViewPanel.tsx`

- кнопка-тумблер в тулбаре: **Static / Interactive** (analog-режим);
- interactive получает те же `devices/namedNets/ioNetIds` (и `selectedDeviceNames`
  для фрагмента ассистента);
- static/functional/download — без изменений;
- reuse позже: `AssistantPanel` подставит этот же компонент с своим датасетом.

## 5. Поток данных

```
SchematicViewPanel (toggle interactive)
  └─ InteractiveAnalogSchematic
       ├─ interactiveSymbols  (шаблоны символов + anchor-пины из skin)
       ├─ interactiveAnalogLayout (ELK placement → positions; routeNet → wires)
       └─ useInteractiveSchematicStore (positions/locked, персист, scope-слоты)

drag устройства → store.setPosition → recomputeWiresForNet (только затронутые)
Re-layout       → layoutInteractiveAnalog → applyElkLayout (skip locked)
```

## 6. Тесты (vitest)

- `interactiveSymbols`: из skin извлекаются все типы (nmos_v, pmos_v, r_v, c_v,
  q_npn, d_v, …); пины D/G/S/B покрыты;
- `interactiveAnalogLayout`: routeNet L/Z детерминирован; junction при 3+ терминалах;
  `applyElkLayout` не трогает locked;
- `interactiveSchematic`: слоты по scope; персистенция; lock переживает re-layout.

## 7. Критерии приёмки / проверка

- `tsc --noEmit` backend+frontend, `vitest run`;
- ручной прогон: drag → провода следят; F5 → позиции сохранены;
  Re-layout сохраняет locked; переключение static/interactive сохраняет консистентность;
- на большом дай (тысячи устройств) канвас не виснет: ELK асинхронно/с fallback,
  drag работает всегда.

## 8. Порядок реализации

1. `interactiveSymbols` + `interactiveSchematic` store (+тесты);
2. `interactiveAnalogLayout` + `routeNet` (+тесты);
3. компонент `InteractiveAnalogSchematic` (рендер символов, drag, провода, pan/zoom);
4. тумблер в `SchematicViewPanel` + fallback на больших данных;
5. (позже) reuse в `AssistantPanel`.

## 9. Источники контекста

- GENIE-ASI (arXiv 2508.19393) — assertion-repair loop, few-shot правила (см.
  `docs/llm-netlist-research` при наличии);
- fra00/CircuitLLM — React Flow + ELK placement-only; **нет lock/персиста**;
- наш `netlist.tsx`/`LogicSchematicCanvas` — собственный ortho-роутер паттерн.

## 11. Фаза 2 — расширения (2026-09-02, план)

MVP (`80f7e8c`) работает. Фаза 2 добавляет UX/стабильность. Порядок задан по приоритету:
паритет → геометрия поворота → undo/multi-select → reuse → мелочи.

### 2A Паритет со static (долг, приоритет №1)
- Восстановить конвенцию рёбер static: `s:position top=input, bottom=output; left/right →
  port_directions` (классификация из `netlist2svgFormat.ts`).
- Multi-driver безопасно: `driverSet` (все output-пины), edge driver→consumer, но с
  защитой от взрыва fan-out на power-рельсах (кап рёбер/net).
- Вернуть spacing static (5/35) в конфиг-константы + тесты.
- Новые тесты на кейсы отката: net «все пины одного направления» (nmos S×N + vcc) →
  провода есть; power-рифан VDD → разумное число рёбер, без краша; locked-вода
  (все члены net залочены) → провод дорисовывается (dirty-патч покрыт тестом).
- Тест «same input → positions близки к static» (не strict equal — ELK недетерминирован).

### 2F Поворот/зеркалирование — ТОЛЬКО вручную (v1)
- Store: `ScopeLayout.orientation: Record<deviceKey, { rot: 0|90|180|270, flip: "none"|"h"|"v" }>`,
  те же draft/персист/undo.
- Рендер: transform на `<g>`: translate + rotate(rot, w/2, h/2) + scale(flip); при
  rot 90/270 swap width/height.
- **Критично**: якоря пинов поворачиваются — `transformPin(pin,w,h,orientation)` →
  `{dx,dy,side}`. Применяется к `devicePorts` (ELK input), `ioPinLookup`, `routeNetLocal`
  одновременно; side меняется (NORTH→WEST при rot90), иначе ELK-порты «прыгают».
- UI: кнопки Rotate ⟳/⟲, Flip ⇄/⇅ в тулбаре (применяются к selection).
- Ограничение v1: initial layout rot 0/flip none (как static); **ELK-предложение
  разворотов отложено в features** (дифпары зеркалить автоматически — будещая фича).
- Тесты: `transformPin` 0/90/180/270+flip; width/height swap; ELK-port side корректен;
  локальный роутер якорей после поворота.

### 2B Undo/redo
- Снапшот-стек `Array<{positions, locked, orientation}>` в памяти (персист только
  current state), лимит ~50, `undo(scopeKey)`/`redo(scopeKey)`.
- Ctrl+Z / Ctrl+Shift+Z (keydown на канвас), кнопки в тулбаре.
- Тесты: drag→undo→redo; applyPositions (ELK) → undo возвращает прежнее.

### 2E Multi-select + group drag
- `selection: Set<string>` (вместо single) — shift+click, прямоугольник выделения,
  Ctrl+A.
- Group drag применяет смещение ко всем не-locked; routing затронутых net разом.
- Lock-кнопка для всей selection (логика «все locked / все unlocked»).
- Тесты: rect-выделение; group drag; locked-член группы заморожен + его net пересчитаны.

### 2G Reuse в AssistantPanel
- `InteractiveAnalogSchematic` в AssistantPanel для фрагмента находки
  (данные уже есть через `selectedDeviceNames`/`formatDevices...`); слот `fragment:<hash>`.
- Static toggle по умолчанию — без регресса.

### 2C Zoom-to-device
- Поиск по `instanceName`/`deviceKey` → панорамирование viewport на узел + подсветка.
- Тест: узел попадает в центр viewport.

### 2D Export — PNG на белом фоне, чёрные элементы (для документов/отчётов)
- Сериализация сцены (defs + viewport + полилинии + узлы + лейблы) → SVG → PNG через
  canvas; SVG/JSON export отложены.
- Тест: парс сгенерированного SVG содержит все узлы и полилинии.

### Проверка каждой фазы
`tsc --noEmit` (frontend+backend), `vitest run`, `vite build`, коммит по фазам.