# LVS Patterns — Calibre Reference

## Источник

Правила из `docs/lvs_rules_examples/bjt40_rules_v1.rul` (BJT40, 200 Ω/sq p-base)
и `docs/lvs_rules_examples/WB40.lvs` (3µm 40V bipolar).

**Не пушить на гит.**

---

## 1. Резистор: детект и W/L извлечение

### Calibre (bjt40_rules_v1.rul, p_base)

```calibre
// 1. Найти тело: p_base без NPN/PNP зон, minimum 2 contacts
Total_res1 = ((NOT INTERACT (p_base1 INTERACT N_skrit1) hot_res)
              NOT INTERACT cap_id1) NOT INTERACT dio_id1
Total_res2 = (NOT INTERACT Total_res1 E_pnp3) INTERACT cont1 > 1
Total_res_cc1 = Total_res2 AND cont1           // контакты = терминалы
Total_res_pin = SIZE Total_res_cc1 BY 2.0       // расширение под pad
Total_res = (Total_res2 NOT Total_res_pin)      // тело = body - pads

// 2. W/L извлечение
Corners = BENDS(Total_res)
Widht = PERIMETER_COINCIDE(Total_res, Total_res_pin) / 2   // ширина на стыке
ln_tmp = PERIMETER(Total_res) / 2                           // полупериметр
Lenght = ln_tmp - Corners*Widht - Widht + "end_correction_res"
Square = (Lenght / Widht) + 0.55 * Corners
R = pb_res_square * Square                                   // 200 Ω/sq
```

### MMO Chip (simpleAnalog.ts, polyline mode)

```typescript
W = lines[0].width * umPerPx                      // номинальная ширина линии
L = sum(segment_lengths) * umPerPx                 // centreline
squares = (totalL - corners * width) / width + 0.55 * corners
R_ohms = squares * effectiveSheetR(type, config)   // теперь через resistorDefaults
```

### Что совпадает

- `0.55 * corners` — один в один
- `squares = L/W + 0.55*corners` — эквивалентная формула
- Corner counting: Calibre BENDS() ≈ наш `angle diff > π/6`

### Что различается

| Аспект | Calibre | MMO Chip | Impact |
|--------|---------|----------|--------|
| **Rsq per type** | `pb=200`, `poly=500`, `il=1500` | `resistorDefaults.ts` уже есть (25/200/1500/5/500) | ✅ **Новый фикс** — `effectiveSheetR()` |
| **Width** | `PERIMETER_COINCIDE(body, pad)/2` | `line.width` (номинал) | Близко для poly, ~0-10% для base |
| **End correction** | `+ "end_correction_res"` (4µm) | нет | Недооценка L для base |
| **Lateral diffusion** | `koef_diffusion * xj_base * 2` | нет | Отсутствует для имплантированных |
| **Детект** | `cont1 > 1` (геометрический) | marker layer | Не найдёт без маркера |
| **Bbox fallback** | polygon outline | max/min | **Ломается** для L-образных |

### Известная проблема: atan2 wrap в corner detection

В `extractMarkedDevices()`:

```typescript
const angle = Math.atan2(dy, dx);
if (prevAngle != null && Math.abs(angle - prevAngle) > Math.PI/6) corners++;
```

`Math.atan2` возвращает `[-π, π]`. При переходе через -π/π boundary (сегмент влево ≈ π,
следующий чуть выше ≈ -π + ε) разница ~2π вместо ε.

Фикс — нормализация:
```typescript
let diff = angle - prevAngle;
if (diff > Math.PI) diff -= 2 * Math.PI;
if (diff < -Math.PI) diff += 2 * Math.PI;
if (Math.abs(diff) > Math.PI/6) corners++;
```

На практике проявляется редко — только если сегмент идёт строго влево.

---

## 2. LVS exclusion pattern (well contact)

**Calibre:**
```calibre
bulk_p_cc = ((((bulk_p NOT B_npn) NOT C_pnp) NOT E_pnp) AND p_base1) AND cont1
```
— контакт засчитывается только после вычитания всех известных device-зон.

**Мы уже реализовали:**
```typescript
// simpleAnalog.ts — detectMOSFromLayers()
const onDiff = overlapArea(contact, body, diffusion) > 0;
const onPoly = overlapArea(contact, body, polysilicon) > 0;
if (onDiff || onPoly) continue; // не well контакт
```

---

## 3. Exclusion-зоны для однозначной классификации

**Calibre (bjt40_rules_v1.rul):**
```calibre
E_npn1 = (INTERACT (p_base1 INTERACT N_skrit1) n_emit1)
         NOT INTERACT cap_id1
         NOT INTERACT dio_id1
```

Один слой `n_emit1` может быть BJT emitter, capacitor plate или diode cathode.
Calibre использует **маркерные REC-слои**: `NPN_REC`, `CAP_REC`, `DIO_REC` —
исключающие пересечения.

**У нас** пока детект только по маркерным слоям — коллизии нет. Если добавим
безмаркерный детект — нужно будет внедрить приоритеты/исключения.

---

## 4. Multi-ratio устройства (WB40.lvs)

```calibre
lpnp_e_size = SIZE lpnp_e BY 10.5            // emitter расширен на 10.5
l1 = (lpnp_e_size INTERACT lpnp_c == 1)      // 1 collector сегмент
l2 = (lpnp_e_size INTERACT lpnp_c == 2)      // 2 collector сегмента → ratio 2
l3 = (lpnp_c INTERACT (lpnp_e_size INTERACT lpnp_c == 3))  // ratio 3
```

Количество пересечений расширенного emitter с collector → разные device names
(`lpc10`, `lppcc10`, `lppower`). Аналог нашего multi-finger MOS split, но для BJT.

---

## 5. SCONNECT (soft PN junction) — parasitic detection

```calibre
SCONNECT em_con BN BY bnem     // emitter → buried N+ через PN
LVS SOFTCHK BN UPPER ALL       // проверить все BN области
```

Soft connect != CONNECT — это соединение через PN-переход, а не через контакт/металл.
Используется для **parasitic extraction** (паразитные диоды между tub-ами).
Для MMO Chip не актуально (нет PEX фазы).

---

## 6. Bulk fallback (PNP без коллекторного контакта)

```calibre
// bjt40 — PNP без коллектора
C_pnpG = (((C_pnp22 NOT E_pnpG) NOT INTERACT cont1) INTERACT bulk_p)
CONNECT bulk_p C_pnp22
```
Коллектор = bulk (подложка). Аналог нашего `bulkNetId = -2` / `@globalgroundnet@`.

---

## 7. Resistor types by sheet resistivity

| Type | Rsq (bjt40) | Rsq (our default) | Notes |
|------|-------------|-------------------|-------|
| poly (polysilicon) | 500 | **25** | Наш poly ~20x ниже — проверить процесс |
| pb (p base) | 200 | 200 | ✅ |
| hsr (ion implant) | — | 1500 | — |
| npl (n+ emitter) | — | **5** | — |
| film (thin film) | — | 500 | — |
| il (ion implanted) | **1500** | — | Missing in our types? |
| pc (pinched base) | ~10080 | — | Not generic enough |

Примечание: Rsq poly в bjt40 = 500, у нас = 25. Разные процессы — для BJT40 это
высокоомный поликремний, для типичного CMOS — сильнолегированный (25-50).
Нужно будет параметризовать через SpiceConfig.

---

## 8. PNP без N_skirt (power PNP, bjt40_rules_v1.rul)

```calibre
E_lpnp = (pnp_id1 AND p_base1) NOT INTERACT E_pnp
C_lpnp1 = SIZE E_lpnp BY 16
C_lpnp = ((C_lpnp1 NOT E_lpnp) NOT B_lpnp) NOT INTERACT cont1
CONNECT bulk C_lpnp
```
Power PNP — collector connected to bulk, uses `pnp_id1` marker + `p_base1`.
No buried layer (`N_skrit1`). Коллектор = подложка, контакта нет.
