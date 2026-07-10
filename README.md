# mmo-chip — analog-re-wip

> **ENG** | [**RU**](README.ru.md)

**A fork of [mmo-chip](https://github.com/giulioz/mmo-chip) for reverse engineering analog and mixed-signal ICs.**  
The original project targets digital CMOS Gate Array / Standard Cell chips and extracts logic gates and Verilog netlists.  
This fork extends it to **BJTs, BiCMOS, resistors, capacitors, diodes** — all the analog periphery that doesn't fit the standard cell model.

## Acknowledgments

Many thanks to the developers of the original [mmo-chip](https://github.com/giulioz/mmo-chip).  
Clean architecture, thoughtful modularity, and clear interfaces between the frontend, backend, and shared types are an excellent base for custom extensions, for example, for RE analog blocks and chips.

The original CMOS pipeline (standard cells, logic, Verilog) is **untouched** — analog extraction works as an add-on. We tried not to break the digital path, but this needs verification — we have no experience in digital logic or sample chip images to test against.

### Open source projects used

| Project | Purpose |
|---|---|
| [netlist2svg](https://github.com/ajsb85/netlist2svg) (ELK.js) | Layout and rendering of transistor-level schematics |
| [vyges-lvs](https://github.com/vyges/vyges-lvs) | LVS engine (name-independent netlist comparison) |
| [cytoscape.js](https://js.cytoscape.org/) | Force-directed device connection graph |
| [clipper2-wasm](https://github.com/ajsb85/clipper2-wasm) | Diffusion splitting, poly gate group merging |

---

```
┌─────────────────────────────────────────┐
│                mmo-chip                  │
├────────────────┬────────────────────────┤
│  CMOS Logic    │  Analog Extraction      │
│  (original)    │  (our branch)           │
├────────────────┼────────────────────────┤
│ extractCell()  │ extractMarkedDevices()  │
│ gates.ts       │ simpleAnalog.ts         │
│ logic.ts       │ dieWideAnalog.ts        │
│ verilog.ts     │ spice.ts                │
├────────────────┼────────────────────────┤
│ Standard cells │ NPN, LPNP, MOS, R, C, D │
│ Gate-level     │ Transistor-level        │
│ Verilog        │ SPICE/CDL/Spectre       │
└────────────────┴────────────────────────┘
```

![die-viewer-analog-workflow](docs/die-viewer-analog-workflow.png)
*Die viewer with detected analog devices: colored bboxes with labels, terminal markers (G, S/D, B, C, E), parameters (W/L, AE, Ω)*

---

## Supported devices

| Device | Detection | Parameters |
|---|---|---|
| **NMOS / PMOS** (3-/4-terminal) | **Well-based**: nwell→PMOS, pwell→NMOS. No markers needed — automatic via diffusion + polysilicon intersection. **All MOS** (including single-finger) use **Clipper2** to split diffusion at gates. N gate fingers → N+1 segments → N individual MOS | W, L, fingers, multiplier. Bulk: contact on nwell/pwell outside diffusion/poly → positive netId. If absent → sentinel -2 → VDD/GND (configurable names) |
| **NPN** | Marker `npn_id` with collector + base + emitter | AE (overlap base∩emitter), multiplier M |
| **PNP / LPnp** (lateral PNP) | Marker `pnp_id` | AE, PE (emitter perimeter), multiplier M |
| **Diode** | Marker `diode_id` **or** NPN/PNP without collector — base=anode(+), emitter=cathode(-). Terminals: PLUS via `["base","bulk"]`, MINUS via `["emitter"]` with priorities (emitter 0 > base 1) | Area (AE from base-emitter overlap) |
| **Resistor** | **Geometric detection** (res_id not required): resistor body (poly/base/emitter/hsr/film) → ME1 intersecting the body → contacts on ME1 → contact groups = PLUS/MINUS. Drawn with polyline tool (`L`) with orthogonal snap. Width in µm (slider 0–200µm). Click selects the entire segment chain | Ω or squares×Rₛ. Body layers supported: poly-R, p-base (pb), n+ (npl), HSR (high-sheet), thin film. Multiple resistors in one cell |
| **Capacitor** | Marker `cap_id` — capacitance from overlap area | fF = area × density (1 fF/µm² default) — needs verification |

---

## How to draw devices

### MOS transistor (well-based, no markers needed)

MOS is detected **automatically** from layer intersections — no separate markers required.

| Layer | Purpose |
|---|---|
| `nwell` | PMOS transistors are found inside nwell |
| `pwell` | NMOS transistors are found inside pwell |
| `diffusion` | Transistor body (source + drain) |
| `polysilicon` | Gates crossing diffusion |

1. Draw `nwell` (for PMOS) or `pwell` (for NMOS) on Cell RE.
2. Inside the well, draw `diffusion` — this is the source and drain region.
3. Draw `polysilicon` across diffusion — this is the gate(s).
4. **Bulk:** draw `cont` (contact) on nwell/pwell **outside** diffusion and polysilicon. If the contact lands on diffusion too, it's considered S/D, not bulk. If no bulk contact → sentinel -2 → VDD (PMOS) / GND (NMOS). VDD/GND names are configurable in Analog Netlist → SubBar.
5. **Metallization:** connect diffusion regions through contacts and metal1 to the rest of the circuit.
6. **Multi-finger (multiple gates on one diffusion):** Clipper2 (`polygonDifference()`) splits diffusion between gates. Each gate finger → separate MOS. Shared segment between gates — D for the left and S for the right (identical netId after wire matching).
7. **Metal-connected D/S:** If drain/source of two different transistors are connected by ME1 (or ME2 via via1) inside the cell — they get one cell-level netId. Union-Find across metal1+metal2+via1+contact.

W/L, fingers, and segments are computed automatically.

![RECEll MOS — 3 PMOS in one cell (multi-finger + single-finger)](docs/RECEll_3pmos_1cell(multi_and_single_finger).png)
*Cell RE: 3 PMOS in one cell (multi-finger and single-finger). Clipper2 splits diffusion, poly gate net grouping merges gates.*

> Detailed MOS detection pipeline — [`docs/mos_detection.md`](docs/mos_detection.md).

### BJT (NPN / PNP)

| Layer | Purpose |
|---|---|
| `npn_id` | NPN bounding box |
| `pnp_id` | PNP bounding box |
| `collector` | Collector region |
| `base` | Base region |
| `emitter` | Emitter region |

1. **Choose a bounding box:** draw `npn_id` (NPN) or `pnp_id` (PNP / LPnp) — a rectangle covering the entire device.
2. **Draw layers:** collector, base, emitter — as rect or polygon inside the bbox.
3. **Contacts:** place `cont` (contact) on each layer. The tool matches contacts to terminals automatically.
4. **For PNP / LPnp** PE (perimeter) = emitter perimeter — used as the primary parameter.
5. **Multi-emitter:** draw multiple emitters inside one bbox — the tool sums their areas and sets multiplier M.

> **Important:** emitter must lie **inside** base (or intersect it). This is a layout-oriented physical approach familiar to layout engineers.

### Diode

**Method 1 — marker `diode_id`:**  
Draw `diode_id` — a rectangle around the diode region. Not tested.

**Method 2 — from BJT without collector (recommended):**  
Draw `npn_id` (or `pnp_id`) with `base` + `emitter`, but **without** `collector`.  
The tool automatically recognizes it as a diode:
- Base = anode (PLUS)
- Emitter = cathode (MINUS)
- AE (overlap base ∩ emitter) = diode area

### Resistor

| Layer | Purpose |
|---|---|
| `res_id` | Resistor bounding box | --< LEGACY! NO LONGER USED, replaced by geometric detection
| `poly` / `polysilicon` | Body (poly resistor) |
| `base` | Body (p-base diffusion) |
| `emitter` | Body (n+ diffusion) |
| `hsr` | Body (High Sheet Resistance — ion implantation) |
| `film` | Body (thin film) |
| `contact` | Contacts (minimum 2) |

1. **res_id** is no longer required — detection is purely geometric: body → ME1 → contacts → groups = PLUS/MINUS.
2. Choose a **body layer**: poly, base, emitter, hsr, film. Draw the body **ONLY** with the polyline tool (`L`), even for straight resistors.
3. Draw ME1 **overlapping the resistor body**. Place at least 2 contacts (`contact`) — they become PLUS and MINUS.
4. **Polyline mode:**
   - `L` — activate the tool
   - Width in µm (slider 0–200µm, step 1) is set **before** drawing in the toolbar
   - Orthogonal snap (90°) in real time
   - Each segment is added to the total length
   - Opacity slider in the toolbar — overlay a semi-transparent layer on the image to verify width alignment
5. The width of a drawn resistor can be changed: click any segment → the entire chain is selected → Width field in the right panel (bottom). Drag-move for line shapes is disabled (to preserve geometry).

> **Sheet R₀:** configurable in GUI (defaults: poly=25 Ω/□, hsr=1500 Ω/□, pb=200 Ω/□, npl=5 Ω/□, film=500 Ω/□). These are baseline reference values that can vary widely.
> Resistance = squares × sheetR₀. Display can be toggled between Ω and sq·Rs.

### Capacitor (not tested)

1. Draw `cap_id` — bounding box (overlap area = capacitance).
2. PLUS and MINUS — both on the `contact` layer.

---

## Hotkeys

### Die Viewer — tools

| Key | Tool |
|---|---|
| `S` | Select |
| `W` | Wire — first press M1, second press toggles M1↔M2 |
| `E` | Via up — places via at cursor and switches to next layer (M1→M2) |
| `Q` | Via down — places via and switches to previous layer (M2→M1) |
| `B` | Multi-wire / Bus |
| `O` | Via (contact window) |
| `K` | Ruler / Measurement |
| `R` | Add Cell |
| `P` | I/O Point |
| `F` | Fit to Screen / Pan |
| `+` / `=` | Zoom in |
| `-` | Zoom out |

### Die Viewer — tab navigation

| Key | Tab |
|---|---|
| `1` | Die viewer |
| `2` | Merge cells |
| `3` | RE cell |
| `4` | Code |
| `5` | Analog Netlist |

### Cell RE — tools

| Key | Tool |
|---|---|
| `R` | Rect |
| `P` | Polygon |
| `O` | Point / via |
| `L` | Polyline (meander resistor, orthogonal snap) |

### Undo / Redo

| Keys | Action |
|---|---|
| `Ctrl+Z` / `⌘Z` | Undo |
| `Ctrl+Shift+Z` / `⌘⇧Z` | Redo |

### Overlay images (global)

| Keys | Action |
|---|---|
| `Ctrl+Shift+B` | Show/hide base image (die photo) |
| `]` | Show **only** the next overlay layer (N+1), hide others |
| `[` | Show **only** the previous overlay layer (N-1), hide others |
| `Ctrl+Shift+1..8` | Show **only** overlay layer #1..8, hide others |

Works on all three tabs: Die Viewer, Merge Cells, RE Cell. (needs verification)

### Merge Cells — view modes

| Key | Mode |
|---|---|
| `Alt+1` | Overlay |
| `Alt+2` | Side-by-side |
| `Alt+3` | Difference |
| `Alt+4` | Specimen only |
| `Alt+5` | Candidate only |

### Analog Netlist — hotkeys

| Key | Action |
|---|---|
| `G` | Toggle Code / Graph view |
| `H` | Hierarchical on/off |
| `R` | Resistor format (Ω / sq·Rs) |
| `M` | Device matching on/off |

### Cell RE — misc

| Keys | Action |
|---|---|
| `Ctrl+C` / `⌘C` | Copy selected shapes |
| `Ctrl+V` / `⌘V` | Paste |
| Space (hold) | Temporary Pan (in any tool) |

---

## Project Export / Import

Projects can be exported from the server and imported to another instance.

- **`POST /api/dies/:dieId/export-project`** — export to JSON (light: annotations only / full: + images)
- **`POST /api/dies/import-project`** — import with conflict handling (overwrite / skip)
- **`POST /api/dies/:dieId/rename`** — rename a die
- Export preferences from localStorage

Full export preserves the original image + overlay images, so third-party projects are fully restorable (with images).

---

## Floorplan regions (v0.2)

A tool for marking analog blocks on the die layout. Rectangular and polygonal regions.

### Features
- **Drawing:** rect (drag-based) or polygon (vertices by click, double-click / Enter to finish)
- **Popover:** edit name, color, port aliases, reservation
- **Reservation:** optionally show who is working on a block (for multiplayer)
- **Port aliases:** assign human-readable names to block boundary ports
- **Global rename:** aliases rename nets on the die (via `PUT /api/dies/:dieId/nets/:uuid`)
  Removing an alias restores the original name
  Collision (same alias for two different netIds) → auto-suffix `_1`, `_2`
- **Port dots:** colored circles with port names on the die viewer
  When a block is selected — on its ports; "FP IO" checkbox — on all blocks at once
- **Layer:** rendered on top, outline only (no fill), clicks pass through to canvas

### Hotkeys

| Key | Action |
|---|---|
| `H` | Activate "Floorplan" tool |
| `Ctrl+Shift+H` | Show/hide region overlay |

---

## Schematic Viewer (netlist2svg)

Transistor-level schematics and functional block diagrams generated from SPICE netlists.

### Features

- **Analog mode:** full transistor-level schematic with NMOS/PMOS/NPN/PNP, resistors, capacitors, diodes, sources — all devices found on the die
- **Functional mode:** block diagram where each floorplan region appears as a rectangle with I/O ports. Cross-region connections — wires between blocks. Devices outside regions are drawn as analog symbols next to blocks
- **Pan/zoom** via `@panzoom/panzoom` (drag to pan, scroll to zoom, +/−/⊖ buttons)
- **Device tooltips** (React overlay): hover a device to see name, type, parameters (W/L for MOS, AE/M for BJT, Ω/sq/type for resistors)
- **Power net coloring:** VDD — red, GND — blue (on schematic + connected wires)
- **ELK layout:** configurable strategy (Brandes-Koepf / Interactive / Simple), direction (DOWN/RIGHT/UP/LEFT), compression (0–4)
- **Export:** SVG (dark/light theme), PNG (2×), Yosys JSON
- **Per-region view:** region buttons in Analog mode for isolated viewing of each floorplan block

### Engine

Uses [netlist2svg](https://github.com/ajsb85/netlist2svg) (ELK.js for layout) with a custom SVG skin that replaces standard netlistsvg symbols with realistic 4-terminal MOS (D/G/S/B), BJT, resistors, and diodes.

Previously experimented with `@spice-ts/ui` as an alternative renderer, but it was replaced due to poor rendering quality and lack of customization.

---

## LVS (Layout vs Schematic)

Comparing the netlist extracted from the layout with the netlist you draw manually in a schematic editor.

**The goal:** when you're reconstructing the layout and drawing the schematic in parallel, LVS lets you constantly check yourself and find errors — incorrect connections, missing or extra devices.

### Two engines

| Mode | When to use |
|---|---|
| **name-based** | You keep device names (Q1, M2, R5) — diff by name is simple and clear |
| **vyges-lvs** | The schematic was drawn with different names — name-independent comparison (similar to netgen). Checks connection topology, ignoring names |

### Availability

- **LVS** tab on the Analog Netlist page (`Alt+4`)
- Layout netlist is auto-filled from extraction
- Schematic netlist is pasted into a text field (copy-paste from your SPICE editor)
- **Compare** button — runs the selected engine
- Result: MATCH ✅ / MISMATCH ❌, device-diff table, full report

**Limitations:** only Spectre dialect has been tested so far. Normalization for other dialects (CDL, HSPICE) is needed.

---

## Hierarchical SPICE netlist

When floorplan regions are created, **hierarchical** (rather than flat) netlist generation becomes available.

- **Flat:** all devices and connections at one level — default behavior
- **Hierarchical:** each device goes into the .SUBCKT of its region (by center).
  A region port = a net connecting devices inside and outside (boundary net).
  Ports are automatically detected from device connections.

### "Hierarchical" toggle
On the Analog Netlist tab (tab `5`) — checkbox in the export panel.
Default is Off (preserves the old flat netlist).

### Format

```spice
// Spectre hierarchical netlist
// Source: lmv341

subckt fp1 (fp2in1 VDD GND)
  M1 (net2030 fp2in1 net2032 net2033) PMOS W=28.655u L=7.905u
ends fp1

subckt lmv341 (Net_20 fp2in1 fp3in1 fp3in2 fp3out1 VDD GND)
  X1 (fp2in1 VDD GND) fp1
  X2 (fp2in1 fp3out1 VDD GND) fp2
  M1 (Net_20 fp3in2 fp3in1 Net_20) PMOS W=54.674u L=4.611u
ends lmv341
```

---

## Layout comments

Clickable annotation icons on the die viewer. Leave notes on the physical layout.

- **Adding:** "Comment" tool (pin) in the toolbar — click at the desired point
- **Popover:** text, author, date, reply list
- **WS:** new comments arrive to everyone viewing the die in real time
- **Data:** stored as optional `comments[]` field in DieAnnotations — backwards compatible

---

## Net ID overlay

Shows human-readable net names on the die viewer — the same names used in the SPICE netlist.

- Toggled by a checkbox in the side panel
- Names are computed from `netNameMap` (die-wide device collector)
- VDD/GND/VSS/0 are not shown (redundant)

---

## ProblemNavigator

A unified problem panel on the die viewer — extraction quality dashboard. Opened via the `IssuesChip` button (`N/M` counter in SubBar).

| Category | What it checks |
|---|---|
| **Connectivity** | Unconnected terminals (netId ≥ 2000) and nets with ≤1 device |
| **Wiring** | Wire stubs — ends of ME1 from different nets within 20px of each other |
| **Vias** | Via annotations without metal1 and/or metal2 within 15px |
| **I/O Pins** | Pin name mismatch with the nearest annotation net |
| **Overlaps** | Intersecting wire segments on the same metal layer |
| **Electrical** | Detection warnings (shorted pins, floating gate, polarity mismatch) |

Useful as a quick way to check if any problems remain after editing the layout — all unresolved ends are visible in one list.

Details: [`docs/problem-navigator.md`](docs/problem-navigator.md)

---

## Netlist warnings

Detailed documentation of all warnings during SPICE/CDL generation — [`docs/netlist_warnings.md`](docs/netlist_warnings.md).

| Prefix | Meaning |
|---|---|
| `[WARN]` | Likely error (D=S short, emitter on VDD, etc.) |
| `[INFO]` | Suspicious but possibly normal (floating gate, dummy resistor) |

Warnings are shown in a collapsible panel at the bottom of the Analog Netlist tab and at the top of the generated file as comments.

---

## Layer reference (Cell RE)

Available layers for drawing analog devices in Cell RE:

| Layer | Group |
|---|---|
| `diffusion` / `polysilicon` / `nwell` / `pwell` | MOS |
| `collector` / `base` / `emitter` | BJT |
| `hsr` / `film` | Resistors (high-sheet / thin film) |
| `npn_id` / `pnp_id` / `res_id` / `cap_id` | Markers |
| `metal1` / `contact` | Metallization |

---

## Device Registry

Every detected device gets a stable UUID based on a fingerprint key: `kind + position inside cell + subType`.

- If you slightly modify the cell layers (< 100 px shift) — the same device gets the same UUID
- If you manually number devices in your schematic — numbering **does not reset** on re-extraction or layer changes
- Devices can be **renamed** — names persist between sessions (localStorage) and in project export
- Force-overrides for parameters (W/L, AE, R) can be set — they are also tied to the device UUID

---

## Key changes from original mmo-chip (main)

- **Well-based MOS** — the only MOS path. **All MOS** (single-finger + multi-finger) use Clipper2 (`polygonDifference()`) to split diffusion at gates. Each gate finger → separate MOS. Shared segments between gates (D gate[i] = S gate[i+1]) get the same netId.
- **Poly gate grouping (polyGateNetMap)** — physically connected poly shapes (via Clipper2 overlap) get one gate netId. Shared poly bus is highlighted in overlay.
- **Gate terminal includes all poly shapes** from the polyGateNetMap component (not just those cutting diffusion), so shared poly bus is correctly highlighted in overlay.
- **Metal-connected D/S merging** — drain/source connected by ME1/ME2+via1 inside the cell get a shared cell-level netId. Union-Find identical to cell.ts Step 2.
- **Diode from BJT** — drawing NPN/PNP without collector automatically yields a diode. PLUS via layers `["base","bulk"]`, MINUS via `["emitter"]`. Priority: emitter(0) > base(1) for collision resolution.
- **BJT with multiple emitters** — AE is summed, multiplier M = emitter count (needs verification)
- **Polyline Tool** — meander resistor drawing with 90° orthogonal snap (including preview), editable width in µm (slider 0–200µm, step 1). Opacity slider for image overlay. Click selects the entire segment chain. Drag-move disabled. Geometric detection: body → ME1 → contacts → PLUS/MINUS groups.
- **Ruler Tool** (key `K`) — distance measurement on the die. Modes: free, horizontal, vertical, orthogonal, diagonal (45°). Double-click → enter size in µm → umPerPx is saved.
- **Wire: layer (ME1/ME2) and via transitions** — metal layer is selected when drawing a wire (W).
  **Device contacts always connect to ME1 only** — ME2+ requires a via.
  **Mid-draft hotkeys:**
  - `E` — places `point_via` at cursor and switches to next layer (ME1→ME2)
  - `Q` — places via and switches to previous layer (ME2→ME1)
  Via is created as `HumanAnnotation` and participates in snap-to-via.
- **Overlay images** — multi-layer SEM / doping / metal images, loaded from server or file, with hotkey control.
- **Analog overlay on die viewer** — each detected device: colored rectangle with label (`M1 pmos`, `Q3 npn`, `R5 poly res`...) and parameters. Terminal labels (G, S/D, C, B, E) at zoom >0.7×, parameters at >0.5×.
- **SPICE/CDL/Spectre export** — correct Spectre format. MOS: w/l/m without AS/AD/PS/PD. BJT: AE, PE, M. Resistors: r=Ω. Diodes: area=AREA. Three dialects.

  ![netlist-example](docs/netlist_example.png)
  *Example of a generated SPICE netlist with detected devices and warnings*

- **BJT normalization** — find minimum AE (NPN) / PE (PNP) → m=1, others scaled.
- **VDD/GND config persistence** — supply net names configured in SubBar, saved to backend with debounced auto-save.
- **Cell RE device review** — force override W/L, AE, R, fingers via GUI. (needs verification)
- **Layout CSV + SKILL template** for Cadence import.
- **Net Graph** (Cytoscape.js) — force-directed device connection graph. Modes: currently D2D (device-to-device) only.

  ![graph-netlist-example](docs/graph_netlist_example.png)
  *Net Graph: device connection graph*

- **Per-net color override** — net colors saved in preferences.
- **uuid polyfill** — `crypto.randomUUID()` doesn't work over Network IP; replaced with `uuid()` fallback using Math.random() for v4.
- **Overlay images on Merge Canvas + RE Cell Canvas** — clipped to cell area with global hotkeys.
- **Floorplan regions** — rect/polygon regions with color, name, reservation, port aliases
- **Hierarchical SPICE netlist** — .SUBCKT generation per region with auto-detected boundary nets
- **Schematic viewer (netlist2svg)** — transistor-level schematics and functional block diagrams with ELK layout, pan/zoom, tooltips, power net coloring, SVG/PNG export
- **Global port rename** — port aliases rename annotation nets on the die via API
- **Port dots overlay** — visualization of boundary ports on the die viewer (selected block / all blocks)
- **Comment annotations** — clickable icons with text, author, replies on the die viewer
- **Net ID overlay** — human-readable net names on the die viewer
- **Project export/import** — light/full export + import with conflict handling
- **Device Registry** — stable UUIDs: device fingerprint (kind + position + subType) → same UUID on re-extraction. Names and overrides are preserved
- **LVS comparison** — name-based diff and vyges-lvs (name-independent) for netlist verification against hand-drawn schematics
- **ProblemNavigator** — unified problem panel on die viewer: connectivity, wiring, vias, I/O pins, overlaps, electrical
- **DeviceInstancePanel** — device list with unconnected terminal glow (yellow/red halo)
- **Cells locked toggle** — lock cells on the die to prevent accidental movement
- **Per-layer wire colors** — customize wire and via colors
- **Per-cell schematic** — analog schematic (netlist2svg) on Cell RE tab for viewing one cell's schematic
- **Customizable device/contacts overlay in CellRE** — configure display of contacts and recognized devices directly on canvas

---

## What's not done yet (priority)

- **DMOS** (LDMOS / VDMOS) — no detection or markers
- **Schottky diode** — separate marker / detection
- **VPNP** (vertical PNP) — `vpnp` layer added to types but not detected
- **JFET** — markers and geometry params in early state
- **Wire matching at die-wide level** — tolerance tied to contact size (`contactTolerance()`: tol = size×0.5, no margin). Dense routing may cause false positives — needs testing
- **Polyline post-edit** — stretch/reshape segments (only redraw from scratch)
- **Overlay image serialization** into JSON annotations (currently static)
- **Hierarchical netlist + floorplan:** basic functionality ready, needs real-world testing
  - Alias collision: verify on clean start (no old aliases with wrong netIds)
  - Global rename: verify revert on alias removal
  - Rename speed: multiple `PUT /api/dies/:dieId/nets/:uuid` with many aliases

---

## ⚠️ Disclaimer

**Still alpha / WIP.** Only unit tests for the extraction pipeline exist (22 tests: 18 pass, 4 skip, 0 fail). Skipped — geometric resistor and MOS (require Clipper2 + loaded layers).  
No e2e tests, no tests for overlay, wire matching, SPICE export, or cross-tab navigation.  
No user testing has been done.

**Possible issues:**
- Critical errors and data loss
- Incorrect netlists (especially with complex routing)
- False positives / missed detections on dense analog blocks

Verify results visually and cross-check with the original (datasheet / layout / SEM).  
File bug reports and test cases.

---

## Repository structure

```
frontend/     Vite + React + TypeScript — die viewer, cell RE, analog netlist, overlay
backend/      Node + TypeScript API — import, tiling, JSON persistence, WebSocket
shared/       Shared TypeScript types (annotation schema + analog device types)
ml/           Python U-Net (optional, for assisted annotation)
docs/
  analog-devices.md              ← current analog device detection documentation
  mos_detection.md               ← MOS detection pipeline (Clipper2, polyGateNetMap, metal merge)
  netlist_warnings.md            ← all SPICE/CDL generation warnings
  problem-navigator.md           ← ProblemNavigator details
  lvs-plan.md                    ← LVS architecture and status
  lvs_patterns.md                ← LVS pattern examples
  reference/
    analogDevices.ts             ← legacy auto-detection (reference), see docs/reference/README.md
```

Key analog extraction files:

```
frontend/src/
  api/
    dieWideAnalog.ts              ← DEVICE_TERMINAL_DEFS / DIODE_DEFS, resolveDeviceContacts, collectDieWideAnalogDevices
    analogNetlist.ts              ← loadSpiceConfig / saveSpiceConfigToBackend, SPICE netlist generation
  lib/extraction/
    simpleAnalog.ts               ← extractMarkedDevices, detectMOSFromLayers, splitDiffusionAtGates (Clipper2)
    clipper.ts                    ← Clipper2 WASM wrapper (polygonDifference, polygonIntersection)
    common.ts                     ← shapeToPolygon, polygonBounds, SpatialIndex
  lib/export/hierarchical.ts      ← floorplan geometry, port detection, alias collision resolver
  lib/export/spice.ts             ← netlist generation (CDL/Spectre/HSPICE + hierarchical)
  components/dieViewer/
    AnalogDeviceHighlights.tsx    ← canvas overlay
    FloorplanOverlay.tsx          ← floorplan region rendering + port dots
    FloorplanRegionPopover.tsx    ← popover for region edit + port aliases
    ProblemNavigatorPanel.tsx     ← ProblemNavigator dashboard
  components/netlist/
    LVSComparePanel.tsx           ← LVS comparison UI
  components/cellRE/
    CellREToolbar.tsx             ← Cell RE tools
    useLayerPolylineTool.ts       ← polyline (meander resistor)
  state/
    cellRE.ts                     ← TOOL_LAYERS, ReToolKind, polyline state
    deviceRegistry.ts             ← Device Registry (UUID, overrides)
  lib/hotkeys.ts                  ← central hotkey registry (all pages)
  lib/useOverlayHotkeys.ts        ← overlay hotkeys
  routes/
    AnalogNetlistPage.tsx         ← Analog Netlist tab
    RECellPage.tsx                ← RE Cell page

docs/
  analog-devices.md               ← full device detection and API documentation (current)
  mos_detection.md                ← MOS detection pipeline
  problem-navigator.md            ← ProblemNavigator details
  lvs-plan.md                     ← LVS architecture
  reference/
    analogDevices.ts              ← legacy Phase 1 auto-detection (reference only)
```

---

## Running

```sh
# Node ≥ 20
npm install

# Start everything (backend + frontend + ML sidecar):
npm run dev

# Individually:
npm run dev -w backend    # http://localhost:3001
npm run dev -w frontend   # http://localhost:5173
```

Tests:

```sh
npm test                                             # all tests
node --import tsx --test backend/src/analog-extraction.test.ts  # extraction only
```

---
