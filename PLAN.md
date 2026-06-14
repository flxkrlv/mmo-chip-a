# Plan — mmo-chip mixed-signal RE

Этот план заменяет `ANALOG_PLAN.md` (оригинальный roadmap от 2026-06-13) и `PLAN.md`.
Сопоставляет исходные R1-R8 с реальным прогрессом и актуальными приоритетами.

---

## Оригинальный план (R1-R8) × Прогресс

| Блок | Статус | Что сделано |
|------|--------|-------------|
| **R1 — Data model** | ✅ Done | Layer types, DeviceKind, DeviceGeometry\*, AnalogDevice, SpiceConfig |
| **R2 — Detection** | 🟡 60% | `extractMarkedDevices` (marker-based), wire matching. Чисто-геометрической детекции (BJT/R/C/D из слоёв) нет — решили что marker-based проще и надёжнее |
| **R3 — SPICE export** | ✅ Done | CDL/Spectre/HSPICE generators, wire matching, named nets |
| **R4 — Frontend** | 🟡 80% | Analog layers, device inspector, analog symbols, **Net Graph (сегодня)**. Schematic render — отложили (сложно, пользы мало) |
| **R5 — Backend** | ❌ Not started | Export API, SpiceConfig persistence, celery pipeline |
| **R6 — Testing** | ❌ Not started | Ни одного теста |
| **R7 — ML** | ❌ Phase 1+ | Не актуально |
| **R8 — Overlay images** | ✅ MVP | Static PNG/JPEG upload, opacity, server preload |

---

## Реализовано (2026-06-14)

**Аналоговый пайплайн** (всего за 3 дня):
1. Data model (DeviceKind, geometry types, SpiceConfig)
2. Device detection (marker-based: `extractMarkedDevices`)
3. Die-wide collection + wire matching (`collectDieWideAnalogDevices`)
4. SPICE/CDL/Spectre export (`spice.ts`)
5. Analog Netlist tab (CDL viewer + net graph)
6. Device Inspector + overlay highlights
7. Cross-tab navigation (все вкладки связаны)
8. Multi-layer image overlays + ruler tool
9. LPnp слой для PNP детекции
10. Per-net colors + IO pin snapping

---

## 🔴 Топ-5 задач сейчас (актуальные)

### 1. Wire matching — надёжность
**Проблема:** `matchWireToPoint` ищет провод в 10px от контакта. Если провод дальше — terminal остаётся unconnected (fallback netId < 0). Для реальной RE нужно точное intersection-based сопоставление.
**Что делать:** Заменить distance-check на segment-rectangle intersection (уже есть `segmentIntersectsRect` в `dieWideAnalog.ts`). Сейчас matchWireToPoint ищет точку, а нужно проверять пересечение отрезка провода с bounding box терминала.
**Приоритет:** 🔴 **Critical** — без этого часть устройств в графе и CDL висят «в воздухе».

### 2. Backend API для SPICE export
**Проблема:** Всё на клиенте — `collectDieWideAnalogDevices` пересчитывается при каждом WS тике.
**Что делать:** 
- `POST /api/dies/:dieId/export/analog?format=cdl` — генерация на сервере
- `GET /api/dies/:dieId/devices` — кэшированный список устройств
- Сохранение SpiceConfig (sheetR, capDensity, model cards)
**Приоритет:** 🔴 **Critical** — производительность на больших dies.

### 3. Cell type device review — ручная верификация
**Проблема:** `extractMarkedDevices` находит устройства по маркерным слоям. Если маркер неверный — устройство не найдено. Нужен UI для просмотра/редактирования списка устройств внутри каждого cell type.
**Что делать:** 
- Секция "Analog devices" в Cell RE left panel
- Список найденных устройств с возможностью удалить/добавить
- Выбор DeviceKind из выпадающего списка
- Редактирование параметров (W/L/AE/squares)
**Приоритет:** 🟡 **High** — без этого нет обратной связи о качестве extraction.

### 4. Net Graph — стабильность и UX
**Проблемы текущие:**
- Force layout пересчитывается при каждом WS тике (прыгают ноды)
- Нет сохранения позиций
- Не все IO pins соединяются (требуют точного wire matching — см. п.1)
**Что делать:**
- Debounce на annotations перед перестроением графа (300ms)
- Сохранять user-dragged позиции нод (при перетаскивании ноды → фиксировать)
- Синхронизация с die viewer (клик на device в графе → подсветка на die)
**Приоритет:** 🟡 **High** — граф уже полезен, надо довести до ума.

### 5. CDL → die viewer двусторонняя синхронизация
**Проблема:** Выделение device в CDL preview на die viewer и в Netlist tab — независимые стейты.
**Что делать:** Вынести `selectedAnalogDevice` в shared state (zustand), подписать все три вьюхи:
- Die viewer (overlay + inspector)
- Netlist tab (CDL строка)
- Net graph (нода)
Клик в любом месте → подсветка везде.
**Приоритет:** 🟡 **High** — завершает идею cross-tab navigation.

---

## Когда будет сделано (следующие)

| Задача | Когда | Зависит от |
|--------|-------|-----------|
| **MOS 4-pin extraction** (bulk terminal) | После п.1 | Wire matching |
| **Конденсаторы/диоды** (extraction) | После п.3 | Cell type review |
| **Hierarchical netlist** (.SUBCKT) | После п.2 | Backend API |
| **Schematic render в RE Cell** | Отложено | Нужен use-case >1 device/cell |
| **Multi-layer image tiling** | Когда >300MB сканы | — |
| **VPNP vertical PNP** | Низкий | Нет данных |
| **Тесты** | После стабилизации API | П.1 + П.2 |
| **Cadence SKILL export** | После п.2 | Backend API |

---

## ⚠️ Архитектурные риски

### 1. `collectDieWideAnalogDevices` — монолит (🔴)
Функция делает всё: extraction, wire matching, netlist gen. Вызывается:
- Die viewer (каждый WS тик → overlay)
- Netlist tab (каждый WS тик → CDL + граф)
- CDL preview (по кнопке Scan)

**Решение:** Backend API с кэшированием результата. Клиент только читает.

### 2. Wire matching — эвристика (🔴)
10px tolerance когда-нибудь не сработает. Зависит от:
- Разрешения скана (um/px)
- Формы контактов
- Количества metal слоёв

**Решение:** Segment-rect intersection (уже есть код — `segmentIntersectsRect`). Сделать в ближайшее время.

### 3. Нет тестов (🟡)
Любое изменение в `dieWideAnalog.ts` или `spice.ts` может сломать:
- CDL генерацию
- Device extraction
- Wire matching  
- Net graph
- Die viewer overlay

**Решение:** Хотя бы snapshot-тесты на известные die конфигурации.

### 4. Client-side only архитектура (🟡)
Всё в браузере:
- Большие dies → тормоза при extraction
- Нет сохранения SpiceConfig между сессиями
- Нет серверной валидации

**Решение:** Перенос вычислительных задач на backend.

### 5. React Router + WebSocket race (🟢)
При смене вкладок WebSocket закрывается с ошибкой. Не критично, но консоль замусорена.

---

## Краткий итог

**Сделано за 3 дня:** полный пайплайн от распознавания аналоговых устройств до CDL и графа.

**Главное «узкое место» сейчас:** wire matching. Если соединения неправильные — всё остальное (CDL, граф, overlay) показывает неверную картину. Это первое, что надо фиксить.

**Backend API — второй приоритет.** Без него `collectDieWideAnalogDevices` будет дёргаться на каждый WS тик и на больших dies станет неюзабельно.
