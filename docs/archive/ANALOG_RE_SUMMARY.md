# ANALOG RE — 2026-06-13

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
│ Standard cells │ NPN, LPNP, MOS, R, C, D  │
│ Gate-level     │ Transistor-level        │
│ Verilog        │ SPICE/CDL/Spectre       │
└────────────────┴────────────────────────┘
```

**Оригинальный CMOS маршрут НЕ тронут.**
Стандартные ячейки работают как раньше. Аналоговая экстракция — надстройка.

---

## 2026-06-13 — Реализовано

### Overlay Layers (слои изображений)
- Backend: `/api/overlay-images/*` — list, serve, upload
- `OverlayImageLayer` — рендер статичных PNG/JPEG/GIF/WebP в tiled canvas
- OutlineTree: секция "Overlay Layers", Add from File, Load from Server
- Авто-загрузка изображений из `data/overlay-images/` при старте (скрыты по умолчанию)
- Подсказка пути в UI

### Ruler / Measurement Tool
- Клавиша `k`, иконка 📏
- Режимы: free, horizontal, vertical, orthogonal, diagonal (45°)
- Жёлтая пунктирная линия с подписью в пикселях + микронах
- Double-click → prompt "введи размер в µm" → `umPerPx` сохраняется в аннотации
- `DieAnnotations.umPerPx` — масштаб µm/px

### Hotkey System
- `frontend/src/lib/hotkeys.ts` — центральный registry
- Die Viewer: s=select, w=wire, b=bus, o=via, k=ruler, r=cell, p=pin, f=fit, +/-=zoom
- Cell RE: r=rect, p=polygon, o=point/via

### Per-Net Colors
- `netColors: Record<string, string>` в preferences (persists)
- OutlineTree: кликабельный swatch + палитра (VDD red, GND blue, VSS green...)
- `buildNetAnnotation` принимает `(netId) => color` — оверрайд на отрисовке

### IO Pin Snapping + Netlist Alignment
- `findNearestTerminal` теперь включает IO pins via `matchWireToPoint`
- `collectDieWideAnalogDevices` возвращает `{ devices, namedNets }`
- Netlist (.SUBCDK) использует имена аннотационных проводов + pin names как порты

### LPnp + vpnp слои
- `lpnp_id`, `vpnp` добавлены в LayerType, colors, toolbar, labels
- LPnp: AE = площадь эмиттера, PE = периметр эмиттера (collector inner edge)
- PNP в GUI показывает PE вместо AE
- vpnp — заглушка (не детектится)

### Исправления
- Resistor wire matching: round-robin contact distribution (фикс короткого замыкания) 
- Cell RE теперь использует `extractMarkedDevices` вместо `detectAnalogDevices` (маркерная детекция вместо Clipper-based)
- umPerPx прокидывается от аннотаций через collect → экспорт
- NPN/PNP kind правильные (было pnp вместо npn)

---

## ❌ Очередь

| Задача | Приоритет |
|--------|-----------|
| **Multi-layer image tiling** (производительность >300MB) | 🟡 Medium |
| **MOS аналоговые транзисторы** (4-pin) | 🔴 Critical |
| Конденсаторы / диоды | 🟡 |
| Клик на оверлей для инспектора | 🟡 |
| Иерархический нетлист (.SUBCKT) | 🔵 |
| Netlist visualization | 🔵 |
| VPNP vertical PNP (vpnp слой) | 🟡 |

---

## Multi-Layer Images — Архитектурное решение

### Текущая реализация (MVP)
`OverlayImageLayer` — рендер статичных full-size изображений с клиппингом.
Приемлемо для аналоговых БИС (сканы обычно ≤300 MB).

### План на tile-сервер
Когда появятся гигапиксельные сканы или 5+ слоёв:
- N отдельных Image-сущностей, каждая со своей mipmap-пирамидой
- `/api/images/import`, `/api/images/:id/tiles/:z/:x/:y`
- `DieImageLayer` для каждой (переиспользовать существующий tile renderer)
