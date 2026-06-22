# Plan — mmo-chip mixed-signal RE

## Реализовано

**Аналоговый пайплайн:**
1. ✅ Data model (DeviceKind, DeviceGeometry\*, SpiceConfig)
2. ✅ Device detection (marker-based: `extractMarkedDevices`)
3. ✅ Die-wide collection + wire matching (`collectDieWideAnalogDevices`)
4. ✅ SPICE/CDL/Spectre export — выверен по эталонным Spectre-нетлистам (OPA547, FD6288)
5. ✅ Analog Netlist tab (CDL viewer + net graph)
6. ✅ Device Inspector + overlay highlights + DeviceInstancePanel
7. ✅ Cross-tab navigation (Netlist↔Die↔RE Cell)
8. ✅ Multi-layer image overlays (Die / Merge / RE Cell + clipping по cell area)
9. ✅ Ruler tool (5 режимов + калибровка масштаба double-click)
10. ✅ LPnp слой для PNP детекции
11. ✅ Per-net colors + IO pin snapping
12. ✅ Hotkeys: вкладки 1-5, overlay Ctrl+Shift+B/[]/1..8, инструменты Die/Cell RE
13. ✅ Resistor types: body layer → type detection (poly/pb/npl/hsr/film) + SheetR GUI + persistence
14. ✅ Cell type device review (force override параметров в RE Cell, persist)
15. ✅ Layout-oriented export (CSV placement + SKILL шаблон для Cadence)
16. ✅ uuid polyfill (`crypto.randomUUID()` не работает через Network IP)
17. ✅ cellsLocked (защита от случайного драга ячеек на die viewer)
18. ✅ Net ID overlay (человекочитаемые имена нетов — те же, что в SPICE)
19. ✅ Unconnected terminal glow (жёлтый ореол на новых netId >= 2000)
20. ✅ S/D net label fix (человекочитаемые имена, relabel только при отрисовке)
21. ✅ BJT terminal assignment (point-in-shape + priority E > C > B)
22. ✅ v0.1-alpha-test тег

---

## 🔴 Priority

### 1. Die-тесты с командой (текущий приоритет)
v0.1-alpha-test оттегирован. Проект готов к первому раунду тестирования на реальных die-примерах.

**Что проверить:**
- BJT (NPN/PNP/LPnp) — детекция, wire matching, параметры
- Резисторы (polyline, sheetR)
- MOS analog transistors (well-based) — fingers, bulk
- SPICE/CDL/Spectre экспорт — соответствует ли ожиданиям
- Overlay-изображения на всех трёх вкладках
- Net ID overlay и unconnected glow
- cellsLocked и RE Cell device review
- **Не тестировалось:** capacitor, diode с маркером `diode_id`
- **Риск:** wire matching на плотной разводке (bbox-based, intersection не реализован)
- **Риск:** оригинальный CMOS-маршрут может быть задет (нет цифровых die для проверки)

**Исход:** фидбек → баг-репорты → итерация.

### 2. MOS analog transistors (по фидбеку с die-тестов)
Если на die есть реальные аналоговые MOS — допилить fingers/multiplier/bulk как надо.

### 3. Wire matching → intersection (по фидбеку)
Если bbox-based wire matching не справляется на плотных блоках — переписать на shape intersection.

---

## 🟡 Backlog

- **DMOS / Шоттки / VPNP / JFET** — нет ни детекции, ни маркеров. Добавлять по необходимости.
- **Polyline editing** — сейчас только перерисовать.
- **Multi-emitter BJT разного размера** — пока все считаются одинаковыми.
- **Capacitor** — `cap_id` добавлен, но живьём не тестировался. Проверить плотность fF/µm².
- **Net graph stability** — debounce на annotation changes, сохранение позиций нод.
- **Backend API** — export/devices endpoints, если будет performance issues.
- **Cell RE hotkeys: select (V) и pan** — документированы в тулбаре, но не все могут быть зарегистрированы в центральном hotkey registry (нужно проверить).
