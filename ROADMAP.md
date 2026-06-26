# ROADMAP — mmo-chip analog-re-wip

**Честная оценка.** Тэг `v0.4-alpha-test`, ветка `analog-re-wip`, 2026-06-26.

---

## Disclaimer

Проект **сырой**. Многое сделано, но почти нигде нет глубины.
Ниже — что реально работает, а что только притворяется.

---

## I. ЧТО РЕАЛЬНО РАБОТАЕТ

### 🔬 Аналоговая экстракция

| Компонент | Оценка | Комментарий |
|-----------|--------|-------------|
| MOS (well-based) | 🟡 Работает | W/L, fingers, multiplier — считаются. На реальных чипах не проверялось. |
| Multi-finger MOS (Clipper2) | 🟡 Работает | Diffusion режется — корректность разрезки не валидирована. |
| BJT (NPN/PNP) | 🟡 Работает | Маркерная детекция. AE считаем. Dual-emitter — да. |
| LPnp | 🟡 Работает | Периметр эмиттера. |
| Diode (marker + BJT-as-diode) | 🟡 Работает | |
| Resistor (geo + polyline) | 🟡 Работает | Ортогональный snap, body-типы, SheetR. |
| Capacitor | 🟡 Работает | Маркер `cap_id`. fF/µm² по умолчанию — не проверено. |

### 🔗 Wire matching

| Компонент | Оценка |
|-----------|--------|
| Contact-size-proportional tolerance | ✅ |
| ME1-only device contacts | ✅ |
| Via insertion (E/Q) | ✅ |
| Terminal snap halo (layer-filtered) | ✅ |
| Wire layer palette (m1/m2) | ✅ |

### ⌨️ Hotkeys

| Компонент | Оценка |
|-----------|--------|
| W (wire+M1/M1↔M2) | ✅ |
| E/Q (via up/down) | ✅ |
| G/H/R/M, L, K, Alt+1..5 | ✅ |
| Overlay (Ctrl+Shift+B/[]/1..8) | ✅ |

### 🖥️ UI

| Компонент | Оценка | Комментарий |
|-----------|--------|-------------|
| Analog overlays | 🟡 Работает | Bbox, терминалы, параметры. При зуме прячутся — ок. |
| Device Inspector | ✅ | Клик → правая панель. |
| DeviceInstancePanel | ✅ | Список + подсветка. |
| Net Graph (D2D+N2N) | 🟡 Работает | Cytoscape.js. На больших схемах не тестировалось. |
| Analog Netlist tab | ✅ | CDL/Spectre/HSPICE. |
| Ruler + umPerPx | ✅ | |
| Overlay layers | ✅ | Загрузка PNG/JPEG/GIF/WebP. |
| Comments | ✅ | Маркеры, поповер, ответы. |

### 🏗️ Floorplan

| Компонент | Оценка |
|-----------|--------|
| Rect/poly regions | ✅ |
| Hierarchical netlist (SUBCKT) | ✅ |
| Port dots, alias, rename | ✅ |
| Collision detection | ✅ |

### 👥 Auth + Online

| Компонент | Оценка |
|-----------|--------|
| Backend: register/login/verify | ✅ |
| JWT middleware | ✅ |
| WS auth | ✅ |
| OnlineUsersPanel | ✅ |
| AuthGate + LoginPage | ✅ |
| Bearer token in API | ✅ |

---

## II. ЧТО НЕ РАБОТАЕТ / СЛОМАНО

### 🔴 Критические проблемы

| # | Проблема | Детали |
|---|----------|--------|
| **1** | **Тесты аналоговой экстракции — сломаны** | `backend/src/analog-extraction.test.ts` импортирует `analogDevices.js`, который **удалён** (b8568d9). `detectAnalogDevices`, `computeMOSParams`, `computeBJTParams`, `computeResistorParams`, `computeCapacitorParams`, `computeDiodeParams`, `bodyCenterline`, `bodyCenterlineLength` — все функции из удалённого файла. Тест даже не загружается: `ERR_MODULE_NOT_FOUND`. |
| **2** | **Нет золотых тестовых данных** | В `testdata/` лежит 1 (один) файл: `analog/resistor_straight/expected.json`. План (R6) предполагал 10+ наборов (BJT, fingered MOS, diff_pair, current_mirror, MIM cap, opamp…). Реализовано 0. |
| **3** | **ML-модуль не адаптирован** | `ml/` — 9 Python-файлов (327 строк sidecar, U-Net модель, датасет, предикт, тренировка). **Ничего не проверено.** Неизвестно: загружается ли модель, работает ли inference, какие чекпоинты нужны. Репозиторий не содержит `checkpoints/model.pt`. Интеграция Node → Python sidecar не тестировалась. |
| **4** | **VPNP (vertical PNP) — заглушка** | Тип `vpnp` есть в `LayerType` (shared/types.ts), но **не детектится**, не экстрагируется, не тестируется. Просто мёртвый код. |
| **5** | **Polyline preview — баг** | Preview не рисует closing segment + body fill. Мешает UX, но не влияет на корректность детекции. |
| **6** | **Resistor: нет скелетонизации** | План (R2/R4) предполагал Zhang-Suen thinning для вычисления L/W меандровых резисторов. Сейчас L/W считается грубо (bbox/sum segments). Корректность на serpentine/meander формах не гарантирована. |

### 🟡 Серьёзные пробелы

| # | Проблема | Детали |
|---|----------|--------|
| 7 | **JFET не поддерживается** | Нет маркера, нет детекции, нет SPICE формата. |
| 8 | **DMOS/LDMOS не поддерживается** | Double-diffused MOS (power devices) — нет. |
| 9 | **SCR/Thyristor, IGBT** | Нет. |
| 10 | **Metal3+** | Слои в типах есть, но wire layer palette — только m1/m2, via E/Q циклит по m1/m2. ME3–ME6 — мёртвый код. |
| 11 | **Capacitor: fF/µm² не калиброван** | По умолчанию 1 fF/µm². Реальная плотность зависит от технологии. |
| 12 | **Нет Device Matching детекции** | Common-centroid, interdigitated — не реализовано (R2 helper `detectMatching`). |
| 13 | **Нет SPICE .MODEL библиотеки** | Модели hardcoded. Нет GUI для управления моделями. |
| 14 | **Нет .MEASURE / .OPTIONS / .TEMP** | SPICE-шапка минимальная. |

### ⚪ Слабые места

| # | Проблема | Детали |
|---|----------|--------|
| 15 | **Нет CI/CD** | Нет GitHub Actions, нет автоматического прогона тестов. |
| 16 | **Нет production сборки** | `npm run build` не настроен. Только dev-режим (Vite + tsx). |
| 17 | **Нет Docker** | Для веб-деплоя. |
| 18 | **Нет OAuth** | Только local JWT auth. |
| 19 | **Hotkeys только English раскладка** | Принято, но ограничивает. |
| 20 | **Clipper2 WASM в headless не работает** | Тесты не запустить без браузера. |

---

## III. Реальное покрытие

| Область | Что есть | Чего нет | Реальная готовность |
|---------|----------|----------|---------------------|
| **Analog device types** | MOS, BJT, LPnp, Diode, R, C | JFET, DMOS, SCR, IGBT, Varactor, Zener, Schottky | ~40% |
| **Wire matching** | Всё заявленное | — | ~95% |
| **Hotkeys** | Все заявленные | — | ~95% |
| **UI** | Почти всё | Schematic view (аналоговые символы) | ~70% |
| **Floorplan** | A1–A5, B1–B7 | — | ~95% |
| **Auth + Online** | Всё | — | ~95% |
| **Comments** | Всё | — | ~95% |
| **Тесты** | 1 файл, сломан | Unit, integration, golden data | **0%** |
| **ML модуль** | 9 .py файлов | Не проверен, нет чекпоинта, нет интеграции | **0%** |
| **Экспорт** | SPICE, CSV, SKILL | Валидация вывода (симулируется ли?) | ~50% |
| **DevOps** | — | CI/CD, Docker, build, HTTPS | **0%** |

---

## IV. ПРИОРИТЕТЫ (реальные, не optimistic)

### 🔴 P0 —必须先修复

1. **Починить тесты** — `analog-extraction.test.ts` не грузится. Нужно либо восстановить `analogDevices.ts`, либо переписать тесты под `simpleAnalog.ts` + `dieWideAnalog.ts`. 
2. **ML модуль: проверить, работает ли** — запустить sidecar, проверить загрузку модели, протестировать inference хоть на чём-то. Или принять решение, что ML не нужен, и выпилить.
3. **VPNP: или реализовать, или выпилить** — мёртвый код в типах вводит в заблуждение.

### 🟠 P1 — Ключевые пробелы

4. **DMOS/LDMOS** — power устройства. Если проект про BiCMOS/аналог — DMOS обязателен.
5. **JFET** — был в планах, не реализован.
6. **Metal3+** — расширить wire layer palette + via E/Q.
7. **Золотые тестовые данные** — хотя бы 3-5 наборов (BJT, fingered MOS, diff pair, meander R).

### 🟡 P2 — Глубина

8. **Скелетонизация резисторов** — Zhang-Suen или альтернатива для точного L/W.
9. **Device matching детекция** — common-centroid, interdigitated.
10. **SPICE .MODEL менеджмент** — GUI для моделей + библиотека.
11. **Capacitor калибровка** — реальные fF/µm².
12. **Polyline preview fix** — closing segment + body fill.
13. **Die chat** (Phase 2.3) — WS чат.

### ⚪ P3 — Инфраструктура

14. **CI/CD** — GitHub Actions + tsc + test.
15. **Production build** — `npm run build`.
16. **Docker + Caddy** — для веб-деплоя.

---

## V. Что мы не обсуждали (новые направления)

| Направление | Зачем | Сложность |
|-------------|-------|-----------|
| **Schematic view** | Из SPICE-нетлиста рисовать аналоговые символы (MOS, BJT, R, C) вместо списка | Высокая |
| **Parametric sweep SPICE** | Запускать `.DC`/`.AC` прямо из браузера | Очень высокая |
| **Layout vs Schematic (LVS)** | Сравнивать экстрагированный нетлист с reference | Очень высокая |
| **SKILL импорт в Cadence** | CI/CV — автоматическая загрузка устройств | Средняя |
| **Color-based layer detection** | По цвету пикселя определять слой (SEM/микроскопия) | Средняя |
| **Device auto-classification (ML)** | Если ML заработает — детекция без ручной разметки | Высокая |

---

**Итог:** проект — рабочий прототип с широким, но неглубоким покрытием.
Основная аналоговая экстракция работает, но **не тестирована, не валидирована на реальных чипах, ML мёртв, DMOS/JFET отсутствуют, тесты сломаны.**

Следующие шаги решать тебе — что фиксить в первую очередь.
