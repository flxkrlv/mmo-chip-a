# Plan — mmo-chip mixed-signal RE

## Реализовано (2026-06-14)

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

---

## Приоритеты

### 1. Wire matching — надёжность (🔴 Critical)

**Проблема:** `matchWireToPoint` ищет провод по distance-check (10px от центра контакта). Если контакт дальше — terminal остаётся unconnected.

**Решение:** Заменить distance-check на **segment-rectangle intersection**. Функция `segmentIntersectsRect` уже есть в `dieWideAnalog.ts` (строка 45). Надо применить её в `matchWireToTerminal` и использовать вместо `matchWireToPoint` во всех местах.

**Snap to contact:** пользователь получает визуальное подтверждение что провод дошёл до контакта. Добавить как preferences toggle (аналог snapToVias).

**Тесты:** После перехода на intersection — проверить на всех типах устройств (BJT, MOS, R, C, D). Сверять с эталонным SPICE-нетлистом.

---

### 2. SPICE — качество экспорта (🔴 Critical)

**Проблема:** Текущий CDL/Spectre/HSPICE весьма условный. Параметры транзисторов, model cards, имена nets — всё надо доводить под реальные примеры.

**Решение:**
- Загрузить реальный SPICE-нетлист от работающей схемы
- Подогнать `spice.ts` под этот формат
- Сверить совпадение параметров (W/L, AE, m, fingers)
- Проверить корректность model cards (.MODEL / model)

---

### 3. Resistor types + SheetR GUI (🟡 High)

**Типы резисторов (новые layer types):**
- `hsr` — ion implanted (high sheet R)
- `pb` — p base (диффузионный)
- `npl` — n plus (диффузионный)
- `poly` — poly si
- `film` — плёночный

**SheetR:** задаётся в GUI (SpiceConfig panel) для каждого типа. По умолчанию: hsr=1000, pb=200, npl=50, poly=30, film=100 (Ω/□).

---

### 4. MOS analog transistors (🟡 High — deferred)

**Когда:** После загрузки die с реальными аналоговыми MOS.

**Что нужно:**
- `fingers` — детекция параллельных poly-затворов
- `multiplier` — детекция повторяющихся ячеек
- `bulk` terminal — привязка к well

Сейчас `extractMarkedDevices` уже умеет W/L и mosType. Остальное допилится на реальных данных.

---

### 5. Cell type device review (🟡 Medium)

**Что это:** UI внутри RE Cell для просмотра/редактирования списка аналоговых устройств, найденных в текущем cell type.

**Зачем:** Сейчас extraction — чёрный ящик. Если найдено не то устройство или неверные параметры — нет способа проверить/поправить.

**Что делать:**
- Секция "Analog devices" в левой панели RE Cell
- Список найденных устройств с типом и параметрами
- Force override: пользователь может изменить kind, поправить W/L/AE/m
- Добавить устройство вручную (если extraction пропустил)

---

## Когда будет сделано (следующие)

| Задача | Когда | Приоритет |
|--------|-------|-----------|
| Wire matching → intersection | Сейчас (после обновления плана) | 🔴 Critical |
| SPICE — quality pass | После загрузки эталонного нетлиста | 🔴 Critical |
| Resistor types + SheetR GUI | После wire matching | 🟡 High |
| MOS analog transistors | После загрузки die с аналоговыми MOS | 🟡 High |
| Cell type device review | После резисторов | 🟡 Medium |
| Net graph stability | Низкий | 🔵 Low |
| Backend API (export) | Если performance проблемы на больших dies | 🔵 Deferred |
| Layout-oriented export (SKILL) | Развитие идеи | 🔵 Research |
| CDL preview на die viewer | **Удалить** — дублирует Netlist tab | 🗑️ |

---

## Cross-tab sync — что есть и что нужно

**Работает:**
- Analog Netlist (device double-click) → die viewer (frame + select) ✅
- Analog Netlist (Graph → node click) → die viewer ✅
- Die viewer (double-click cell) → RE Cell ✅
- Die viewer (🔗 icon) → RE Cell ✅
- Die viewer (device double-click на die) → RE Cell ✅
- OutlineTree double-click → zoom to cell ✅

**Не хватает:**
- Die viewer (device inspector) → Net graph (highlight same node) — 🔵 Low
- Выделение device в любом месте → подсветка везде — 🔵 Low
  (потребует zustand store для selectedAnalogDevice)

---

## Архитектурные риски

### 1. `collectDieWideAnalogDevices` — монолит (🟡)
Функция делает всё: extraction, wire matching, netlist gen. Вызывается при каждом WS тике.
**Решение:** Backend API если будут проблемы с производительностью на больших dies. Пока не критично.

### 2. Wire matching — эвристика (🔴 — в процессе)
10px distance-check → заменяем на intersection.
**Решение:** Сделать в ближайшее время.

### 3. Нет тестов (🟡)
Любое изменение в `dieWideAnalog.ts` или `spice.ts` может сломать всё.
**Решение:** Snapshot-тесты после стабилизации wire matching + SPICE.

### 4. Client-side only архитектура (🟢)
Всё в браузере. На средних dies работает. Если тормозит — вынести на backend.

### 5. React Router + WebSocket race (🟢)
При смене вкладок WebSocket закрывается с ошибкой. Не критично.
