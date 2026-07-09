# LVS — Layout vs Schematic comparison

**Branch:** `analog-re-wip`
**Engine:** `vyges-lvs` v0.1.11 (Rust, Apache 2.0)

## Current status (MVP — Jul 9)

| Feature | Status |
|---------|--------|
| vyges-lvs integrated | ✅ built from source, installed via `cargo install` |
| Backend endpoint `POST /lvs/compare` | ✅ normalizes, spawns vyges-lvs, returns JSON + text report |
| Frontend tab "LVS" in Analog Netlist page | ✅ Alt+4, click-to-switch |
| Layout netlist auto-filled from extraction | ✅ |
| Schematic netlist paste area | ✅ |
| Compare button + loading state | ✅ |
| MATCH/MISMATCH verdict badge | ✅ |
| Device-diff table (post-processed, 4 categories) | ✅ L-only / S-only / Type Mismatch / Param + Conn |
| Net connection diff table | ✅ direct netlist parsing (cascade-free) |
| Full vyges-lvs text report (collapsible) | ✅ |
| vyges-lvs auto-detect (PATH, ~/.cargo/bin) | ✅ |
| Error handling (ENOENT, timeout, SPICE parse error) | ✅ |
| Copy report button | ✅ |

**Verdict correctness:** proven — name-independent graph isomorphism (1-WL + bijection).
A renamed/reordered netlist that is structurally identical returns MATCH (verified: 100 devices,
all names changed → MATCH). See `docs/reference/netlists/report.txt` for full validation.

---

## Pipeline

```
Layout netlist ─┐                    ┌─ vyges-lvs ──┬─ raw JSON ──┐
                 ├─ normalize ── .lvs ┤              │             │
Schematic netlist┘                    └─ vyges-lvs ──┴─ text ──────┤
                                                                   │
                          ┌────────────────────────────────────────┘
                          ↓
                   buildDiffs() — 5-phase post-processor
                   (LVSComparePanel.tsx)
```

### Step 1: Normalization (`backend/src/lib/normalizeNetlist.ts`)

Applied identically to both sides before vyges-lvs.

1. Strip simulation directives (`simulator lang`, `tran`, `save`, `include`, etc.)
2. **Preserve `.GLOBAL`** net declarations (from input or via `globalNets` param)
3. Strip existing `.SUBCKT`/`.ENDS` boundaries (flat output)
4. Preserve device instances and `parameters`/`.PARAM`
5. Wrap both sides in matching `.SUBCKT ${name}` / `.ENDS ${name}` (no port decl)

`.GLOBAL` nets (always `0`, plus `GND`/`VCC`/`VDD`/`VSS` auto-detected from both netlists)
are emitted before `.SUBCKT` so vyges-lvs anchors supply nets and prevents 1-WL
cascade across power rails.

### Step 2: vyges-lvs matching

vyges-lvs runs with `--json` and as text report:
- Parses both sides as SPICE graphs (name-independent 1-WL colour refinement)
- Confirms match with explicit device/net bijection
- Returns `unbalanced[]` (colour classes that didn't balance) and `property_diffs[]`
  (matched devices with different params — `r=`, `w=`, `l=`, etc.)

**Known vyges-lvs v0.1.11 limitations:**
- 1-WL cascade: a single connectivity change propagates colour through the entire
  connected component → MANY false positives in `unbalanced[]`
- Does NOT report `m=` (BJT multiplier) or `c=` (capacitor value) in `property_diffs[]`
- Does NOT detect extra devices with identical topology (R811 parallel to R81)
- Does NOT distinguish device types (npn vs pnp) — matches them as "same"

### Step 3: Post-processing — buildDiffs() 5-phase filter

`frontend/src/components/netlist/LVSComparePanel.tsx:buildDiffs()`

Takes raw vyges-lvs JSON + original netlist lines and produces a clean diff list:

| Phase | What | Technique |
|-------|------|-----------|
| **1** | Collect unbalanced | Parse `unbalanced[]` device names |
| **2a** | Name-based check | For each unbalanced name: if same-name device exists on other side, compare lines. Identical → cascade artifact (drop). Different → classify as type/param/conn mismatch |
| **2b** | Signature match | For remaining L-only/S-only: group by **signature** (`modelType:sorted(terminals)`). Match by-signature across sides → cascade artifact. Count mismatch → extra devices flagged. **Catches name variants** (Q37 vs Q370, R80 vs R800) |
| **3** | Type mismatch | For devices vyges-lvs matched but with different model type (npn vs pnp) |
| **4** | Parameter scan | For all matched devices: if same type + same terminals but different params (`m=`, `c=`, `r=`) → Param Changed. Catches what vyges-lvs misses in `property_diffs[]` |

**Signature** = `modelType:sortedTerminals` — e.g. `npn:0,GND,Net_19,Net_54` or
`resistor:GND,Net_127`. Completely name-independent; derived purely from device
line content.

### Step 4: Display

- Summary bar: device count, diff count per category, net count delta, iteration count
- Device Diffs: grouped as **L-only** / **S-only** / **Device Type Mismatch** /
  **Param Changed** / **Connection Mismatch** with side-by-side line comparison
- Net Connection Diffs: cascade-free (computed by direct netlist line parsing,
  not from vyges-lvs unbalanced)
- Collapsible raw vyges-lvs text report
- Copy Report button

---

## Validation results

Two test series with 5 intentional errors each (see `docs/reference/netlists/report.txt`):

### Series 1 — Structural + param errors

| # | Error | Expected | Result |
|---|-------|----------|--------|
| 1 | Q1 npn → pnp | Type Mismatch | ✅ Found |
| 2 | R7 13Ω → 19.5Ω | Param Changed | ✅ Found |
| 3 | R8/R9 swapped | Connection Mismatch | ✅ Found |
| 4 | R811 added (parallel) | Only in Schematic | ❌ Missed (vyges-lvs v0.1.11 limitation — parallel combine) |
| 5 | C1 34570f → 40000f | Param Changed | ✅ Found |

False positives: 23 → **0** after buildDiffs.

### Series 2 — Param + deletion + addition errors

| # | Error | Expected | Result |
|---|-------|----------|--------|
| 1 | Q1 m=3.6 → 5.0 | Param Changed | ✅ Found (Phase 4) |
| 2 | R7 deleted | Only in Layout | ✅ Found |
| 3 | D1 pins swapped | Connection Mismatch | ✅ Found |
| 4 | C1 c=-100f | Param Changed | ✅ Found (Phase 4) |
| 5 | Q33 added | Only in Schematic | ✅ Found |

False positives: **0**.

**Overall: 9/10 detected.** The only blind spot (#4 in series 1) is vyges-lvs's
parallel-resistor combination: vyges-lvs combines parallel resistors into a single
virtual device before matching, so an extra parallel resistor (R811) is absorbed
rather than flagged. This requires a vyges-lvs engine change to fix.

---

## Known remaining limitations

### vyges-lvs v0.1.11 engine limits

| Limitation | Impact | Workaround |
|-----------|--------|-----------|
| 1-WL cascade | → false positives in unbalanced[] | buildDiffs Phase 2a/2b filters by line + signature |
| No BJT m= / C c= in property_diffs | → param changes missed | buildDiffs Phase 4 scans all matched devices |
| No npn vs pnp distinction | → type changes missed | buildDiffs Phase 3 catches it |
| Parallel combine loses extra devices | → R811 can't be detected | requires engine change |
| Renamed devices (Q37→Q370) cascade | → different colours → spurious L/S-only | buildDiffs Phase 2b matches by signature |

### What buildDiffs CAN'T fix

- R811-style extras (parallel combine in vyges-lvs absorbs them before matching)
- Genuine graph-isomorphic differences (two circuits with identical topology but
  different parameters — only vyges-lvs's `property_diffs[]` catches `r=`)

---

## Netlist normalizer

`backend/src/lib/normalizeNetlist.ts` — Spectre/CDL normalizer for vyges-lvs.

**What it does:**
1. Strips simulation directives (`simulator lang`, `tran`, `dc`, `save`, `global`, etc.)
2. Preserves `.GLOBAL` net declarations from input (or accepts via `globalNets` param)
3. Strips existing `.subckt`/`.ends` boundaries (flat output)
4. Preserves device instances and `parameters` / `.PARAM`
5. Wraps everything in identical `.SUBCKT ${name}` / `.ENDS ${name}` (no ports)

**Global net detection** (`backend/src/api/lvs.ts:extractGlobals()`):
- Always adds `0` (universal SPICE ground)
- Parses explicit `.GLOBAL` directives from both sides
- Auto-detects common power nets (`GND`, `VCC`, `VDD`, `VSS`, `VEE`, `VBB`,
  `VSUB`, `AVDD`, `AVSS`, `DVDD`, `DVSS`) by scanning standalone tokens in
  both netlists
- All detected globals are merged and applied identically to both sides

---

## vyges-lvs binary

- **Binary location:** `~/.cargo/bin/vyges-lvs.exe` (2 MB)
- **Source:** `cargo install --git https://github.com/vyges-tools/lvs` (Apache 2.0)
- **Docs:** https://docs.vyges.com/engines/lvs.html
- **Version:** v0.1.11

## Setup on a fresh machine

### Windows

```powershell
scripts\setup-lvs.ps1
```

Installs Rust via rustup if missing, then builds vyges-lvs from source.

### Linux / macOS

```bash
chmod +x scripts/setup-lvs.sh && ./scripts/setup-lvs.sh
```

Downloads prebuilt binary (Linux x86_64/aarch64, macOS aarch64) from GitHub releases.
