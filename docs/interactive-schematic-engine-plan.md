# План: динамический (интерактивный) схемный рендер аналоговых схем

Дата: 2026-09-02 · Ветка: `analog-re-wip` · Статус: план (реализация/фаза не начата)

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