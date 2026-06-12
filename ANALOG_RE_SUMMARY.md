# ANALOG RE — План и состояние 2026-06-12

## ✅ Работает стабильно

| Компонент | Статус |
|-----------|--------|
| **BJT нетлист** (NPN/PNP, C/B/E, M=N, diode-connected, без B/E shorts) | ✅ |
| **Wire-to-terminal snapping** (contact-based, оранжевый гало) | ✅ |
| **Device overlay** (Q/R/M/C/D цветные боксы, toggle, terminal labels) | ✅ |
| **Dual-emitter BJT** (M=2, M=6, AREA per-finger) | ✅ |
| **Polyline tool** (рисование, 90° орто, Enter, ширина в тулбаре) | ✅ |
| **Wire matching** (уник. контакты + proximity 10px) | ✅ |
| **SPICE/CDL export** (правильные model cards) | ✅ |

## ⚠️ Частично / с багами

| Компонент | Проблема |
|-----------|----------|
| Device Inspector | Код есть (DeviceInspector.tsx), не подключён — был render-loop при интеграции |
| AnalogDiePanel | Сломанные импорты `detectAnalogDevices`/`shapeToPolygon` — latent bug, не триггерит без die-level слоёв |
| Resistor терминал-лейблы | Оба помечены одинаково на overlay (визуальный баг) |

## ❌ Ещё нет

MOS транзисторы, конденсаторы, диоды, иерархические subcircuit'ы, netlist visualization, переименование клеток (UUID→Q1)

---

## Архитектурные проблемы

1. **Дублирование логики**: `terminalDetect.ts` (снаппинг) и `dieWideAnalog.ts` (wire matching) делают похожие вещи разными способами
2. **dieWideAnalog.ts разбухает** (геометрия + matching + экстракция в одном файле)
3. **Нет связи device↔cell instance** — устройства вычисляются отдельно от клеток, нет обратной ссылки

---

## Приоритеты

### 🔴 Критические — без них маршрут восстановления невозможен

1. **Стабилизация polyline tool** — основной способ рисовать резисторы. Ширина через store, меньше багов
2. **MOS транзисторы** — 4-терминальные (D/G/S/B). Marker `mos_id` + слои `drain/gate/source/bulk` уже есть. Нужен wire matching + SPICE
3. **Resistor завершение** — подсчёт углов в полилинии, правильная формула squares, терминал-лейблы

### 🟡 Второстепенные — доставляют неудобства

4. **Переименование клеток** (UUID → Q1/R1/M1) в левой панели
5. **Device Inspector** (клик на устройстве → параметры W/L/AE)
6. **Чистка кода** — убрать дебаг, починить AnalogDiePanel, вынести геометрию

### 🔵 Полезные фичи — на потом

7. Иерархические нетлисты (subcircuit на cell type)
8. Netlist visualization  
9. Конденсаторы / диоды
10. Авто-определение типа контакта (p_base NOT emit)

---

## Следующий шаг

**Polyline stabilisation → MOS → Resistor corners**
Затем: cell naming + Device Inspector.
