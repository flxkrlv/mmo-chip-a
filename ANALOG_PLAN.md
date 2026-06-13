# Phase 1 — Базовый аналоговый RE: план работ

## Обзор

Расширить mmo-chip для восстановления **аналоговых/смешанных БИС** с детекцией
транзисторов, резисторов, конденсаторов, диодов, биполярных и JFET-транзисторов,
вычислением параметров элементов (W/L, площадь эмиттера, множители…), и выгрузкой
в SPICE-совместимые форматы (CDL, Spectre).

---

## R1 — Расширение типовой модели (`shared/types.ts`)

### 1.1 Дополнительные слои

```ts
export type LayerType =
  // существующие:
  | "diffusion" | "polysilicon" | "metal1" | "metal2"
  | "contact" | "via1" | "wire_hitbox"
  // *** новые — аналоговые / BiCMOS:
  /** Карманы */
  | "nwell" | "pwell" | "deep_nwell" | "buried_layer"
  /** Биполярные слои */
  | "base" | "emitter" | "collector_sinker"
  /** Импланты для JFET */
  | "jfet_gate" | "jfet_channel"
  /** Резисторные / конденсаторные слои */
  | "resistor_body"
  | "capacitor_bottom" | "capacitor_top"
  /** Дополнительные металлы */
  | "metal3" | "metal4" | "metal5" | "metal6"
  /** Составные: отмечается пользователем как граница устройства */
  | "device_box"
  /** Цветовые эталоны для распознавания материала (вспомогательный слой) */
  | "material_swatch";
```

### 1.2 Модель аналогового устройства

```ts
export type DeviceKind =
  | "mos"        // PMOS / NMOS — уже есть как Transistor
  | "bjt_npn"    // NPN-биполярный
  | "bjt_pnp"    // PNP-биполярный
  | "jfet_n"     // N-JFET
  | "jfet_p"     // P-JFET
  | "resistor"
  | "capacitor"
  | "diode"      // обычный pn-диод
  | "zener"      // стабилитрон
  | "schottky"   // диод Шоттки
  | "inductor"
  | "unknown";

export interface DeviceGeometryMOS {
  /** Длина затвора (поликремний поперёк диффузии) */
  L_um: number;
  /** Ширина затвора (граница диффузии вдоль поли) */
  W_um: number;
  /** Fingers — число параллельных затворов */
  fingers: number;
  /** Multiplier — число повторений ячейки */
  multiplier: number;
  /** Суммарная эффективная ширина = W × fingers × multiplier */
  totalW_um: number;
  /** Тип: всё ещё определяется через diffusion/well */
  mosType: "pmos" | "nmos" | "unknown";
}

export interface DeviceGeometryBJT {
  /** Полная площадь эмиттера (пересечение base × emitter) */
  AE_um2: number;
  /** Периметр эмиттера */
  PE_um: number;
  /** Multiplier */
  multiplier: number;
  /** Суммарная AE = AE × multiplier */
  totalAE_um2: number;
  /** Число полосок эмиттера */
  emitterFingers: number;
  /** Тип */
  bjtType: "npn" | "pnp" | "unknown";
}

export interface DeviceGeometryJFET {
  W_um: number;           // ширина канала
  L_um: number;           // длина канала (между стоком и истоком)
  fingers: number;
  multiplier: number;
  jfetType: "njf" | "pjf" | "unknown";
}

export interface DeviceGeometryResistor {
  /** Физическая длина тела резистора */
  L_um: number;
  /** Физическая ширина тела */
  W_um: number;
  /** Количество квадратов (L / W) */
  squares: number;
  /** Sheet resistance в омах на квадрат — задаётся пользователем */
  sheetR_ohms?: number;
  /** Сопротивление = squares × sheetR_ohms */
  resistance_ohms?: number;
  fingers: number;        // параллельные сегменты
  multiplier: number;
  /** Форма: "straight" | "meander" | "serpentine" */
  shape?: string;
}

export interface DeviceGeometryCapacitor {
  /** Площадь перекрытия верхней и нижней обкладок */
  area_um2: number;
  /** Периметр нижней обкладки */
  perimeter_um: number;
  /** Удельная ёмкость в фФ/мкм² — задаётся пользователем */
  capDensity_fF?: number;
  /** Ёмкость = area × capDensity_fF */
  capacitance_fF?: number;
  multiplier: number;
  /** Multi-plate / MIM / MOS */
  capType?: "mim" | "pip" | "mos" | "unknown";
}

export interface DeviceGeometryDiode {
  area_um2: number;
  perimeter_um: number;
  multiplier: number;
  diodeType?: "pn" | "schottky" | "zener" | "unknown";
}

export type DeviceGeometry =
  | DeviceGeometryMOS
  | DeviceGeometryBJT
  | DeviceGeometryJFET
  | DeviceGeometryResistor
  | DeviceGeometryCapacitor
  | DeviceGeometryDiode;

export interface AnalogDevice {
  id: string;
  kind: DeviceKind;
  geometry: DeviceGeometry;
  /** Имя устройства в SPICE-нетлисте (напр. M1, Q12, R34) */
  instanceName?: string;
  /** Имя модели (напр. NMOS_VTL, PNP_10x10) */
  modelName?: string;
  /** Номера SPICE-узлов (заполняются при топологии) */
  terminals: { name: string; netId: number }[];
  /** Polygon-описание тела устройства в cell-local координатах */
  outline: { x: number; y: number }[];
  /** Bounding box */
  bbox: AnnotationRect;
  /** Пользовательский комментарий/описание */
  comment?: string;
}
```

### 1.3 Расширение CellExtraction

```ts
// В InferredCellExtraction добавить:
export interface InferredCellExtraction extends CellExtractionBase {
  kind: "inferred";
  // …существующие поля…
  
  // *** новые:
  /** Аналоговые устройства (в дополнение к CMOS-транзисторам) */
  analogDevices: AnalogDevice[];
  /** Параметры для SPICE-субконтура */
  parameters?: Record<string, number | string>;
}
```

### 1.4 SPICE-конфигурация (на уровне die или cell-type)

```ts
export interface SpiceConfig {
  /** Технология: темплейт для .MODEL карт */
  technology?: string;
  /** Sheet resistance по умолчанию для каждого резисторного слоя */
  sheetRohms?: Record<string, number>;
  /** Ёмкость на единицу площади для конденсаторных слоёв [фФ/мкм²] */
  capDensity_fF?: Record<string, number>;
  /** Модели транзисторов: ModelName → .MODEL карта */
  models?: Record<string, string>;
  /** VDD имя по умолчанию */
  vdd?: string;
  /** GND имя по умолчанию */
  gnd?: string;
}
```

---

## R2 — Модуль детекции аналоговых устройств

**Файл:** `frontend/src/lib/extraction/analogDevices.ts` (новый)

### 2.1 Структура модуля

```
analogDevices.ts
  ├── detectDevices(cellType, layers, shapes, nets) → AnalogDevice[]
  ├── detectMOS(layers, shapes, nets) → AnalogDevice[]    (есть в cell.ts, адаптировать)
  ├── detectBJT(layers, shapes, nets) → AnalogDevice[]
  ├── detectJFET(layers, shapes, nets) → AnalogDevice[]
  ├── detectResistors(layers, shapes, nets) → AnalogDevice[]
  ├── detectCapacitors(layers, shapes, nets) → AnalogDevice[]
  ├── detectDiodes(layers, shapes, nets) → AnalogDevice[]
  ├── detectPassivesByML(...) — ML-assisted детекция
  └── helpers/
      ├── computeMOSParams(shape) → DeviceGeometryMOS
      ├── computeBJTParams(shapes) → DeviceGeometryBJT
      ├── computeResistorParams(shapes) → DeviceGeometryResistor
      ├── computeCapacitorParams(shapes) → DeviceGeometryCapacitor
      ├── computeDiodeParams(shapes) → DeviceGeometryDiode
      ├── countFingers(shapes) → number
      ├── countMultipliers(devices) → number
      └── detectMatching(shapes) → { commonCentroid: boolean; interdigitated: boolean }
```

### 2.2 Алгоритмы детекции по типам

#### DETECT_BJT (NPN)

```
Слои: nwell | pwell | deep_nwell (коллектор)
      polysilicon | diffusion (база)
      diffusion (эмиттер)
      contact (контакт эмиттера, базы, коллектора)

Правило:
  1. Ищем все nwell → p-active (база) области в nwell
  2. Внутри каждой базы ищем p-active → n+ emitter области
  3. Проверяем контакты: есть ли контакт к коллектору (nwell вытяжка)
  4. Если все три составляющие есть — это NPN

  PNP — инвертированная структура (pwell + n-active база + p+ эмиттер)

Параметры:
  AE = intersection_area(base_poly, emitter_diff)
  PE = perimeter(intersection)
```

#### DETECT_JFET

```
Слои: n+/p+ implant (gate)
      opposite implant (channel)
      metal contacts

Правило:
  1. Ищем gate-диффузию, которая полностью окружает (либо с 3 сторон) канал
  2. Канал — диффузия противоположного типа между gate-областью
  3. Контакты на концах канала = сток/исток

Параметры:
  L = длина канала между стоком и истоком
  W = ширина канала (перпендикулярно L)
```

#### DETECT_RESISTOR

```
Слои: polysilicon | diffusion | nwell | pwell (тело резистора)
      contact (на концах)
      metal (подводка)

Правило:
  1. Ищем изолированные poly/diffusion/well области
     с контактами на двух (или более) концах
  2. Если контактов 2+ и они на противоположных концах — это резистор
  3. Меандровые/серпантинные формы: детекция по topology
     (контакты на концах, длинное извилистое тело)
  4. Исключаем poly, который пересекает diffusion (это MOS-затвор)

Параметры:
  L = длина центральной линии тела (скелетонизация)
  W = средняя ширина тела
  squares = L / W
  shape = "meander" если есть повороты > 180°

Детекция пальцев:
  - Если несколько параллельных сегментов соединены общими контактами
    → fingers = число сегментов
```

#### DETECT_CAPACITOR

```
Слои: polysilicon (нижняя обкладка)
      polysilicon | metal (верхняя обкладка)
      contact (контакты)

Правило:
  1. Ищем две poly/metal области разных слоёв, которые перекрываются
     и НЕ соединены контактами
  2. Если каждый слой имеет свой контакт к металлу — это capacitor
  3. Исключаем poly-poly crossing которая является inter-layer via

Параметры:
  area = intersection_area(top, bottom)
  perimeter = perimeter(intersection)
  capType = 
    "mim" если верхняя = metal и нижняя = metal с dielectric
    "pip" если оба poly
    "mos" если poly-over-diffusion (MOSCAP)
```

#### DETECT_DIODE

```
Слои: diffusion (активная область)
      contact (один контакт)

Правило:
  1. Ищем diffusion-область с контактом,
     у которой НЕТ poly, пересекающего её (это был бы MOS)
  2. Если есть well того же типа (pwell под p-diff = подложка-диод)
     → площадь перехода = area

Параметры:
  area = площадь diffusion с контактом  
  perimeter = периметр
```

### 2.3 Геометрические расчёты (W/L, AE, squares)

#### W/L для MOS (точнее, чем сейчас)

```ts
function computeMOSParams(
  diffPolygon: Point[],     // diffusion sub-region
  gatePolygon: Point[],     // poly gate shape
): { W_um: number; L_um: number } {
  // 1. Находим центр poly gate (midline)
  // 2. Проецируем midline на diffusion → пересечение
  // 3. L = ширина poly gate в области пересечения с diffusion
  //    (измеряем shortest distance между двумя краями poly)
  // 4. W = длина пересечения midline с diffusion boundary
  //    (проекция gate edge на diffusion)
  // 
  // Для пальцевых транзисторов:
  // 5. Ищем параллельные poly линии через diffusion
  //    gates = parallel polys crossing same diffusion
  // 6. fingered = gates.length
  //    W_per_finger = W / fingered   // одна diffusion на все пальцы? 
  //    Или: W = sum(W_i) для каждого poly
  //
  // Единицы: передаём scaling factor (μm/px) из метаданных die
}
```

#### Squares для резисторов

```ts
function computeResistorParams(
  bodyPolygon: Point[],     // poly/resistor shape (может быть меандр)
  contacts: Point[][],      // контактные области
): DeviceGeometryResistor {
  // 1. Скелетонизация bodyPolygon → centreline
  //    (алгоритм thinning / Zhang-Suen)
  // 2. L = длина centreline
  // 3. W = среднее расстояние от centreline до краёв × 2
  //    ИЛИ: 2 × area(bodyPolygon) / (perimeter(bodyPolygon) - 2*contactWidths)
  // 4. squares = round(L / W, 2)
  // 5. Меандр: если centreline содержит > 2 колен (правый угол) → meander
  // 6. fingers: если есть сегменты, соединённые параллельно → count
}
```

---

## R3 — Модуль SPICE/CDL экспорта

**Файл:** `backend/src/mlExport/exporter.ts` (расширить)
**Файл:** `frontend/src/lib/export/spice.ts` (новый)

### 3.1 CDL-генератор

```ts
interface SpiceInstance {
  kind: "mos" | "bjt" | "jfet" | "resistor" | "capacitor" | "diode";
  instanceName: string;
  modelName: string;
  terminals: string[];       // D G S B | C B E | etc.
  parameters: Record<string, string | number>;
  /** Геометрия в виде SPICE-параметров */
  area?: number;     // для BJT
  perim?: number;    // для BJT
  w?: number | string; // для MOS
  l?: number | string; // для MOS
  m?: number;        // multiplier
}

interface SpiceSubckt {
  name: string;
  ports: string[];
  instances: SpiceInstance[];
  modelCards: string[];     // inline .MODEL
  includes: string[];       // библиотеки моделей
  parameters?: Record<string, string | number>;
}

function generateCDL(subckts: SpiceSubckt[]): string {
  // Формат CDL:
  // .SUBCKT NAME A B C D
  // M1 D G S B NMOS W=10u L=0.35u M=1
  // Q1 C B E NPN AREA=2p
  // R1 A B POLYR W=2u L=20u
  // C1 A B MIMCAP W=10u L=10u
  // .ENDS
  //
  // .SUBCKT можно вкладывать иерархически
  // XTOP A B C D SUBCKT_NAME
}
```

### 3.2 Spectre-генератор (альтернативный формат)

```ts
function generateSpectre(subckts: SpiceSubckt[]): string {
  // Формат Spectre:
  // subckt NAME (A B C D)
  //   M1 (D G S B) nmos w=10u l=0.35u m=1
  //   Q1 (C B E) npn area=2p
  //   R1 (A B) resistor r=1k
  // ends NAME
}
```

### 3.3 Экспорт для Cadence

```ts
interface CadenceExportParams {
  /** Режим: flat (один файл) или hierarchical */
  mode: "flat" | "hierarchical";
  /** Для иерархического: разбивать ли на subcircuit-блоки */
  subcircuitThreshold?: number; // мин. элементов в блоке
  /** Включать ли .MODEL карты в нетлист */
  includeModels: boolean;
  /** Тип SPICE-диалекта */
  dialect: "cdl" | "spectre" | "hspice";
}

async function exportToCadence(
  dieId: string, 
  params: CadenceExportParams
): Promise<{ cdlFile: string; logFile: string }> {
  // 1. Загружаем DieAnnotations
  // 2. Для каждой cellType запускаем detectDevices
  // 3. Строим иерархию subcircuits
  // 4. Генерируем CDL
  // 5. Пишем файлы в data/<dieId>/export/
  // 6. Возвращаем пути
}
```

### 3.4 Примеры выходных форматов

**CDL для дифференциального входа LMV341:**

```cdl
* MMO-CHIP Analog Export
* Source: LMV341_die
* Date: 2026-06-11
.GLOBAL VCC VEE
.SUBCKT INPUT_STAGE VINP VINN TAIL_BIAS OUTP OUTN
M1 N01 VINP N03 VEE NCH W=50u L=0.8u M=4
M2 N02 VINN N03 VEE NCH W=50u L=0.8u M=4
M3 VCC N01 N01 PCH W=20u L=1u M=2
M4 VCC N02 N02 PCH W=20u L=1u M=2
M5 N03 TAIL_BIAS VEE NCH W=100u L=1u M=2
Q1 VCC N01 OUTP NPN AREA=4e-12
Q2 VCC N02 OUTN NPN AREA=4e-12
* Power and bias
.MODEL NCH NMOS (VTO=0.7 KP=120e-6)
.MODEL PCH PMOS (VTO=-0.7 KP=60e-6)
.MODEL NPN NPN (BF=200 IS=1e-16)
.ENDS INPUT_STAGE
```

---

## R4 — Расширение фронтенда

### 4.1 Новые инструменты аннотации

В панели Cell RE добавить:

```
Layer-палитра (дополнительные слои):
  ☐ nwell / pwell / deep_nwell
  ☐ base / emitter / collector
  ☐ jfet_gate / jfet_channel
  ☐ resistor_body
  ☐ capacitor_top / capacitor_bottom
  ☐ metal3..6
  ☐ device_box

Типы устройств (выпадающее меню для помеченной области):
  ▸ NPN BJT
  ▸ PNP BJT
  ▸ N-JFET / P-JFET
  ▸ Resistor (poly / diffusion / well)
  ▸ Capacitor (MIM / PIP / MOS)
  ▸ Diode / Zener
  ▸ Unknown / Custom

Справа — панель параметров устройства:
  W/L/Fingers/M — для MOS
  AE/PE/M — для BJT
  W/L/Squares — для резистора
  Area/Perimeter — для конденсатора
```

### 4.2 Визуализация аналоговых элементов

```tsx
// frontend/src/components/cellRE/AnalogDeviceLayer.tsx
// Отрисовка поверх фото чипа:
//   - Разные цвета для разных DeviceKind
//   - Имя устройства (Q1, M12, R4)
//   - Параметры рядом (W=50u/4, AE=2p×2)
//   - Вывод terminal connections

// frontend/src/lib/schematic/analogSymbols.tsx
//   - transistorSymbol: треугольник + gate
//   - bjtSymbol: круг + эмиттерная стрелка
//   - resistorSymbol: зигзаг
//   - capacitorSymbol: две пластины
//   - diodeSymbol: треугольник + черта
```

### 4.3 Аналоговый схемный рендер

Расширить `SchematicCanvas.tsx` / `netlist.tsx`:

```
- Новый layout engine: топологический (не логический)
- ELK можно использовать, но direction = left-to-right для сигнала
- VCC/GND как явные порты питания (с развязкой)
- Текущие зеркала / diff-pairs — группировать
- Размеры символов пропорциональны W/L (визуально)
```

---

## R5 — Интеграция в backend

### 5.1 Новые API endpoints

```
POST /api/dies/:dieId/export/analog
  Query: { format: "cdl" | "spectre" | "hspice", hierarchical: boolean }
  → Возвращает: { exportPath: string; warnings: string[] }

GET  /api/dies/:dieId/devices
  → Возвращает: { devices: AnalogDevice[]; cellType: string }

POST /api/cells/:cellTypeId/classify-devices
  Body: { userDeviceAssignments: DeviceAssignment[] }
  → Переопределение автоматической классификации

POST /api/dies/:dieId/spice-config
  Body: SpiceConfig
  → Сохранение технологической конфигурации

GET  /api/dies/:dieId/spice-config
  → SpiceConfig
```

### 5.2 Celestial-ориентированная экстракция

```ts
// backend/src/extraction/analogPipeline.ts (новый)

interface ExtractionJob {
  dieId: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number; // 0-100
  result?: {
    totalDevices: number;
    byType: Record<DeviceKind, number>;
    warnings: string[];
    exportPath?: string;
  };
}

async function extractAnalogDevicesFromDie(
  dieId: string,
  annotations: DieAnnotations,
  cellExtractions: Map<string, CellExtraction>,
): Promise<AnalogDevice[]> {
  // 1. Для каждой cellType запустить detectDevices (R2)
  // 2. Собрать все устройства с карты
  // 3. Распределить по nets (соединения через wire_hitbox)
  // 4. Списк: вычислить terminalNetIds
  // 5. Вернуть глобальный список устройств
}
```

---

## R6 — План тестирования

### 6.1 Unit-тесты (Jest)

| Тест | Файл | Описание |
|---|---|---|
| `computeMOSParams` | `analogDevices.test.ts` | W/L из poly+diffusion, включая fingered |
| `computeBJTParams` | `analogDevices.test.ts` | AE из base+emitter overlap |
| `detectResistors` | `analogDevices.test.ts` | Прямой poly vs meander |
| `detectCapacitors` | `analogDevices.test.ts` | MIM vs PIP vs MOS |
| `detectDiodes` | `analogDevices.test.ts` | pn junctions |
| `generateCDL` | `spice.test.ts` | Правильный синтаксис CDL |
| `generateSpectre` | `spice.test.ts` | Правильный синтаксис Spectre |
| `countFingers` | `analogDevices.test.ts` | Параллельные poly gates |
| `countMultipliers` | `analogDevices.test.ts` | Повторяющиеся паттерны |

### 6.2 Интеграционные тесты

| Тест | Описание |
|---|---|
| `die → devicelist → CDL` | Загрузить известную die, проверить количество и типы устройств |
| `LMV341 frontend` | Проверить extraction для простого op-amp diff pair |
| `FD6288 driver` | BiCMOS: NPN + PMOS/NMOS |
| `Hierarchical export` | Multi-cell → вложенные .SUBCKT |
| `Schematic render` | Визуальная проверка аналоговых символов |

### 6.3 Золотые файлы

```
testdata/analog/
├── simple_resistor/          # poly resistor, 2 contacts
│   ├── layers.json           # тестовые слои
│   ├── expected_device.json  # ожидаемый AnalogDevice
│   └── expected_cdl.cdl      # ожидаемый CDL
├── bjt_npn/                  # NPN транзистор
├── bjt_pnp/                  # PNP транзистор
├── jfet_n/                   # N-JFET
├── mos_fingered/             # MOS с 4 пальцами
├── diff_pair/                # Пара MOS + резисторная нагрузка
├── current_mirror/           # Токовое зеркало
├── capacitor_mim/            # MIM capacitor
├── opamp_simple/             # Простейший операционник (тест R1)
└── fd6288_driver/            # BiCMOS high-voltage driver
```

---

## R7 — Изменения в ML модуле (опционально, Phase 1+)

Если нужна ML-помощь в детекции:

```
1. Multi-class semantic segmentation (10+ классов):
   - poly, diffusion, nwell, metal1, metal2, contact, base, emitter
   - Требует: датасет с сегментированными фотографиями чипов
2. Object detection (YOLOv8 + rotation):
   - Device-level: BJT, Resistor, Capacitor как bounding boxes
   - Rotation-aware (BJT часто под углом)
3. Integration:
   - Python sidecar (ml/sidecar.py) расширить эндпоинтами
   - Node API проксирует предсказания
```

Для Phase 1 ML не обязателен — достаточно ручной аннотации слоёв + автоматической детекции на основе geometry.

---

## R8 — Roadmap и зависимость файлов

```
Phase 1.0 — Data model + device core (1-2 недели)
  shared/types.ts + analogDevices.ts (detect only)

Phase 1.1 — Geometry parameter computation (1 неделя)
  computeMOSParams, computeBJTParams, computeResistorParams...

Phase 1.2 — SPICE/CDL export (1 неделя)
  backend export, frontend spice.ts

Phase 1.3 — Frontend annotation tools (2 недели)
  Новые слои, device palette, parameter editor

Phase 1.4 — Integration + testing (1-2 недели)
  End-to-end: annotate → detect → param → export
  Золотые файлы, сквозные тесты

Phase 1.5 — Hierarchical export + Cadence import script (1 неделя)
  SKILL-скрипты для CI/CV
  .SUBCKT иерархия

Итого Phase 1: ≈ 6-8 недель (один инженер full-time)
```

---

## R8b — Многослойные изображения (Overlay Layers)

### Текущая реализация (MVP, 2026-06-13)

Для работы с множеством изображений кристалла (например, диффузионные слои/металл
как отдельные растры) реализована система overlay-слоёв с загрузкой статичных
PNG/JPEG/GIF/WebP через GUI.

Архитектура:
- **Бэкенд** (`/api/overlay-images/*`): простые file endpoints (list, serve, upload)
- **Фронтенд**: `OverlayImageLayer` — Layer, рендерящий HTMLImageElement с клиппингом
  по границам тайла; opacity compositing через scratch canvas
- **UI**: секция "Overlay Layers" в OutlineTree с file picker, загрузкой с сервера,
  переключателем видимости и слайдером прозрачности

**Ограничение:** изображения хранятся и грузятся целиком (не тилованные). Это
приемлемо для аналоговых БИС — сканы кристаллов обычно **≤300 MB**.

### План на будущее — Tile-сервер для произвольных изображений

Хотим вынести тилование из монолитной модели Die в независимые Image-сущности:

```
/image
  ├── POST /images/import — загрузить + протайловать
  ├── GET /images — список изображений
  ├── GET /images/:id — метаданные (width, height, levels, tileSize)
  └── GET /images/:id/tiles/:z/:x/:y — отдача тайла
```

Это позволит:
- Загружать N изображений, каждое со своей mipmap-пирамидой
- Рендерить их как слои с производительностью тайлов (а не full-image)
- Работать с гигапиксельными изображениями (полные дампы кристаллов)

Когда делать: когда появятся реальные потребности в 5+ слоях или сканах >300 MB.
Пока OverlayImageLayer покрывает MVP.

---

## Ключевые технические решения

1. **Аналоговые устройства — не заменяют, а дополняют CMOS pipeline.**
   - `extractCell` продолжает работать для цифровых блоков
   - `detectDevices` работает параллельно для аналоговых областей

2. **Параметры вычисляются строго из геометрии + scaling factor.**
   - Никаких guess-значений
   - Пользователь может переопределить sheetR, capDensity, модели

3. **CDL/Spectre → Cadence через SKILL/import.**
   - `include "models.scs"` или `cdl in <file>`
   - Возможность сгенерировать SKILL-скрипт для `dbOpenCellViewByType`

4. **Metal stack не ограничен.**
   - metal1..6 (и больше) — просто ещё один слой
   - Порядок для via-детекции: via1 = metal1↔metal2, via2 = metal2↔metal3, …

5. **Множители и пальцы детектируются по топологии.**
   - Fingers: N параллельных одинаковых сегментов с общими контактами
   - Multipliers: N повторяющихся ячеек с идентичной connectivity
