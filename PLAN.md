# Plan — mmo-chip mixed-signal RE + Multiplayer

---

## ✅ Реализовано (до мультиплеера)

**Аналоговый пайплайн:**
1. ✅ Data model (DeviceKind, DeviceGeometry\*, SpiceConfig)
2. ✅ Device detection (marker-based: `extractMarkedDevices`)
3. ✅ Die-wide collection + wire matching (`collectDieWideAnalogDevices`)
4. ✅ SPICE/CDL/Spectre export — выверен по эталонным Spectre-нетлистам (OPA547, FD6288)
5. ✅ Analog Netlist tab (CDL viewer + net graph)
6. ✅ Device Inspector + overlay highlights + DeviceInstancePanel
7. ✅ Cross-tab navigation (Netlist↔Die↔RE Cell)
8. ✅ Multi-layer image overlays (Die / Merge / RE Cell + clipping по cell area)
9. ✅ Ruler tool (5 режимов + калибровка масштаба double-click)
10. ✅ LPnp слой для PNP детекции
11. ✅ Per-net colors + IO pin snapping
12. ✅ Hotkeys: вкладки 1-5, overlay Ctrl+Shift+B/[]/1..8, инструменты Die/Cell RE
13. ✅ Resistor types: body layer → type detection (poly/pb/npl/hsr/film) + SheetR GUI + persistence
14. ✅ Cell type device review (force override параметров в RE Cell, persist)
15. ✅ Layout-oriented export (CSV placement + SKILL шаблон для Cadence)
16. ✅ uuid polyfill (`crypto.randomUUID()` не работает через Network IP)
17. ✅ cellsLocked (защита от случайного драга ячеек на die viewer)
18. ✅ Net ID overlay (человекочитаемые имена нетов — те же, что в SPICE)
19. ✅ Unconnected terminal glow (жёлтый ореол на новых netId >= 2000)
20. ✅ S/D net label fix (человекочитаемые имена, relabel только при отрисовке)
21. ✅ BJT terminal assignment (point-in-shape + priority E > C > B)
22. ✅ v0.1-alpha-test тег

**Export/Import проекта:**
23. ✅ `POST /api/dies/:dieId/export-project` (light/full)
24. ✅ `POST /api/dies/import-project` (с обработкой конфликтов)
25. ✅ `PUT /api/dies/:dieId/rename`
26. ✅ Full export: ресторится original/ + overlay-изображения
27. ✅ Экспорт/импорт preferences из localStorage

---

## 🔴 Priority 1 — Фундамент мультиплеера (Phase 1)

### 1.1 Логин / Авторизация (LAN-first, foundation для web) ✅

**Архитектурное решение:** Два режима работы с единым кодом:
- **Dev (без JWT_SECRET):** Auth отключена, все запросы проходят без токена
- **Production (JWT_SECRET задан):** Auth обязательна, 401 без токена

**Backend:** `backend/src/api/auth.ts`, `backend/src/auth/middleware.ts`, `backend/src/store.ts` (user CRUD), `backend/src/ws.ts` (WS auth)
- `POST /api/auth/register` — bcrypt, uuid, JWT
- `POST /api/auth/login` — проверка bcrypt, JWT
- `POST /api/auth/verify` — проверка JWT + существования пользователя
- `requireAuth` middleware — 401 без токена, **пропускает всё когда JWT_SECRET не задан**
- WS: token в query string (`?token=...`), 4001 при ошибке

**Frontend:** `frontend/src/state/auth.ts`, `frontend/src/api/auth.ts`, `frontend/src/routes/LoginPage.tsx`, `frontend/src/App.tsx`
- Zustand store с persist в localStorage
- Bearer token во всех API-запросах (`client.ts`)
- WS-соединение с `?token=...`
- `/login` route — форма Login/Register
- `AuthGate` — защита всех роутов, редирект на /login
- Logout в TopBar (аватарка + username + dropdown)
- verify на старте приложения

#### Backend

| Задача | Описание | Время |
|---|---|---|
| `data/users.json` store | Структура как в `store.ts` (users.json с массивом пользователей). CRUD: createUser, findUserByUsername, findUserById | 0.5 дня |
| `POST /api/auth/register` | Принимает `{ username, password }`. Хеш bcrypt, генерация userId (uuid), запись в users.json, возврат JWT | 0.5 дня |
| `POST /api/auth/login` | Принимает `{ username, password }`. Проверка bcrypt, возврат JWT | 0.5 дня |
| `POST /api/auth/verify` | Проверяет JWT, возвращает `{ userId, username }` (для проверки при перезагрузке страницы) | 0.25 дня |
| JWT middleware (`requireAuth`) | Express middleware: читает `Authorization: Bearer <token>`, валидирует, проставляет `req.user = { userId, username }`. 401 при ошибке | 0.5 дня |
| Навесить `requireAuth` на все API-роутеры | Кроме `/api/auth/*` (они публичные). WS тоже закрыть (token в query string) | 0.5 дня |
| WS-аутентикация | При connect проверять `?token=` в URL. Отклонять при невалидном токене. Сохранять `userId` на сокет | 0.5 дня |
| JWT_SECRET из env | Читать `process.env.JWT_SECRET`, падать с ошибкой если не задан. Генерировать fallback для dev (предупреждение в лог) | 0.25 дня |

**Зависимость:** `bcrypt`, `jsonwebtoken`

#### Frontend

| Задача | Описание | Время |
|---|---|---|
| `POST /api/auth/register` + `login` + `verify` в API-клиенте | Три функции как в `client.ts` | 0.25 дня |
| Страница логина | `/login` route: форма username + password, кнопка Login/Register. Переключение между login/register режимом. Страница минимальная — без лишнего UI | 1 день |
| Auth context/store | Zustand store: `{ token, userId, username }`. Сохранять в localStorage. При загрузке — вызывать `/verify` | 0.5 дня |
| Auth-гард (ProtectedRoute) | Компонент-обёртка: если нет token → редирект на `/login` | 0.25 дня |
| Logout | Кнопка в топбаре, сброс token из localStorage | 0.25 дня |
| Bearer token в API-запросах | Дополнить `apiGet/apiPut/apiPost/apiDelete/apiUpload` — читать token из localStorage, добавлять `Authorization: Bearer` header | 0.5 дня |
| WS-соединение с token | При создании WebSocket добавлять `?token=` | 0.25 дня |

**Итого Phase 1.1:** **~5-6 дней**

---

### 1.2 Production build (Express раздаёт статику)

Не обязателен для LAN, но нужен для перехода к веб-доступу.
Можно отложить до Phase 2.

| Задача | Время |
|---|---|
| Express.static('frontend/dist') + SPA fallback (`/*` → `index.html`) | 1 час |
| `npm run build` → `npm run start` (запускает бэкенд + раздаёт статику) | 0.5 дня |
| Caddy reverse proxy (опционально — для HTTPS) | 1 день |

---

### 1.3 WS: "Кто онлайн" + статус ✅

| Задача | Описание | Время |
|---|---|---|
| WS-событие `user/online` | Сервер: при WS-коннекте broadcast всем (кроме самого юзера) | 0.25 дня |
| WS-событие `user/offline` | Сервер: при WS-дисконнекте broadcast | 0.25 дня |
| WS-событие `user/status` | Клиент: шлёт `{ dieId, tool }` при смене die/инструмента. Сервер: запоминает + broadcast | 0.5 дня |
| Серверный `onlineUsers: Map<socket, { userId, username, dieId, tool }>` | Центральное состояние активных пользователей | 0.25 дня |
| Frontend: OnlineUsersPanel | Маленькая панель (сайдбар или выпадашка) — список юзеров онлайн с иконками/цветами, указанием die и активного тула | 1 день |

**Итого Phase 1.3:** **~2 дня**

---

## 🟡 Priority 2 — Инструменты коллаборации (Phase 2)

**Зависимость:** Phase 1.1 (авторизация)

### 2.1 Floorplan — rect/polygon с подписями + резервация

**Требование (2026-06-23):**
- Полигоны **без заливки** (`fill: none`), только обводка — не закрывают канвас
- Резервация опциональна: `reservedBy` может быть null, в соло-режиме не используется
- Иерархический нетлист (post-MVP): регион → `.SUBCKT` с автодетекцией портов по boundary nets.
  Имя порта — wire-имя из DieAnnotations. Flat netlist остаётся по умолчанию (чекбокс "Hierarchical").
- **A5 (user feedback, 2026-06-23):**
  - Видимый переключатель rect/poly (сейчас может не отображаться)
  - Drag-based drawing: rect — rubber-band, poly — live line от последней вершины к курсору
  - Толщина stroke 2-3px, размер текста 14-16px
  - Показывать автора (createdBy) и резервацию (reservedBy) в popover
  - Кнопка Reserve/Release в popover (для мультиплеера)

#### Backend (A1–A2)

| Задача | Описание | Время |
|---|---|---|
| Тип `FloorplanRegion` в `shared/types.ts` | `{ id, name, kind: "rect"|"polygon", geometry: Point[], color, reservedBy, reservedAt, portAliases? }` | ✅ A1 |
| `floorplanRegions?` в `DieAnnotations` | Опциональное поле | ✅ A1 |
| API-роуты через `registerOptionalCollectionRoutes` | `PUT/DELETE /api/dies/:dieId/floorplan/:id` + WS broadcast | ✅ A2 |

**Итого A1–A2:** **0.5 дня**

#### Frontend (A3–A4) — ✅ Done

| Задача | Описание | Статус |
|---|---|---|
| Zustand store для floorplan | `FloorplanState: { regions, selectedRegionId, activeTool }` | ✅ A3 |
| Инструмент "Floorplan" в тулбаре | Иконка (rect/poly), хоткей `H`, переключение режимов rect/poly | ✅ A3 |
| Рендер-слой (без заливки) | `fill: none`, `stroke: color`, пунктир. Поверх всего, не мешает | ✅ A4 |
| Popover при клике на регион | Имя (редактируемое), цвет, кнопки Delete. Позже: Reserve/Release, порты | ✅ A4 |
| Polygon drawing | Клик-to-add-vertex, double-click/Enter завершает | ✅ A4 |

#### Frontend (A5) — QA + user feedback — ✅ Done

| Задача | Описание | Статус |
|---|---|---|
| Tool mode selector | Видимый переключатель rect/poly | ✅ |
| Drag-based drawing | Rect — rubber-band drag preview; poly — live line | ✅ |
| Polygon drag preview | При клике-to-add-vertex показывать live line от последней вершины к курсору | ✅ |
| Толщина/размер текста | `strokeWidth: 2-3`, `fontSize: 14-16` | ✅ |
| Author/reservation info | `createdBy`, `reservedBy` в popover; кнопка Reserve/Release | ✅ |
| QA — dev server | Проверить тулбар, клик, поповер, сохранение, WS broadcast | ✅ |

**Итого A5:** **~1 день ✅**

#### B1–B4 — Hierarchical netlist + Ports — ✅ Done

| Задача | Описание | Статус |
|---|---|---|
| `generateHierarchicalNetlist()` | Расширение `frontend/src/lib/export/spice.ts` — регион → .SUBCKT, автодетекция портов по boundary nets | ✅ B1 |
| UI чекбокс "Hierarchical" | Чекбокс в панели экспорта AnalogNetlistPage, по умолчанию flat (не ломает существующий экспорт) | ✅ B2 |
| Port naming в popover | Auto-detected boundary nets с editable alias'ами в FloorplanRegionPopover | ✅ B3 |
| Визуализация портов | Цветные кружки + label на die viewer при выделении региона | ✅ B4 |

**Итого B1–B4:** **~4-5 дней ✅**

**Phase 2.1 total:** **~3 дня (+ ~5 дней B-фаза = 8 дней общий)**

---

### 2.2 Текстовые аннотации на топологии (кликабельные комментарии)

**Требование:** Простой вариант — кликабельная иконка на топологии, popover с текстом (автор, дата, сообщение). Можно отвечать в треде.

#### Backend

| Задача | Описание | Время |
|---|---|---|
| Коллекция `comments[]` в DieAnnotations | `{ id, x, y, text, authorId, createdAt, replies: [{ text, authorId, createdAt }] }` | 0.25 дня |
| API-роуты | `PUT/DELETE /api/dies/:dieId/comments/:id` + `POST /api/dies/:dieId/comments/:id/reply` | 0.25 дня |

#### Frontend

| Задача | Описание | Время |
|---|---|---|
| Инструмент "Comment" (пин) | Клик на топологии → создаёт пин (иконка в точке клика) | 0.5 дня |
| Render: иконки комментариев | Маленькие маркеры на canvas (speech bubble icon) | 0.5 дня |
| Popover комментария | При клике на маркер: показать текст, автора, дату, список ответов, поле ввода ответа | 1 день |
| WS-обновления | Новые комментарии появляются у всех открывших die (существующий `emitAnnotationChange`) | — |
| Индикатор "N новых комментариев" | Счётчик на кнопке в тулбаре или статусбаре | 0.5 дня |

**Итого Phase 2.2:** **~3 дня**

---

### 2.3 Чат внутри die (опционально)

**Зависимость:** Phase 1.1

| Задача | Время |
|---|---|
| WS-канал `chat/message` (сервер + клиент) | 1 день |
| UI: Drawer/панель чата (правый нижний угол) | 1 день |
| Persist: логи чата в `data/dies/{dieId}/chat.json` | 0.5 дня |
| **Итого** | **2.5 дня** |

**Note:** Если команда использует Discord/Slack для живого общения, чат внутри приложения даёт меньше пользы. Основная ценность — комментарии на топологии (2.2), где обсуждение привязано к геометрии.

---

## 🔵 Priority 3 — Полноценный web-доступ (Phase 3)

Когда понадобится удалённая работа.

| Задача | Время |
|---|---|
| Caddy reverse proxy + Let's Encrypt (авто-HTTPS) | 1 день |
| Rate limiting на `/api/auth/*` | 0.5 дня |
| Docker-контейнеризация (backend + frontend-dist + ml-sidecar) | 2-3 дня |
| OAuth (Google/GitHub) как опция вместо пароля | 1-2 дня |
| **Итого** | **4-6 дней** |

---

## 🟣 Priority 4 — Мышки / Figma-style cursors (Post-MVP)

| Задача | Время |
|---|---|
| WS-канал cursor positions (30fps throttle) | 1 день |
| Рендер чужих курсоров на canvas (маленький кружок + username) | 1 день |
| Hover-подсветка выбранного объекта у другого юзера | 1 день |
| Чужой viewport highlight (границы видимой области на мини-карте) | 2 дня |
| **Итого** | **4-5 дней** |

Отложено на потом — дорого, полезно только при синхронной парной работе.

---

## 🔧 Деплой-инфраструктура (сводка)

| Режим | Команда запуска | Доступ |
|---|---|---|
| **Dev (LAN)** | `npm run dev` (Vite + Express + sidecar concurrently) | http://IP:5173 |
| **Prod (LAN)** | `npm run build` → `node backend/dist/index.js` (Express-statics) | http://IP:3001 |
| **Prod (Web)** | Docker-compose (Caddy → Express + static + sidecar) | https://domain.com |

---

## 📊 Полная карта timeline

```
Phase 1 (8-9 дней) — ✅ 1.1 + 1.3 сделано
├── 1.1 Логин + JWT + WS-auth        ████████████████████  ✅
├── 1.2 Production build (Express.static)  ░░░░░░░░░░░░░░  → Phase 3
└── 1.3 "Кто онлайн" + статус         ████████████████████  ✅

Phase 2 (текущий приоритет)
├── 2.2 Комментарии на топологии      ████████████████████  ✅ (3д)
├── 2.1 Floorplan                      ████████████████████  3д (≈0д ост.)  ← NEARLY DONE
│   ├── A1 Data model                 ████████████████████  ✅
│   ├── A2 Backend CRUD               ████████████████████  ✅
│   ├── A3 Zustand store + toolbar    ████████████████████  ✅
│   ├── A4 Overlay + popover          ████████████████████  ✅
│   ├── A5 Dev-server QA + fixes      ████████████████████  ✅
│   ├── B1 Hierarchical netlist       ██████░░░░░░░░░░░░░░  ~2д  ← IN PROGRESS
│   ├── B2 UI чекбокс "Hierarchical"  ████████████████████  ✅ (~0.5д)
│   ├── B3 Port naming в popover      ████████████████████  ✅ (~1д)
│   └── B4 Визуализация портов        ████████████████████  ✅ (~1д)
└── 2.3 Чат внутри die                ❌ (вычеркнут — дублирует 2.2)

Phase 3 (4-6 дней) — когда понадобится удалёнка
├── Caddy + HTTPS + Docker            ░░░░░░░░░░░░░░░░░░░  2-3д
└── Rate limiting + OAuth             ░░░░░░░░░░░░░░░░░░░  2-3д

Phase 4 (4-5 дней) — когда понадобятся мышки
└── Figma-style cursors               ░░░░░░░░░░░░░░░░░░░  4-5д
```

---

## 🧱 Архитектурные решения (зафиксировать)

1. **token в localStorage, не в cookies** — не нужен CSRF, SameSite, HTTPS-only. Работает и в LAN, и в Web.
2. **JWT payload** — только `{ userId, username }`. Никаких ролей на старте.
3. **userId в каждой аннотации/комментарии/регионе** — `lastModifiedBy`, `createdBy`, `reservedBy` — строки.
4. **WS-сообщения расширяются** — текущий протокол `{ type, dieId, rev }` дополняется типами `user/online`, `user/offline`, `user/status`, `chat/message`.
5. **Все фичи коллаборации — опциональные поля в DieAnnotations** — не ломают обратную совместимость старых проектов (undefined = нет данных).
6. **Floorplan reservation — предупреждение, не блокировка.** Один алерт, дальше пользователь сам решает.
