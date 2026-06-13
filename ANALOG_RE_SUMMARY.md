# ANALOG RE — 2026-06-12

## Архитектура: Mixed-Signal

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
│ Standard cells │ NPN, PNP, MOS, R, C, D  │
│ Gate-level     │ Transistor-level        │
│ Verilog        │ SPICE/CDL/Spectre       │
└────────────────┴────────────────────────┘
```

**Оригинальный CMOS маршрут НЕ тронут.**  
Файлы `cell.ts`, `gates.ts`, `logic.ts`, `verilog.ts` — без изменений.  
Стандартные ячейки работают как раньше. Аналоговая экстракция — надстройка.

## Multi-Layer Images

### Минимальный вариант (планируется)
- Пользователь выравнивает и обрезает все слои в Inkscape (одинаковый crop)
- Экспортирует каждый слой (metal1.jpg, metal2.jpg, via.jpg…)
- Импортирует в mmo-chip под один die ID
- В OutlineTree: переключение слоёв (visibility + opacity на каждый)
- Рендеринг: стек `DieImageLayer[]` — рисуются один поверх другого
- Offset = 0 (изображения совмещены заранее)

### Продвинутый вариант (на потом)
- Смещение слоёв силами mmo-chip (offset x/y на слой)
- GUI для подгонки offset в реальном времени

### Оценка сложности
| Компонент | Сложность |
|-----------|-----------|
| Data model (images[] на die) | Мало |
| Backend multi-import | Средне |
| UI (переключение слоёв) | Средне |
| Rendering (стек слоёв) | Мало |

**Итого: 2-3 дня на минимальный вариант.**

## ✅ Реализовано

- BJT netlist (NPN/PNP, C/B/E, M=N, diode-connected, без B/E shorts)
- Wire-to-terminal snapping (contact-based, оранжевый гало)
- Device overlay (цветные боксы, terminal labels, toggle)
- Resistor extraction (polyline, SQUARES, width editing)
- Polyline tool (90° орто, Enter, W input)
- Outline tree naming (UUID → Q1/Q2/R1)
- Device Inspector (двойной клик в дереве)
- SPICE model cards (NPN_GEN / PNP_GEN)

## ❌ Очередь

| Задача | Приоритет |
|--------|-----------|
| **Multi-layer images** (✅ MVP готов: статичные overlay-слои) | 🟢 Done |
| **MOS аналоговые транзисторы** (4-pin) | 🔴 Critical |
| Конденсаторы / диоды | 🟡 |
| Клик на оверлей для инспектора | 🟡 |
| Иерархический нетлист (.SUBCKT) | 🔵 |
| Netlist visualization | 🔵 |
