# Plan — mmo-chip mixed-signal RE

## Реализовано

**Аналоговый пайплайн:**
1. ✅ Data model (DeviceKind, DeviceGeometry\*, SpiceConfig)
2. ✅ Device detection (marker-based: `extractMarkedDevices`)
3. ✅ Die-wide collection + wire matching (`collectDieWideAnalogDevices`)
4. ✅ SPICE/CDL/Spectre export (`spice.ts`)
5. ✅ Analog Netlist tab (CDL viewer + net graph)
6. ✅ Device Inspector + overlay highlights
7. ✅ Cross-tab navigation (Netlist↔Die↔RE Cell)
8. ✅ Multi-layer image overlays + ruler tool
9. ✅ LPnp слой для PNP детекции
10. ✅ Per-net colors + IO pin snapping
11. ✅ Hotkeys 1-5 для переключения вкладок
12. ✅ Resistor types: body layer → type detection (poly/pb/npl/hsr/film) + SheetR GUI
13. ✅ Cell type device review (force override параметров в RE Cell, persist)
14. ✅ Layout-oriented export (CSV placement + SKILL шаблон)

---

## 🔴 Priority

### 1. RE Cell стабильность (баги пофикшены)
- `activeCellTypeId is not defined` в `CellRERightPanel` — пофикшено (15.06)
- Бесконечный цикл рендера в `AnalogDeviceRow` через zustand selector — пофикшено (15.06)

### 2. SPICE — quality pass (блокировано)
Ждёт эталонный netlist от пользователя. Подогнать `spice.ts` под реальный формат.

### 3. MOS analog transistors (блокировано)  
Ждёт die с реальными аналоговыми MOS. Допилить fingers/multiplier/bulk.

### 4. Wire matching → intersection (отложено)
Пробная попытка — откатили. Нужен правильный bbox из contact shapes, не из центров.

---

## 🟡 Backlog

- **Net graph stability** — debounce на annotation changes, сохранение позиций нод
- **Backend API** — export/devices endpoints, если будет performance issues
- **Layout-oriented SKILL export** — CSV координат + шаблон скрипта для Cadence (✅ MVP готов)
