# План: изоляция бага vyges-lvs v0.1.12

## Установленные факты

- 22 устройства (lm2937 без C16) → A-only=0 ✅
- 22 + R на **новых изолированных** net → A-only=0 ✅
- 22 + R на **существующих** net (Vcc, Vminus, Vbias, inm) → A-only=23 ❌
- 22 + R на **GLOBAL 0** → A-only=0 ✅
- 22 + 2R на **новых net** → 24 total, A-only=0 ✅

## Тесты для подтверждения (делать в implement mode)

### A. Разные типы устройств на Vcc-Vminus
Добавить к 22 устройствам по одному устройству разных типов:

| Тест | Добавка | Ожидание |
|------|---------|----------|
| A1 | R Vcc Vminus 1k | ❌ A-only=23 |
| A2 | C Vcc Vminus 1p | ❌ A-only=23 |
| A3 | L Vcc Vminus 1n | ❌ A-only=23 |
| A4 | D Vcc Vminus diode | ❌ A-only=23 |
| A5 | Q Vcc Vminus Vbias npn | ❌ A-only=23 |
| A6 | M d g s b nmos (на Vcc,Vminus,Vbias,0) | ❌ A-only=23 |

### B. Разные паттерны подключения
| Тест | layout | schematic | Ожидание |
|------|--------|-----------|----------|
| B1 | R Vcc Vminus 1k | R Vcc Vminus 1k | ❌ |
| B2 | R Vcc 0 1k | R Vcc 0 1k | ❓ |
| B3 | R Vcc new_net 1k | R Vcc new_net 1k | ❌ |
| B4 | R new1 new2 1k | R new1 new2 1k | ✅ |
| B5 | R new1 Vcc 1k | R new1 Vcc 1k | ❌ |
| B6 | R 0 Vcc 1k | R 0 Vcc 1k | ❓ |

### C. Поиск точного порога
Бинарный поиск минимального количества устройств из lm2937,
при котором добавление R на Vcc-Vminus ломает matching.

### D. 22 простых R + 1 на Vcc-Vminus
Если ломается → проблема в количестве, не в структуре.
Если НЕ ломается → проблема в сложности графа (loops).

## Баг-репорт

```
vyges-lvs v0.1.12 — colour-refinement fails on graphs with ≥23 vertices
when any additional edge connects to an existing non-global net

Environment: vyges-lvs 0.1.12 (d067e81-dirty), Windows

Description:
When comparing two isomorphic netlists where both sides have ≥23 devices,
adding any device whose terminals include at least one existing non-global
net causes the colour-refinement algorithm to fail — ALL devices on both
sides are reported as unmatched (0 pairs matched).

The algorithm succeeds when:
- ≤22 devices (regardless of graph complexity)
- The additional device connects only to NEW (previously unused) nets
- The additional device connects only to GLOBAL nets (e.g., 0)

The algorithm fails when:
- ≥23 devices AND the additional device connects to any existing non-GLOBAL net
- Regardless of device type (R, C, L, Q, D, M — all tested)
- Regardless of the specific net name

Minimal reproduction:
1. Take any 22-device SPICE netlist with non-trivial topology
2. Add any 23rd device whose terminals include existing non-global nets
3. Run `vyges-lvs run compare.lvs --json`
4. Observe: matched=false, all 23 devices as A-only/B-only

Expected: matched=true (circuits are isomorphic), property diffs if values differ
Actual: matched=false, 0 device pairs matched

Root cause: limitation in the graph colour-refinement algorithm when the
graph reaches a certain complexity threshold with non-global edges.
```
