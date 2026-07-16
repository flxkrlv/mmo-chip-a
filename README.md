# mmo-chip — analog-re-wip

> **ENG** | [**RU**](README.ru.md)

**A fork of [mmo-chip](https://github.com/giulioz/mmo-chip) for reverse engineering analog and mixed-signal ICs.**  
Extends the original digital CMOS pipeline to **BJTs, BiCMOS, resistors, capacitors, diodes** — transistor-level extraction with SPICE/CDL/Spectre netlist export.

## Acknowledgments

Many thanks to the developers of the original [mmo-chip](https://github.com/giulioz/mmo-chip) for the clean architecture and clear interfaces that made this analog extension possible.

The original CMOS pipeline (standard cells, logic, Verilog) is **untouched** — analog extraction works as an add-on.

## Quick Start

```sh
# Node ≥ 20
npm install
npm run dev               # backend + frontend + ML sidecar
# or individually:
npm run dev -w backend    # http://localhost:3001
npm run dev -w frontend   # http://localhost:5173

# Tests:
npm test
```

---

## Supported Devices

| Device | Detection | Parameters |
|--------|-----------|------------|
| **NMOS / PMOS** | Well-based via Clipper2 (diffusion split at poly gates). No markers needed | W, L, fingers, M. Bulk: contact on well → netId; absent → VDD/GND |
| **NPN** | Marker `npn_id` + collector/base/emitter | AE (base∩emitter overlap), M |
| **PNP / LPnp** | Marker `pnp_id` | AE, PE (emitter perimeter), M |
| **Diode** | Marker `diode_id` **or** NPN/PNP without collector | Area (AE from base-emitter overlap) |
| **Resistor** | Geometric: body (poly/base/emitter/hsr/film) → ME1 → contacts → PLUS/MINUS groups. No marker needed | Ω or squares × Rₛ. Body layers: poly-R, p-base, n+, HSR, thin film |
| **Capacitor** | Marker `cap_id` (overlap area) | fF = area × density (needs verification) |

---

## How to Draw Devices

All layers are drawn in **Cell RE** with the corresponding tool (rect/polygon/polyline).

### MOS

| Layer | Purpose |
|-------|---------|
| `nwell` / `pwell` | Well — nwell→PMOS, pwell→NMOS |
| `diffusion` | Source + drain region |
| `polysilicon` | Gate(s) crossing diffusion |

1. Draw well → diffusion inside well → polysilicon across diffusion  
2. **Bulk:** place `cont` (contact) on well **outside** diffusion/poly. If absent → VDD (PMOS) / GND (NMOS)  
3. **Multi-finger:** Clipper2 splits diffusion between gates → N separate MOS  
4. **Metal-connected D/S:** drain/source connected by ME1 (or ME2+via) inside the cell get a shared netId  

> Detailed pipeline: [`docs/mos_detection.md`](docs/mos_detection.md)

### BJT

| Layer | Purpose |
|-------|---------|
| `npn_id` / `pnp_id` | Bounding box |
| `collector` / `base` / `emitter` | Device regions |

1. Draw bounding box → layers inside → `cont` on each layer (terminals matched automatically)  
2. **Multi-emitter:** multiple emitters → summed AE, multiplier M = count  
3. **PNP/LPnp:** PE = emitter perimeter (primary parameter)

### Diode

**Recommended:** draw NPN/PNP without collector → automatic diode. Base = anode, emitter = cathode.

### Resistor

| Layer | Purpose |
|-------|---------|
| `poly` / `base` / `emitter` / `hsr` / `film` | Body (choose one) |
| `contact` | Contacts (min 2) |

1. Select **body layer** → draw with **polyline tool** (`L`) — orthogonal snap, width set in toolbar (0–200 µm)  
2. Draw ME1 overlapping body → place 2+ contacts (become PLUS/MINUS)  
3. Click any segment → entire chain selected → edit width in right panel  
4. Opacity slider helps align width over the image  

> Sheet R₀: configurable in GUI (poly=25, hsr=1500, pb=200, npl=5, film=500 Ω/□)

### Capacitor

Draw `cap_id` (bbox) — PLUS/MINUS both on `contact`. Not tested.

---

## Metal Stack (configurable multi-layer)

Die viewer supports 1–6 metal layers (ME1–ME6) with corresponding vias (VIA12–VIA56).

### Configuration

**Net Settings** (gear icon next to "Nets") → **Metal layers** select (1–6). Saved per-project, no reload needed. Default: 6 metals.

| UI element | Adapts to |
|------------|-----------|
| Layer color pickers | Only configured metals |
| Wire/Via toolbar chips | Only configured metals/vias |
| Hotkeys 1..6 / Alt+1..5 | Range limited to configured stack |
| E/Q via up/down | Picks correct via from stack |
| W cycle | Cycles only through configured metals |
| ProblemNavigator | Checks dangling vias against correct metal pair |

### Per-layer colors

Custom wire and via colors in Net Settings / Via Settings popovers. Persisted per-project.

### Via labels

At zoom ≥ 8×, each via shows its type (VIA12, VIA56…) centred on the circle — black background, white bold text. Toggle: **VIA LABEL** in right panel.

---

## Die Viewer Features

### Wire Tool

- **Layer switching:** `W` activates wire tool; repeat cycles through metal stack (ME1→…→ME6→ME1)  
- **Via placement (E/Q):** places via at snapped wire-end preview (default). Toggle **Via: cursor / wire-end** in toolbar for raw cursor mode  
- **Cross-layer snap prevention:** wires of different metals only connect through a matching via annotation  
- **AutoVia (checkbox):** clicking an adjacent-metal vertex auto-places the via annotation  
- **Via tool (O):** toggles via placement; repeat cycles via types (VIA12→VIA23→…)  
- Device contacts connect to **ME1 only** — ME2+ requires a via

### ProblemNavigator

Unified issue panel (`IssuesChip` button). Checks: connectivity (unconnected terminals), wiring (stubs), vias (dangling per metal pair), I/O pin mismatches, overlaps (same-metal), electrical warnings.

> [`docs/problem-navigator.md`](docs/problem-navigator.md)

### Cell Operations

| Action | How |
|--------|-----|
| **Copy / Paste** | `Ctrl+C` / `Ctrl+V` or right-click context menu |
| **Make Unique** | `Shift+U` or right-click — detach cell from shared type, edit independently |
| **Cell Relationship** | Toggle **CELL REL** in right panel — highlight all same-type cells, dim others |

### Device Registry

Each device gets a stable UUID from `kind + position + subType`. Renames and parameter overrides persist across re-extraction and sessions.

### Layer Reference (Cell RE)

| Layer | Group |
|-------|-------|
| `diffusion` / `polysilicon` / `nwell` / `pwell` | MOS |
| `collector` / `base` / `emitter` | BJT |
| `hsr` / `film` | Resistors |
| `npn_id` / `pnp_id` / `res_id` / `cap_id` | Markers |
| `metal1`–`metal6` | Metallization |
| `via1`–`via5` | Via layers |
| `contact` | Contacts |

### Miscellaneous

- **Net ID overlay:** human-readable net names on die viewer (toggle in side panel). VDD/GND hidden  
- **Layout comments:** clickable annotation icons with text, author, replies (WebSocket sync)

---

## Schematic Viewer (netlist2svg)

Transistor-level schematics and functional block diagrams from SPICE netlists.

- **Analog mode:** full schematic with all detected devices  
- **Functional mode:** floorplan regions as blocks with I/O ports  
- ELK layout, pan/zoom, device tooltips, power net coloring (VDD red, GND blue)  
- Export: SVG, PNG (2×), Yosys JSON

---

## LVS (Layout vs Schematic)

Compare extracted netlist against a hand-drawn schematic.

| Engine | When |
|--------|------|
| **name-based** | Device names match (Q1, M2, R5…) |
| **vyges-lvs** | Name-independent topology comparison (netgen-like) |

Available on the Analog Netlist page (`Alt+4`).

---

## Floorplan Regions

Rectangular/polygonal regions for marking analog blocks. Features: color, name, port aliases, reservation, global net rename, boundary port dots.

| Key | Action |
|-----|--------|
| `H` | Activate tool |
| `Ctrl+Shift+H` | Toggle overlay |

---

## Project Export / Import

```http
POST /api/dies/:dieId/export-project    # JSON: light (annotations) / full (+ images)
POST /api/dies/import-project           # Conflict handling (overwrite/skip)
POST /api/dies/:dieId/rename            # Rename die
```

Full export preserves original + overlay images. Preferences exported from localStorage.

---

## Hotkeys

| Key | Action |
|-----|--------|
| `S` | Select |
| `W` | Wire tool (repeat → cycle metal layer) |
| `E` | Via up (wire-end preview, switches to next metal) |
| `Q` | Via down (wire-end preview, switches to prev metal) |
| `B` | Multi-wire / Bus |
| `O` | Via tool (repeat → cycle via type) |
| `K` | Ruler / Measurement |
| `R` | Add Cell |
| `P` | I/O Point |
| `F` | Fit to Screen / Pan |
| `H` | Floorplan tool |
| `+` / `=` | Zoom in |
| `-` | Zoom out |
| `1` … `6` | Select metal ME1 … ME6 |
| `Alt+1` … `Alt+5` | Select via VIA12 … VIA56 |
| `Shift+1` … `Shift+5` | Navigate tabs: Die / Merge / RE Cell / Code / Analog Netlist |
| `Ctrl+Z` / `⌘Z` | Undo |
| `Ctrl+Shift+Z` / `⌘⇧Z` | Redo |
| `Ctrl+C` / `⌘C` | Copy cell / shape |
| `Ctrl+V` / `⌘V` | Paste |
| `Shift+U` | Make Unique (cell) |
| Space (hold) | Temporary pan |

### Cell RE

| Key | Tool |
|-----|------|
| `R` | Rect |
| `P` | Polygon |
| `O` | Point / via |
| `L` | Polyline (resistor) |

### Overlay Images

| Key | Action |
|-----|--------|
| `Ctrl+Shift+B` | Toggle base image |
| `]` / `[` | Next / previous overlay layer only |
| `Ctrl+Shift+1..8` | Show only overlay layer N |

### Analog Netlist

| Key | Action |
|-----|--------|
| `G` | Toggle Code / Graph |
| `H` | Hierarchical on/off |
| `R` | Resistor format (Ω / sq·Rs) |
| `M` | Device matching on/off |

### Merge Cells

| Key | Mode |
|-----|------|
| `Alt+1`…`5` | Overlay / Side-by-side / Diff / Specimen / Candidate |

---

## What's Not Done Yet (priority)

- **DMOS, Schottky diode, VPNP, JFET** — no detection or markers  
- **Wire matching** — tolerance = contact size × 0.5; dense routing may false-positive  
- **Polyline post-edit** — stretch/reshape (only redraw from scratch)  
- **Overlay image serialization** into JSON (currently static)  
- **Hierarchical netlist + floorplan:** needs real-world testing (alias collision, rename speed)

---

## ⚠️ Disclaimer

**Still alpha / WIP.** Only unit tests for extraction (22 tests: 18 pass, 4 skip). No e2e tests, no tests for overlay, wire matching, SPICE export, or cross-tab navigation.



---

## Repository Structure

```
frontend/     Vite + React + TypeScript — die viewer, cell RE, analog netlist
backend/      Node + TypeScript API — import, tiling, JSON persistence, WebSocket
shared/       Shared TypeScript types
ml/           Python U-Net (optional, assisted annotation)
docs/
  analog-devices.md           ← analog device detection docs
  mos_detection.md            ← MOS pipeline (Clipper2, poly gate, metal merge)
  netlist_warnings.md         ← SPICE/CDL warnings reference
  problem-navigator.md        ← ProblemNavigator details
  lvs-plan.md                 ← LVS architecture
```

Key extraction files: `dieWideAnalog.ts`, `simpleAnalog.ts`, `spice.ts` (`frontend/src/`).
