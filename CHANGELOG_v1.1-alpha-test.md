# v1.1-alpha-test

## Bug fixes

- **Wire tool: merge nets at shared terminal contact** — два провода,
  подключённые к одному контакту устройства, теперь образуют один net
  (а не два разных). Работает как при старте провода от терминала, так
  и при завершении на терминале.

- **Auto-end-on-contact guard** — исправлен copy-paste баг: terminal
  auto-end управлялся преференсом `wireAutoEndOnVia` вместо
  `autoEndOnContact`. Теперь работает при включённом `autoEndOnContact`,
  а не только когда включён via auto-end.

- **Full result cache invalidate on net changes** — красный unconn halo
  исчезает сразу после подключения провода к терминалу, без перезагрузки
  страницы. Кеш экстракции теперь учитывает содержимое нетов
  (node/edge counts), а не только их количество.

## Known issues

- **vyges-lvs: critical bug with 2-terminal devices** — colour refinement
  fails on graphs with ≥23 devices containing R/C/L with swapped terminal
  order. All 23 devices reported as unmatched (0/23 paired).
  ✅ **Fixed in v0.1.15.** Upgraded to v0.1.18 (Jul 2026).

## Other

- **normalizeNetlist: strip Spectre backslash escapes** — убирает `\`
  в Spectre-стиле (`V\-` → `V-`, `in\+` → `in+`).
- **normalizeNetlist: drop parameters line** — `parameters ff=...`
  больше не попадает в нормализованный вывод (vyges-lvs не нужно).
