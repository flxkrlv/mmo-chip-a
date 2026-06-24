# MOS Transistor Detection (well-based)

## Как это работает

Детекция NMOS/PMOS транзисторов из аннотированных слоёв без использования
маркеров (`mos_id`/`drain`/`gate`/`source`/`bulk`).

### Принцип

```
nwell слой (или pwell)
  └── определяет тип транзистора:
        nwell = PMOS (p-type diffusion в nwell)
        pwell = NMOS (n-type diffusion в pwell)
  └── определяет bulk (подложку):
        есть contact на well (НЕ на diffusion, НЕ на poly) → positive netId
        нет контакта на well → sentinel -2 → VDD (PMOS) / GND (NMOS)
```

### Какие слои используются

| Слой | Роль |
|---|---|
| `nwell` / `pwell` | Определяет PMOS/NMOS + bulk terminal |
| `diffusion` | Тело транзистора (должна быть внутри well) |
| `polysilicon` | Затвор (gate) — должен пересекать diffusion |
| `contact` | Контакты на diffusion → S/D; на well (без diff/poly) → bulk |

### Multi-finger MOS (fingers > 1) — Clipper2

Для multi-finger транзисторов diffusion **физически разрезается** между
затворами с помощью Clipper2 `polygonDifference()`:

```
    gate[0]   gate[1]   gate[2]
  ┌────┼────┼────┼────┼────┼────┐
  │  S │ D=S│ D=S│ D=S│ D  │    │  diffusion
  └────┼────┼────┼────┼────┼────┘
       │    │    │    │    │
  seg[0] seg[1] seg[2] seg[3]
```

- N gate fingers → N+1 сегментов diffusion
- Каждый gate → отдельный MOS с `id = mos_well_${well}_${n}_finger${i}`
- Shared сегмент `seg[i+1]` = D для gate[i] и S для gate[i+1]
- Shared сегменты → одинаковый netId при wire matching
- Сегменты кешируются в `_segmentShapesCache` под per-gate device ID

### W/L/fingers/multiplier

- **W**: ширина diffusion вдоль poly gate (bbox intersection)
- **L**: длина poly gate поперёк diffusion
- **Fingers**: число poly-затворов, пересекающих одну diffusion
- **Multiplier**: группировка устройств по `type + W + L`; если в одном well
  несколько diffusion с одинаковыми параметрами → multiplier > 1

### Well tap — LVS layer exclusion

Контакт считается well tap ТОЛЬКО если:
1. Лежит внутри bbox well-а
2. НЕ лежит на diffusion (иначе это S/D контакт)
3. НЕ лежит на polysilicon (иначе это gate контакт)

Это классический Calibre LVS-подход: контакт принадлежит самому специфичному слою.

### Gate marker → well-based

Раньше существовал marker-based подход (`mos_id` + `drain`/`gate`/`source`/`bulk`).
Он удалён — well-based детекция покрывает все случаи.

### Edge cases

- **well есть, diffusion есть → всегда транзистор**, даже без poly-затвора
  (в этом случае gates.length = 0 → устройство не создаётся)
- **well contact есть, но нет metal1**: contact → positive netId (уникальный
  внутренний net, не VDD/GND). Это корректно — пользователь явно поставил
  well tap, даже если он никуда не подключён.
- **well contact совпадает с S/D контактом**: исключается LVS правилом —
  контакт на diffusion → S/D, не bulk.

### Интеграция

Код: `frontend/src/lib/extraction/simpleAnalog.ts` → `detectMOSFromLayers()`
Вызывается из:
- `cellExtraction.ts` — для отображения в RE Cell правой панели
- `dieWideAnalog.ts` — для die-wide коллекции, SPICE экспорта, overlay
