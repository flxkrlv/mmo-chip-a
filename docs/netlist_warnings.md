# Netlist Warnings

После генерации нетлиста выполняется проверка устройств на электрические
аномалии. Все warnings выводятся в секцию "Warnings" на вкладке Netlist
(Analog) и в начале сгенерированного файла как комментарии.

Каждый warning имеет префикс `[WARN]` (вероятная ошибка), `[INFO]`
(подозрительно, но может быть нормально), либо добавляется другими
частями кода без префикса (например, предупреждения о незагруженном
Clipper2).

---

## MOS transistors

### `[WARN] M_xxx (NMOS/PMOS): drain and source shorted`

D и S соединены в один die-level net. Если это не diode-connected
MOS, то устройство закорочено — гарантированная ошибка.

> **Note:** Diode-connected MOS (D=G) — штатный режим, **не** флажится.
> Этот warning проверяет именно D=S, а не D=G.

### `[WARN] M_xxx (NMOS/PMOS): drain and bulk shorted`

D и bulk соединены в один net. **INFO**, а не WARN — потому что
мы не знаем, какой из выводов diffusion на самом деле является
D, а какой S. Может оказаться, что это source=bulk (нормальная
ситуация для многих топологий).

### `[WARN] M_xxx (NMOS): both D and S on VDD — possibly wrong type`

Оба diffusion-вывода сидят на VDD. Для NMOS это странно — скорее
всего транзистор должен быть PMOS. Аналогично для PMOS: оба вывода
на GND.

> **Ограничение:** D и S не различимы вSPICE, поэтому мы не можем
> сказать "source на VDD" vs "drain на VDD". Проверяем только
> когда **оба** вывода на одном питании.

### `[INFO] M_xxx (NMOS/PMOS): gate is floating`

Gate не подключён ни к одному wire (netId >= 2000 — сгенерирован
как fresh ID, контакт не найден).

---

## BJT

### `[WARN] Q_xxx (bjt_npn/bjt_pnp): collector and emitter shorted`

C и E соединены в один net. Транзистор закорочен.

> **Note:** C=B (diode-connected) — штатный режим, **не** флажится.

### `[WARN] Q_xxx (bjt_npn/bjt_pnp): emitter and base shorted`

E и B соединены в один net. В отличие от C=B, E=B — странная
конфигурация, скорее всего ошибка.

### `[WARN] Q_xxx (NPN): emitter on VDD — will not work`

У NPN транзистора эмиттер на VDD. Транзистор никогда не откроется.

### `[WARN] Q_xxx (PNP): emitter on GND — will not work`

У PNP транзистора эмиттер на GND. Транзистор никогда не откроется.

### `[INFO] Q_xxx (bjt_npn/bjt_pnp): base is floating`

Base не подключён (netId >= 2000).

---

## Diode

### `[WARN] D_xxx (diode): anode=PLUS and cathode=MINUS are shorted`

Оба вывода диода соединены в один net. Диод закорочен.

---

## Resistor / Capacitor

### `[INFO] R_xxx (resistor): both pins shorted — dummy resistor`

Оба вывода резистора в одном net. Скорее всего это dummy-резистор
(преднамеренный коротыш для matching'а).

### `[INFO] C_xxx (capacitor): both pins shorted — dummy capacitor`

Аналогично для конденсатора.

---

## Как VDD/GND определяются

Пользователь задаёт имена VDD и GND на вкладке Netlist (Analog)
в полях `G:` и `GND:`. Они сохраняются в `SpiceConfig.vdd` /
`SpiceConfig.gnd`.

Для проверки polarity используются:
- VDD: `spiceConfig.vdd || "VDD"`, а также `VCC`, `vcc`, `VDD`, `vdd`
- GND: `spiceConfig.gnd || "GND"`, а также `VSS`, `vss`, `GND`, `gnd`

Сравнение идёт по **имени** net'а (как он назван в аннотациях
или IO pins), **не** по netId.
