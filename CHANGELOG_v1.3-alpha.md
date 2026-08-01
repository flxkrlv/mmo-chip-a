# v1.3-alpha

## New Features

- **Screenshot export (4K)** — экспорт текущего вида Die Viewer в PNG.
  Композит всех canvas-слоёв (основное изображение + analog device overlay +
  comment overlay) в разрешении до 3840px. Горячая клавиша `Ctrl+Shift+S`
  + кнопка скачивания в SubBar.

- **Outline search (Ctrl+F)** — фильтрация Outline Tree по имени net/cell.
  `Ctrl+F` открывает/закрывает поле поиска. Enter фокусирует первый
  совпадение на canvas, Esc закрывает. Иконка поиска в заголовке "Items".

- **Keyboard shortcuts panel** — модальное окно со всеми горячими клавишами,
  сгруппированными по категориям (Navigation, Tools, Layers, Overlays,
  Editing, RE Cell, Merge Cells, Analog Netlist). Открывается по `Ctrl+/`
  или кнопкой `?` в TopBar. Работает на Die Viewer, RE Cell, Merge Cells.

- **Overlay layer persistence** — настройки overlay-слоёв (видимость,
  прозрачность, сдвиг) сохраняются в localStorage и восстанавливаются
  после F5. Каждый кристалл (die) хранит свои настройки отдельно.

- **Upload overlay to server** — кнопка "Upload to Server" загружает
  overlay-изображения на сервер и автоматически подгружает их при
  следующем открытии кристалла.

- **AKAZE verify** — референс-vs-каждый мэтчинг, debug визуализация,
  нормализация kp-rating.

## Bug Fixes

- **Comments not working in dev mode** — комментарии на топологии не
  работали при запуске без `JWT_SECRET`. Auth store не заполнялся
  dev-идентити, `CommentOverlay` молча выходил из-за guard-проверки
  `userId/username`. Исправлено: `App.tsx` заполняет auth store
  `{ userId: "dev", username: "dev" }` при отключённой авторизации.

- **Overlay filename for CV/template matching** — `serverFilename`
  теперь передаётся с расширением для корректной работы CV-операций.

- **ML setup** — `opencv-contrib-python-headless` вместо
  `opencv-contrib-python` чтобы избежать зависимости от GUI.

## Cleanup

- **Removed redundant DEVICES counter** — счётчик "DEVICES · N" и
  перечисление типов убраны из AnalogDiePanel (дублировал INSTANCES list).
