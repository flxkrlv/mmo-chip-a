# mmo-chip — analog-re-wip

> [**ENG**](README.md) | **RU**

**Форк [mmo-chip](https://github.com/giulioz/mmo-chip) для реверс-инжиниринга аналоговых и mixed-signal ИС.**  
Расширяет оригинальный цифровой CMOS-маршрут до **BJT, BiCMOS, резисторов, конденсаторов, диодов** — экстракция на уровне отдельных транзисторов с экспортом нетлиста SPICE/CDL/Spectre.

## Благодарности

Спасибо разработчикам оригинального [mmo-chip](https://github.com/giulioz/mmo-chip) — чистая архитектура и понятные интерфейсы сделали возможным это аналоговое расширение.

Оригинальный CMOS-маршрут (стандартные ячейки, логика, Verilog) **не тронут** — аналоговая экстракция работает как надстройка. 

## Быстрый старт

```sh
# Node ≥ 20
npm install
npm run dev               # бэкенд + фронтенд + ML sidecar
# По отдельности:
npm run dev -w backend    # http://localhost:3001
npm run dev -w frontend   # http://localhost:5173

# Тесты:
npm test
```

---

## Поддерживаемые устройства

| Устройство | Детекция | Параметры |
|-----------|----------|-----------|
| **NMOS / PMOS** | Well-based через Clipper2 (разрезание diffusion по poly gate). Маркеры не нужны | W, L, fingers, M. Bulk: контакт на well → netId; нет → VDD/GND |
| **NPN** | Маркер `npn_id` + collector/base/emitter | AE (overlap base∩emitter), M |
| **PNP / LPnp** | Маркер `pnp_id` | AE, PE (периметр эмиттера), M |
| **Диод** | Маркер `diode_id` **или** NPN/PNP без коллектора | Площадь (AE из base-emitter overlap) |
| **Резистор** | Геометрически: тело (poly/base/emitter/hsr/film) → ME1 → контакты → PLUS/MINUS. Маркер не нужен | Ω или squares × Rₛ. Слои: poly-R, p-base, n+, HSR, thin film |
| **Конденсатор** | Маркер `cap_id` (overlap-область) | fF = площадь × плотность (не тестировалось) |

---

## Как рисовать устройства

Все слои рисуются в **Cell RE** соответствующим инструментом (rect/polygon/polyline).

### MOS

| Слой | Назначение |
|------|------------|
| `nwell` / `pwell` | Карман — nwell→PMOS, pwell→NMOS |
| `diffusion` | Область истока + стока |
| `polysilicon` | Затвор(ы), пересекающие diffusion |

1. Нарисуйте карман → diffusion внутри → polysilicon поперёк diffusion  
2. **Bulk:** `cont` на кармане **вне** diffusion/poly. Нет контакта → VDD (PMOS) / GND (NMOS)  
3. **Multi-finger:** Clipper2 разрезает diffusion между затворами → N отдельных MOS  
4. **Metal-connected D/S:** сток/исток, соединённые ME1 (или ME2+via) внутри ячейки, получают общий netId  

> Подробнее: [`docs/mos_detection.md`](docs/mos_detection.md)

### BJT

| Слой | Назначение |
|------|------------|
| `npn_id` / `pnp_id` | Bounding box |
| `collector` / `base` / `emitter` | Области прибора |

1. Нарисуйте bounding box → слои внутри → `cont` на каждом слое (терминалы сопоставляются автоматически)  
2. **Multi-emitter:** несколько эмиттеров → суммирование AE, M = количество  
3. **PNP/LPnp:** PE = периметр эмиттера (основной параметр)

### Диод

**Рекомендуется:** NPN/PNP без коллектора → автоматический диод. Base = анод, emitter = катод.

### Резистор

| Слой | Назначение |
|------|------------|
| `poly` / `base` / `emitter` / `hsr` / `film` | Тело (выберите один) |
| `contact` | Контакты (мин. 2) |

1. Выберите **body-слой** → рисуйте **polyline-инструментом** (`L`) — ортогональный snap, ширина в тулбаре (0–200 µm)  
2. Нарисуйте ME1, перекрывающий тело → поставьте 2+ контакта (станут PLUS/MINUS)  
3. Клик на любом сегменте → выделяется вся цепочка → ширина в правой панели  
4. Opacity-слайдер помогает выровнять ширину по изображению  

> **Sheet R₀:** настраивается в GUI (poly=25, hsr=1500, pb=200, npl=5, film=500 Ω/□)

### Конденсатор

Нарисуйте `cap_id` (bbox) — PLUS/MINUS оба на `contact`. Не тестировалось.

---

## Metal Stack (настраиваемая многослойная металлизация)

Die viewer поддерживает 1–6 слоёв металла (ME1–ME6) с соответствующими via (VIA12–VIA56).

### Настройка

**Net Settings** (шестерёнка рядом с "Nets") → **Metal layers** (1–6). Сохраняется per-project, перезагрузка не нужна. По умолчанию: 6 металлов.

| Элемент UI | Адаптация |
|------------|-----------|
| Палетры цветов слоёв | Только настроенные металлы |
| Чипы Wire/Via в тулбаре | Только настроенные металлы/via |
| Hotkeys 1..6 / Alt+1..5 | В пределах стека |
| E/Q via up/down | Берёт правильный via из стека |
| W cycle | Только по настроенным металлам |
| ProblemNavigator | Проверяет dangling via по правильной паре |

### Цвета слоёв

Настраиваются в Net Settings / Via Settings. Сохраняются per-project.

### Via labels

При zoom ≥ 8× каждая via показывает тип (VIA12, VIA56…) по центру — чёрная подложка, белый жирный текст. Включение: **VIA LABEL** в правой панели.

---

## Возможности Die Viewer

### Wire Tool

- **Переключение слоёв:** `W` активирует; повторно — цикл по стеку (ME1→…→ME6→ME1)  
- **Via (E/Q):** ставит via на конце превью (по умолчанию). Переключалка **Via: cursor / wire-end** в тулбаре  
- **Cross-layer snap:** провода разных металлов соединяются только через via-аннотацию  
- **AutoVia (checkbox):** при клике на вершине соседнего металла via ставится автоматически  
- **Via tool (O):** включает режим via; повторно — цикл по типам (VIA12→VIA23→…)  
- Контакты устройств подключаются только к **ME1** — ME2+ требует via

### ProblemNavigator

Панель проблем (`IssuesChip`): connectivity (неподключённые терминалы), wiring (обрывки), vias (dangling по паре металлов), I/O pins, overlaps, electrical warnings.

> [`docs/problem-navigator.md`](docs/problem-navigator.md) (на англ.)

### Операции с ячейками

| Действие | Как |
|----------|-----|
| **Copy / Paste** | `Ctrl+C` / `Ctrl+V` или ПКМ |
| **Make Unique** | `Shift+U` или ПКМ — отвязать ячейку от типа, редактировать независимо |
| **Cell Relationship** | **CELL REL** в правой панели — подсветка всех ячеек того же типа |

### Device Registry

Каждое устройство получает стабильный UUID из `kind + позиция + subType`. Переименования и оверрайды параметров сохраняются при переизвлечении и между сессиями.

### Слои (Cell RE)

| Слой | Группа |
|------|--------|
| `diffusion` / `polysilicon` / `nwell` / `pwell` | MOS |
| `collector` / `base` / `emitter` | BJT |
| `hsr` / `film` | Резисторы |
| `npn_id` / `pnp_id` / `res_id` / `cap_id` | Маркеры |
| `metal1`–`metal6` | Металлизация |
| `via1`–`via5` | Via-слои |
| `contact` | Контакты |

### Скриншот

`Ctrl+Shift+S` — экспорт текущего вида в PNG (4K, композит всех overlay-слоёв включая analog device highlights). Кнопка скачивания в SubBar.

### Поиск

`Ctrl+F` — фильтрация Outline Tree по имени net/cell. Enter фокусирует первое совпадение на canvas. Esc закрывает. Иконка поиска в заголовке "Items".

### Прочее

- **Net ID overlay:** имена нетов на die viewer (вкл. в боковой панели). VDD/GND скрыты  
- **Комментарии на топологии:** иконки с текстом, автором, ответами (WebSocket)
- **Панель горячих клавиш:** `Ctrl+/` — модальное окно со всеми шорткатами. Кнопка `?` в TopBar

---

## CV-детекция ячеек

Инструменты компьютерного зрения для автоматического обнаружения экземпляров ячеек. Доступны в правой панели (вкладка CV).

| Метод | Статус | Описание |
|-------|--------|----------|
| **Template matching** | Стабильный | Sobel-шаблонное сопоставление с референсным кропом. Основной рабочий метод детекции. |
| **AKAZE verify** | Опционально | Попарное сравнение найденных ячеек через AKAZE-кейпоинты. Ячейки ниже порога схожести удаляются. Фильтрация ложных срабатываний после template matching. |
| **Contour detection** | Экспериментальный | Детекция на основе контурных деревьев. Пока не работает стабильно. |

---

## Schematic Viewer

Принципиальные схемы уровня транзисторов из SPICE-нетлиста с **интерактивным канвасом** (движок по умолчанию).

- **Интерактив (по умолчанию)** — перетаскивание устройств, фиксация позиций (сохраняется), мультивыбор, поворот/зеркалирование символов, undo/redo
- **Иерархия** — floorplan-регионы как свернутые блоки с подписями портов; двойной клик / ПКМ по блоку — открыть его схему. Вкладки регионов (All, bandgap, …)
- **I/O pins** — пины и нетсы уровня кристалла
- ELK-раскладка (strategy/direction/compaction + настройка зазоров/рёбер в Netlist Settings), zoom колесом с Ctrl, тултипы имён нетов на проводах
- Экспорт: PNG, SVG (чёрно-белая)
- **Legacy static рендер** (netlist2svg, опционально): тумблер Static/Interactive, функциональная блок-диаграмма, кнопки pan/zoom, скачивание SVG/PNG/JSON

---

## LVS (Layout vs Schematic)

Сравнение извлечённого нетлиста из mmo-chip-a с нарисованной вручную схемой в стороннем САПР.

| Режим | Когда |
|-------|-------|
| **name-based** | Только если имена устройств совпадают (Q1, M2, R5…) |
| **vyges-lvs** | Name-independent сравнение топологии (netgen-подобный). |

Доступно на вкладке Analog Netlist (`Alt+4`).

---

## Floorplan Regions

Прямоугольные/полигональные регионы для разметки аналоговых блоков. Цвет, имя, алиасы портов, резервация, глобальное переименование нетов, port dots.

| Клавиша | Действие |
|---------|----------|
| `H` | Активировать инструмент |
| `Ctrl+Shift+H` | Показать/скрыть overlay |

---

## Экспорт / Импорт проекта

```http
POST /api/dies/:dieId/export-project    # JSON: light (только аннотации) / full (+ изображения)
POST /api/dies/import-project           # Обработка конфликтов (перезапись/пропуск)
POST /api/dies/:dieId/rename            # Переименование кристалла
```

Full-экспорт сохраняет оригинал + overlay-изображения. Preferences экспортируются из localStorage.

---

## Горячие клавиши

| Клавиша | Действие |
|---------|----------|
| `S` | Select |
| `W` | Wire tool (повторно → цикл слоя металла) |
| `E` | Via up (на конце превью, переключение на след. металл) |
| `Q` | Via down (на конце превью, переключение на пред. металл) |
| `B` | Multi-wire / Bus |
| `O` | Via tool (повторно → цикл типа via) |
| `K` | Линейка: рисовать несколько рулеток |
| `Shift+K` | Удалить все рулетки |
| `Delete` | Удалить выбранные рулетки |
| ПКМ по рулетке | `Delete ruler` или `Set scale from ruler`; double-click сохраняет shortcut Set Scale |
| `R` | Add Cell |
| `P` | I/O Point |
| `F` | Fit to Screen / Pan |
| `H` | Floorplan tool |
| `+` / `=` | Zoom in |
| `-` | Zoom out |
| `1` … `6` | Выбрать металл ME1 … ME6 |
| `Alt+1` … `Alt+5` | Выбрать via VIA12 … VIA56 |
| `Shift+1` … `Shift+5` | Навигация по вкладкам: Die / Merge / RE Cell / Code / Analog Netlist |
| `Ctrl+Z` / `⌘Z` | Undo |
| `Ctrl+Shift+Z` / `⌘⇧Z` | Redo |
| `Ctrl+C` / `⌘C` | Копировать ячейку / фигуру |
| `Ctrl+V` / `⌘V` | Вставить |
| `Shift+U` | Make Unique (ячейка) |
| `Ctrl+Shift+S` | Скриншот (PNG, 4K) |
| `Ctrl+F` | Поиск net / cell |
| `Ctrl+/` | Панель горячих клавиш |
| Пробел (hold) | Временный pan |

### Ruler tool

Нажмите `K` и проведите линию по кристаллу. По умолчанию измерение строится ортогонально. Можно создать несколько рулеток: `S` выбирает рулетку, `Shift+click` выбирает несколько, а клик по пустому месту снимает выделение. `Delete` удаляет выбранные рулетки, `Shift+K` — все рулетки.

Масштаб задаётся через double-click или ПКМ → **Set scale from ruler**. После задания масштаба длина отображается в µm, а значения меньше 1 µm — в nm. При zoom меньше 20% неактивные рулетки скрываются, текущая и выбранная остаются видимыми.

### Cell RE

| Клавиша | Инструмент |
|---------|------------|
| `R` | Rect |
| `P` | Polygon |
| `O` | Point / via |
| `L` | Polyline (резистор) |

### Overlay-изображения

| Клавиша | Действие |
|---------|----------|
| `Ctrl+Shift+B` | Показать/скрыть базовое изображение |
| `]` / `[` | Следующий / предыдущий overlay-слой (только его) |
| `Ctrl+Shift+1..8` | Показать только слой N |

Настройки overlay-слоёв (видимость, прозрачность, сдвиг) сохраняются per-die в localStorage. **Upload to Server** сохраняет изображения на сервер для автоматической загрузки.

### Analog Netlist

| Клавиша | Действие |
|---------|----------|
| `G` | Code / Graph |
| `H` | Hierarchical on/off |
| `R` | Формат резистора (Ω / sq·Rs) |
| `M` | Device matching on/off |

### Merge Cells

| Клавиша | Режим |
|---------|-------|
| `Alt+1`…`5` | Overlay / Side-by-side / Diff / Specimen / Candidate |

---

## Что ещё не сделано

- **DMOS, диод Шоттки, VPNP, JFET** — нет детекции или маркеров  
- **Wire matching** — допуск = размер контакта × 0.5; возможны ложные срабатывания  
- **Редактирование polyline** после размещения (только перерисовать)  
- **Hierarchical netlist / floorplan** — интерактивный viewer поддерживает; alias collision и скорость rename требуют реального тестирования

---

## ⚠️ Предупреждение

**Всё ещё альфа / WIP.** Только unit-тесты extraction (22 теста: 18 pass, 4 skip). Нет e2e, нет тестов overlay, wire matching, SPICE, cross-tab навигации.

---

## Структура репозитория

```
frontend/     Vite + React + TypeScript — die viewer, cell RE, analog netlist
backend/      Node + TypeScript API — import, tiling, JSON persistence, WebSocket
shared/       Shared TypeScript types
ml/           Python U-Net (опционально)
docs/
  analog-devices.md           ← документация детекции аналоговых приборов
  mos_detection.md            ← MOS pipeline (Clipper2, poly gate, metal merge)
  netlist_warnings.md         ← SPICE/CDL warnings
  problem-navigator.md        ← ProblemNavigator (на англ.)
  lvs-plan.md                 ← LVS архитектура
```

Ключевые файлы экстракции: `dieWideAnalog.ts`, `simpleAnalog.ts`, `spice.ts` (`frontend/src/`).
