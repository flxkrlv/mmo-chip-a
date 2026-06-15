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
        есть contact + metal1 на well → bulk = net этого metal1
        нет контакта → bulk = VCC (nwell/PMOS) или GND (pwell/NMOS)
```

### Какие слои используются

| Слой | Роль |
|---|---|
| `nwell` / `pwell` | Определяет PMOS/NMOS + bulk terminal |
| `diffusion` | Тело транзистора (должна быть внутри well) |
| `polysilicon` | Затвор (gate) — должен пересекать diffusion |
| `contact` | Контакты на diffusion → S/D; на well → bulk |
| `metal1` | Соединяет контакты в die-wide сеть |

### Геометрия (W/L/fingers/multiplier)

- **W**: ширина diffusion вдоль poly gate
- **L**: длина poly gate поперёк diffusion (делится на fingers)
- **Fingers**: число poly-затворов, пересекающих одну diffusion
- **Multiplier**: число diffusion с одинаковой W/L в одном well

### S/D (исток/сток)

MOSFET электрически симметричен — в SPICE D и S взаимозаменяемы.
При выводе на overlay оба подписываются "S/D".

### Что НЕ требуется (в отличие от маркерного подхода)

- `mos_id` — не нужен, well определяет тип
- `drain` / `source` / `gate` / `bulk` слои — не нужны
- `device_box` — не нужен

### Если well не нарисован

Детекция не сработает — транзистор не будет найден.
В этом случае используй маркерный метод:
- Нарисуй `mos_id` (прямоугольник вокруг транзистора)
- Внутри: `drain`, `gate`, `source`, `bulk` слои

### Интеграция

Код: `frontend/src/lib/extraction/simpleAnalog.ts` → `detectMOSFromLayers()`
Вызывается из:
- `cellExtraction.ts` — для отображения в RE Cell правой панели
- `dieWideAnalog.ts` — для die-wide коллекции, SPICE экспорта, overlay
