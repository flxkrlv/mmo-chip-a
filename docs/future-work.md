# Future work — copy/paste + make-unique

Это план, не реализация. Сейчас сделан только stable device identity (UUID +
registry), см. `docs/analog-fixes-2026-07-08.md`.

## Контекст

В текущем pipeline устройство идентифицируется через UUID, выданный при
первом обнаружении (`deviceRegistry.matchOrCreateDevice`). UUID стабилен
через мелкие правки внутренних слоёв (tolerance 5px) и через переэкстракцию.

Cell instance идентифицируется через `cellTypeId`. Несколько Cell instances,
ссылающихся на один cellType, разделяют все слои и override'ы. Это by-design
для merge-cells workflow, но создаёт пробелы:

1. **Нельзя скопировать один девайс на die** без полного клонирования
   cellType. Сейчас путь такой: "copy cell type → merge cells → place" — три
   действия.
2. **Нельзя отвязать один девайс от группы** — override либо применяется ко
   всем экземплярам, либо ни к одному. Правка слоя в cell RE влияет на все.

## Feature A: Copy/Paste devices в Die Viewer

### User story

> Выделить один или несколько девайсов в die viewer → Ctrl+C → перейти в
> другое место → Ctrl+V. Новый cellType создаётся автоматически, новый
> Cell instance ставится под курсор. Один action вместо трёх.

### Дизайн

#### Шаг 1: Selection в die viewer

- Click на тело девайса → выделяет (highlight outline)
- Shift+Click → multi-select
- Esc / click в пустое место → clear selection
- Selected set хранится в локальном state DieViewer

#### Шаг 2: Copy

- `Ctrl+C` или кнопка `Copy` в toolbar
- Buffer: `Array<{cellTypeId, instCellId, devices: Array<{fingerprint, _uuid, kind, geometry, ...}>, wireSpans?}>`
- Buffer хранится in-memory (не в localStorage — overkill)
- Если хоть один девайс выделен — копируем

#### Шаг 3: Paste

- `Ctrl+V` или кнопка `Paste`
- Алгоритм:
  1. Создаём новый `CellType`:
     - `id = uuid()`
     - `name = "${original.name}_copy_${n}"` (n++ пока есть collision)
     - `cropRect` = bbox исходного (или объединение bboxes если multi-device)
     - `layers` = deep clone всех shape массивов исходного cellType
       - **Каждый shape получает новый `id = uuid()`** для изоляции
       - Это даёт независимость: правка в copy не влияет на original
       - **Альтернатива:** shared shape ids, но тогда refcount + cleanup
  2. Создаём новый `Cell`:
     - `id = uuid()`
     - `cellTypeId` = новый cellType.id
     - `x, y` = позиция курсора (или offset от original)
     - `flippedH/V`, `rotation` = inherited from original
  3. **Каждое устройство** в новой cellType получает **новый UUID**
     (через `matchOrCreateDevice` с новой fingerprint) — копия = новый
     device, никаких override'ов
  4. Override стартует пустым

#### Шаг 4: Wire connections (опционально для MVP)

**MVP:** копируем только девайсы, не wire'ы. Пользователь сделает re-wire
вручную.

**V2:** копировать wire connections:
- При paste: для каждого net, в котором был original device, если в net
  больше устройств original.cellType — оставить как есть (общий net)
- Если net был только между устройствами original.cellType — создать
  новый net в новой cellType, скопировать edges
- Сложно. Скорее всего оставим "manual re-wire" на v2.

### Edge cases

- **Paste поверх существующего устройства:** показываем error toast, не
  вставляем
- **Multi-device copy:** все девайсы из одного original cellType → один
  новый cellType (preserves grouping). Девайсы из разных cellType → N
  новых cellType (atomic)
- **Selected device был удалён между copy и paste:** warning, пропускаем
- **Copy при rotate/flip:** копия наследует ту же ориентацию, пользователь
  может поменять после paste

### Файлы для изменения

| Файл | Изменения |
|---|---|
| `frontend/src/components/dieViewer/DieViewer.tsx` | Selection state, copy/paste handlers, toolbar buttons |
| `frontend/src/state/copyBuffer.ts` (новый) | In-memory copy buffer с deep clone shape IDs |
| `frontend/src/lib/mergeCells.ts` | Функция `cloneCellTypeWithShapes()` |
| `frontend/src/api/actions.ts` | Новые actions: `pasteDevice`, `cloneCellType` |
| `frontend/src/components/dieViewer/SelectionOverlay.tsx` (новый) | Highlight выделенных девайсов |

---

## Feature B: Make unique (отвязать device от группы)

### User story

> В DeviceInspector (die viewer) кнопка "Make unique" для устройства.
> Создаётся новый cellType с тем же контентом, указанный Cell instance
> переключается на новый cellType. Override для этого девайса применяется
> только к нему, правки слоёв в Cell RE влияют только на него.

### Дизайн

#### Шаг 1: В DeviceInspector добавить кнопку

- Для устройств, которые **разделяют cellType с другими** (т.е. их
  `cellType` имеет > 1 instance), кнопка активна
- Для уникальных (только 1 instance) — кнопка не показывается или
  disabled

#### Шаг 2: Действие

- Создаём новый `CellType`:
  - `id = uuid()`
  - `name = "${original.name}_unique_${n}"`
  - `cropRect`, `layers` = deep clone из original (новые shape IDs)
  - `forcedSourceContacts` = inherited
- Меняем `cellTypeId` конкретного Cell instance на новый
- В registry:
  - Девaйсы в новой cellType получают **новые UUID** (через
    `matchOrCreateDevice` с их новой позицией в копии)
  - Override из оригинала переносится в новый record (для каждого
    устройства с override'ом — `registry.byUUID[oldUuid].overrides` →
    `registry.byUUID[newUuid].overrides`)
- В merge cells: новая cellType появляется как singleton (matched=false)

#### Шаг 3: UI фидбек

- В DieViewer: device помечается badge "unique" (или меняется цвет)
- В CellRERightPanel: переключатель "Apply to all instances" / "Only this
  instance" (но технически "only this" уже автоматически после make
  unique, потому что cellType уникальная)
- В MergeCellsPage: новая cellType видна как unmerged specimen

### Edge cases

- **Make unique уже-unique device:** noop или warning
- **Make unique когда original cellType имеет > 1 cell, и один из них уже
  unique:** создаётся ещё одна cellType (можно chain)
- **Make unique + paste:** pasted cellType можно тоже make unique
- **Override conflict:** если в original cellType два device с одним
  override (через cellTypeId-keyed storage), после make unique override
  остаётся только на новой cellType

### Сложности

- **Layer cloning:** deep clone с новыми IDs — дорого, но необходимо
  для изоляции. Альтернатива: shared shapes, но refcount.
- **Wire connections:** нужно перетянуть wires, которые шли к этому Cell
  instance, в новую cellType. Если wires уникальные для этого instance —
  копируем. Если shared — оставляем как есть.

### Файлы

| Файл | Изменения |
|---|---|
| `frontend/src/components/dieViewer/DeviceInspector.tsx` | Кнопка `Make unique`, badge "unique" |
| `frontend/src/lib/mergeCells.ts` | `cloneCellTypeWithShapes()` |
| `frontend/src/api/actions.ts` | `makeUniqueDevice(uuid)` action |
| `frontend/src/state/deviceRegistry.ts` | `markAsUnique(uuid, newCellTypeId)` helper |
| `frontend/src/components/cellRE/CellRERightPanel.tsx` | Override storage scoped к cellType (auto via registry) |

---

## Feature C: Make group (reverse, future)

Объединить несколько уникальных cellType обратно в одну. Сложно, потому что
нужно:

- Проверить совпадение слоёв (иначе data loss)
- Слить overrides
- Переприсвоить cellTypeId всех instances
- Решить судьбу UUID'ов устройств

**Не MVP.** Оставим на потом.

---

## Архитектурные вопросы

### Layer cloning strategy

| Вариант | Плюсы | Минусы |
|---|---|---|
| Deep clone с новыми shape IDs | Полная изоляция, простая модель | Дорого (CPU + memory), нужно пере-индексировать ссылки |
| Shared shape IDs, refcount | Эффективно, минимум memory | Refcount bugs, копия зависит от оригинала |
| Copy-on-write | Баланс | Сложно реализовать, редко нужно |

**Рекомендация:** deep clone. Cell types маленькие (< 1000 shapes обычно),
overhead приемлемый.

### UI placement кнопки Make unique

- **DeviceInspector (die viewer):** user видит device, знает его
  cellTypeId, может нажать → ✅
- **CellRERightPanel:** user видит cellType, не конкретный instance →
  ❌ не подходит
- **Context menu на device в die viewer:** alternative

**Рекомендация:** в DeviceInspector.

### Что делать если user делает make unique на device, чьи override'ы
применяются ко всей группе

- Original cellType override: cellTypeId-keyed, исчезает когда cellType
  расщепляется
- Per-device override: registry byUUID[oldUuid].overrides → переносим в
  registry byUUID[newUuid].overrides

**Окей.** Single source of truth — registry.

### Wire copy при copy-paste

- В paste для новой cellType нужно скопировать wires, которые шли к
  original Cell instance
- Это выходит за рамки текущего scope — defer to V2
- **MVP:** paste без wires, user делает re-wire

### Cross-tab sync

- Если user копирует в tab A, вставляет в tab B — copy buffer не
  шарится
- **Решение для MVP:** только в рамках одной сессии (in-memory)
- **V2:** `BroadcastChannel` или localStorage event

## Оценка трудозатрат

| Feature | Время | Сложность |
|---|---|---|
| A. Copy/Paste devices | 3 сессии | высокая (UI + layer clone) |
| B. Make unique | 2 сессии | средняя (split logic) |
| C. Make group | 4 сессии | высокая (data merge) |
| Тесты + docs | 1 сессия | низкая |

**Итого:** ~7-10 сессий для всех трёх.

## Открытые вопросы

1. **Hotkey:** Ctrl+C/V стандарт, но конфликтует с text input. Варианты:
   - Cmd+C/V только когда фокус не в input
   - Кнопки в toolbar (без hotkey)
   - Custom hotkey (например Ctrl+Shift+C/V)

2. **Multi-cell-instance при copy:** если original cellType используется
   в 5 instances, copy-paste одного device = новая cellType для одного
   instance. Другие 4 instances остаются в original.

3. **Undo/redo:** все три фичи меняют state, нужен history. Сейчас
   action history не реализован — make unique / paste permanent (с
   подтверждением).

4. **Layer merge strategy при make group:** как мержить слои из разных
   unique copies? Union + dedup? Или требовать identical content?

5. **Visual diff:** при make unique показывать user "это создаст новый
   cellType, остальные instances не изменятся"?
