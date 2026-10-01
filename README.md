# mmo-chip — analog-re-wip

> **ENG** | [**RU**](README.ru.md)

**A fork of [mmo-chip](https://github.com/giulioz/mmo-chip) for reverse engineering analog and mixed-signal ICs.**  
Extends the original digital CMOS pipeline to **BJTs, BiCMOS, resistors, capacitors, diodes** — transistor-level extraction with SPICE/CDL/Spectre netlist export.

## What's different in this fork ([lytex/mmo-chip](https://github.com/lytex/mmo-chip))

This fork tracks [flxkrlv/mmo-chip-a](https://github.com/flxkrlv/mmo-chip-a) (itself a fork of [giulioz/mmo-chip](https://github.com/giulioz/mmo-chip)) and adds the following on top. Everything else in this README applies to all three.

### Large images

- **Pyramidal TIFF import** — dies and overlays can be imported as pyramidal / tiled TIFF (libvips `tiffsave --pyramid`, SubIFD/OME-TIFF, SVS). Coarse zoom levels are cut from the matching stored resolution and full-resolution tiles only decode the region they cover, so tiling huge mosaics is far faster than from PNG.
- **Resumable tiling** — background tile generation resumes after a backend restart, only renders tiles missing on disk, and the progress counter is seeded from the tiles already present (no more "tiling" again for an already-tiled die).

### Nets and wires

- **Per-net colors** — assign colors to one or many nets at once from the Outline Tree; a switch flips between custom net colors and per-layer colors without losing the assignments.
- **Per-net / per-cell visibility** — hide individual nets or cells while keeping the global visibility toggles.
- **Net width per die** — wire width is stored per die instead of globally.
- **Multi-wire (`B`) with multiple turning points** — route a bus through several bends; staggered start points end on a common aligned front.
- **Hold to zoom** — hold the pointer for 2 s on a net (in the tree or on the canvas) to zoom to it.
- **Double-click to rename** nets, cells and I/O pins directly on the canvas.
- Toggleable crosses on net vertices.

### Cells and I/O points

- **Resize handles** — resize cells after placing them; resizing applies to all cells of the same type, with correct transforms.
- **Cell type colors** and cell type shown on hover.
- **Draggable I/O points** — I/O points are always visible; their names toggle with a switch.
- **Hover info** — the bottom panel shows details of the object under the cursor.

### Merge Cells

- **Multi overlay** — stack every cell of the same type into a single overlaid image to spot outliers.
- Faster cell thumbnails by reusing the die viewer's tiles.
- Fixed undo/redo history.

### Floorplans

- **Edit geometry after drawing** — move/reshape rectangle and polygon regions after creation.
- **Undo/redo** for floorplan regions (and for layout comments).
- Custom color picker and per-region visibility in the floorplan hierarchy.
- `Esc` exits the floorplan tool; the first click already places a point; `Space+H` toggles floorplans.

### Other

- **Editable code pages** — the generated netlist on the Code / Analog Netlist pages can be edited by hand and re-parsed into the schematic.
- **Toggleable rulers** — show/hide rulers from the Outline Tree.
- Scrollable popovers.
- Compatibility with older `data/` formats.

## Acknowledgments

Many thanks to the developers of the original [mmo-chip](https://github.com/giulioz/mmo-chip) and fork [flxkrlv/mmo-chip-a](https://github.com/flxkrlv/mmo-chip-a) for the clean architecture and clear interfaces that made this analog extension possible.

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

### Screenshot

`Ctrl+Shift+S` exports the current die view as PNG (4K resolution, composited with all overlay layers including analog device highlights). Download button also in SubBar.

### Search

`Ctrl+F` opens a filter input in the Outline Tree. Type to filter nets/cells by name. Enter focuses the first match on canvas. Esc closes. Search icon in "Items" header.

### Miscellaneous

- **Net ID overlay:** human-readable net names on die viewer (toggle in side panel). VDD/GND hidden  
- **Layout comments:** clickable annotation icons with text, author, replies (WebSocket sync)
- **Keyboard shortcuts panel:** `Ctrl+/` opens a modal with all shortcuts grouped by category. `?` button in TopBar

---

## CV Cell Detection

Computer vision tools for automated cell instance detection. Available in the right panel (CV tab).

| Method | Status | Description |
|--------|--------|-------------|
| **Template matching** | Stable | Sobel-based template matching against a reference crop. Main working method for cell detection. |
| **AKAZE verify** | Optional | Compares detected cells pairwise via AKAZE keypoints. Cells below similarity threshold are removed. Used to filter false positives after template matching. |
| **Contour detection** | Experimental | Tree-based contour matching. Not reliable yet. |

---

## Schematic Viewer

Transistor-level schematics from SPICE netlists with an **interactive canvas** (default engine).

- **Interactive (default)** — drag devices, lock positions (persisted), multi-select, rotate/flip symbols, undo/redo
- **Hierarchy** — floorplan regions as collapsed blocks with port labels; double-click / right-click a block to open its schematic. Region tabs (All, bandgap, …)
- **I/O pins** — die-level I/O pin symbols and nets
- ELK layout (strategy/direction/compaction + spacing/edge tuning in Netlist Settings), ctrl+wheel zoom, net-name tooltips on wires
- Export: PNG, SVG (black-on-white)
- **Legacy static renderer** (netlist2svg, opt-in): Static/Interactive toggle, Functional block diagram, pan/zoom buttons, SVG/PNG/JSON download

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

## Folder Projects

Projects can live in independent folders instead of the managed application data directory.

- **Open folder** — reopen an existing folder project from the Library
- **Create in folder** — create a new project in an empty directory
- Import images or project ZIPs directly into a selected folder
- Relocate a folder project after it was moved or renamed
- Removing a folder project from the Library does not delete its folder from disk

---

## SPICE Simulation

Run extracted analog netlists with ngspice directly from the application.

- WASM or server-side ngspice engine
- Select the full netlist or an extracted subcircuit
- Custom model cards and editable testbench directives
- `.param` and `.step` support with step progress
- Waveform, schematic, and generated netlist views
- Interactive waveform inspection and PNG export with a white background
- Independent LLM chat for generating and refining testbench directives

| Key | Action |
|-----|--------|
| `Ctrl+Enter` | Run simulation |
| `Ctrl+,` | Open simulation settings |

---

## IC Package / Pin Planner

Map die I/O pins to package pins using a footprint generated by `@tscircuit/footprinter`.

This is an alignment and bond-mapping tool, not a complete package design or mechanical land-pattern editor. It uses footprints from the supported package library and is intended for matching package pins to die I/O pads.

- Select a supported package footprint with numbered pins
- Name package pins directly on the canvas
- Rotate and mirror the die relative to the package frame
- Create multiple bond wires between package pins and die I/O pads
- Configure bond wire width, default 30 µm
- Apply names from named package connections back to die I/O pins
- Export the alignment view as PNG and the pin table as CSV

| Key | Action |
|-----|--------|
| `S` | Pan / zoom |
| `T` | Name a package pin |
| `W` | Create a bond wire |

---

## LLM-Assisted Analysis

The optional AI Assistant analyzes the extracted netlist and generates ranked hypothesis cards for possible circuit functions, device roles, or suspicious connectivity. Cards include confidence, reasoning, evidence, affected devices, and suggested checks. Hypotheses are locally checked for valid device references and connectivity before becoming interactive cards; this does not prove the electrical function.

The assistant is read-only. It can display hypotheses on the die, open them in Net Graph, and show netlist or schematic fragments.

During finding discussions, the model can use controlled tool calls when enabled:

- **`mmochip_lvs_check`** — compare a candidate subcircuit with the `analog-circuits-sky130` reference LVS library using topology matching. The active library can be selected, and users can add custom reference cells from SPICE/Spectre subcircuits.
- **`mmochip_vision`** — request rendered die crops and overlay layers for multimodal models to inspect device geometry and terminal connectivity.
- **`mmochip_spice_sim`** — run a server-side ngspice check of a hypothesis and return simulation measurements. Experimental; requires further testing.
- **`mmochip_card_update`** — propose a structured update to an existing hypothesis card.

Tool access is explicitly controlled by the user. The model proposes hypotheses and evidence; the user reviews and verifies the result.

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
| `K` | Ruler / Measurement: draw multiple rulers |
| `Shift+K` | Delete all rulers |
| `Delete` | Delete selected ruler(s) |
| Right-click ruler | `Delete ruler` or `Set scale from ruler`; double-click remains a Set Scale shortcut |
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
| `Ctrl+Shift+S` | Screenshot (PNG, 4K) |
| `Ctrl+F` | Search nets / cells |
| `Ctrl+/` | Keyboard shortcuts panel |
| Space (hold) | Temporary pan |

### Ruler tool

Press `K` and drag across the die to measure. Measurements are orthogonal by default. Create multiple rulers, use `S` to select one, `Shift+click` to select several, and click empty canvas space to clear the ruler selection. Press `Delete` to remove selected rulers or `Shift+K` to remove all rulers.

Set the scale with double-click or right-click → **Set scale from ruler**. After scale is set, lengths are shown in µm; values below 1 µm are shown in nm. At zoom below 20%, inactive rulers are hidden while the current preview and selected ruler remain visible.

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
| `Space+B` | Toggle base image |
| `Space+C` | Toggle cell visibility |
| `Space+N` | Toggle net visibility |
| `Space+H` | Toggle floorplan visibility |
| `]` / `[` | Next / previous overlay layer only |
| `Space+1..8` | Show only overlay layer N; repeat to hide it |

Overlay layer settings (visibility, opacity, offset) are persisted per-die in localStorage. **Upload to Server** saves images to the die's folder for automatic reload.

### Analog Netlist

| Key | Action |
|-----|--------|
| `G` | Toggle Code / Graph |
| `H` | Hierarchical on/off |
| `R` | Resistor format (Ω / sq·Rs) |
| `M` | Device matching on/off |
| `Alt+1..4` | Code / Graph / Schematic / LVS view |

### Merge Cells

| Key | Mode |
|-----|------|
| `Alt+1`…`5` | Overlay / Side-by-side / Diff / Specimen / Candidate |

---

## What's Not Done Yet (priority)

- **DMOS, Schottky diode, VPNP, JFET** — no detection or markers  
- **Wire matching** — tolerance = contact size × 0.5; dense routing may false-positive  
- **Polyline post-edit** — stretch/reshape (only redraw from scratch)  
- **Hierarchical netlist / floorplan** — interactive viewer supports it; alias collision + rename speed still need real-world validation

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
