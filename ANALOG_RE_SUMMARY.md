# ANALOG RE — Состояние на 2026-06-12

## Статус: BJT Netlist MVP ✅

Ветка `analog-re-wip` на `flxkrlv/mmo-chip-a`.

---

## ✅ Работает

### Wire-to-terminal snapping
- Снаппинг к **contact'ам** под metal1 (не к центру металла)
- Оранжевый гало при наведении
- Одна точка снаппинга на каждый contact (4 contact'а → 4 гало)

### Device highlighting на die viewer
- Цветные прямоугольники: Q-зелёный, M-синий, R-оранжевый, C-голубой, D-красный
- Имена устройств (Q1, M1, R1…) на тёмном фоне
- Терминал-лейблы (C/B/E) на реальных позициях contact'ов
- Чекбокс overlay в правой панели

### BJT Netlist (SPICE/CDL/Spectre)
- NPN и PNP детекция через marker-слои (npn_id/pnp_id)
- Terminal matching: **уникальные contact'ы + proximity 10px к wire-сегментам**
- Одна модель на тип транзистора (NPN_GEN / PNP_GEN)
- Q-нумерация сквозная (NPN+PNP делят префикс)
- B/E не закорачиваются (shared contacts excluded)
- C↔B диодное включение работает
- Межтранзисторные соединения работают (Q6.B=Q7.B через провод)
- -1 net не превращается в GND

---

## Архитектура matching (финальная)

```
Для каждого терминала:
  1. Найти все contact'ы, перекрывающиеся со слоем терминала
     (collector→C, base/bulk→B, emitter→E)
  2. Исключить shared contact'ы (принадлежащие >1 терминалу)
  3. Для каждого уникального contact'а:
     Проверить все wire-сегменты на расстояние ≤10px
     Нашли → терминал на этом нетлисте
     Не нашли → свежий уникальный net
```

---

## Ключевые файлы

| Файл | Что |
|------|-----|
| `frontend/src/api/dieWideAnalog.ts` | collectDieWideAnalogDevices, matchWireToPoint |
| `frontend/src/lib/extraction/terminalDetect.ts` | detectCellTypeTerminals (contact-based) |
| `frontend/src/lib/extraction/simpleAnalog.ts` | extractMarkedDevices (NPN/PNP/MOS/R/C/D) |
| `frontend/src/lib/export/spice.ts` | SPICE/CDL/Spectre генераторы |
| `frontend/src/components/dieViewer/AnalogDeviceHighlights.tsx` | Canvas overlay с Q1/M1/R1 |
| `frontend/src/components/dieViewer/useWireTool.ts` | Wire tool с terminal snapping |
| `frontend/src/components/dieViewer/snapHalo.ts` | Оранжевый terminal halo |
| `frontend/src/routes/DieViewerPage.tsx` | Интеграция snapping + overlay |

---

## Что дальше

1. MOS транзисторы (D/G/S/B) — аналогично BJT
2. Резисторы/конденсаторы/диоды
3. Device inspector при клике (код есть в DeviceInspector.tsx)
4. SPICE subcircuit для каждого cell type (иерархический нетлист)
5. Netlist visualization
