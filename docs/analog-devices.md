# Analog Device Detection

## For users: how to draw devices

Device detection uses **marker layers** (for BJT, diode, resistor, capacitor)
and **well-based inference** (for MOS). The detection runs on a **cell type**
basis — a cell type can contain multiple devices; they are extracted at
die-wide level and connected to die-level wires.

---

### MOS Transistor — well-based (no markers)

MOS detection is fully automatic — no markers needed. The tool infers
transistors from actual layout layers:

| Layer | Purpose |
|-------|---------|
| `nwell` | PMOS transistors are detected here |
| `pwell` | NMOS transistors are detected here |
| `diffusion` | Body region (drain + source) |
| `polysilicon` | Gate fingers crossing the diffusion |
| `contact` | S/D contacts on diffusion; well tap contacts on well |

**Geometry:** W/L computed from poly ∩ diffusion intersection.  
**Fingers** = number of poly stripes crossing one diffusion body → multi-finger
MOS uses **Clipper2** (`polygonDifference()`) to physically cut the diffusion
into N+1 segments, creating one MOS device per gate finger.  
**Multiplier** = devices with same type and W/L in the same well are grouped.

**Bulk (well tap) detection:** A contact IS a well tap ONLY if:
1. It is inside the well bounding box
2. It is NOT on any diffusion (would be S/D contact)
3. It is NOT on any polysilicon (would be gate contact)

This is the classic Calibre LVS layer-exclusion pattern (contact belongs to the
most specific layer set).

**Bulk fallback:**
- Well contact exists → positive internal net (2000+ if not connected to supply)
- No well contact at all → sentinel -2 → resolved to VDD/GND at die level

**Multi-finger split (Clipper2):** For `fingers > 1`, the diffusion is cut at
each gate poly using Clipper2 `polygonDifference()`. This creates N+1 diffusion
segments. Adjacent segments between gates are shared: segment[i+1] is both D of
gate[i] and S of gate[i+1] — they get the same net ID during wire matching.

---

### BJT

| Layer | Purpose |
|-------|---------|
| `npn_id` | NPN bounding box |
| `pnp_id` | PNP bounding box |
| `collector` | Collector region |
| `base` | Base region (fallback: `bulk` layer) |
| `emitter` | Emitter region |

**Geometry:** AE = overlap(base, emitter) in pixels² × umPerPx².  
PE = emitter perimeter (important for LPNP).  
Multiplier = number of emitter fingers.

---

### Diode

Two ways to draw:

1. **Marker `diode_id`** — diode from bbox. Rough area/perimeter.

2. **As NPN/PNP without collector** — draw `npn_id` (or `pnp_id`) with
   `base` + `emitter` layers but **no** `collector` layer. The tool
   automatically detects this as a diode:
   - **Anode (PLUS)** = base layer (via `DIODE_DEFS` - layers `["base", "bulk"]`)
   - **Cathode (MINUS)** = emitter layer (via `DIODE_DEFS` - layer `["emitter"]`)
   - Priority: emitter=0 > base=1 (if a point falls in both, emitter wins)
   - Area = base-emitter overlap (same as BJT AE)

---

### Resistor

| Layer | Purpose |
|-------|---------|
| `res_id` | Bounding box |
| `poly` / `polysilicon` | Body (poly resistor) |
| `base` | Body (p-base diffusion) |
| `emitter` | Body (n+ diffusion) |
| `hsr` | Body (ion implanted) |
| `film` | Body (thin film) |
| `contact` | Terminal contacts (at least 2) |

**Geometry:** If body is drawn as polyline segments → summed length + corner counting
(meander mode). Otherwise → bbox dimensions. Squares = L / W.
Resistance = squares × 50 (default sheet R).

---

### Capacitor

| Layer | Purpose |
|-------|---------|
| `cap_id` | Bounding box (overlap area = capacitance) |

Capacitance = area × 1 fF/µm² (default). Terminals: PLUS, MINUS.

---

## For developers: architecture & how to add a new device

### Code layout

```
frontend/src/api/
  dieWideAnalog.ts            ← Die-wide collection, terminal contact
                                resolution, wire matching, VDD/GND config
  analogNetlist.ts             ← SPICE netlist generation, SpiceConfig API
  dies.ts                      ← Die-level device queries

frontend/src/lib/extraction/
  simpleAnalog.ts             ← Marker-based + well-based device extraction
                                (extractMarkedDevices, detectMOSFromLayers)
  clipper.ts                  ← Clipper2 WASM wrapper for polygon booleans
  common.ts                   ← shapeToPolygon, polygonBounds, etc.

docs/
  analog-devices.md           ← This file
  mos_detection.md            ← MOS detection specifics
  reference/
    analogDevices.ts          ← Legacy Phase 1 auto-detection (reference only)

frontend/src/lib/export/
  spice.ts                    ← CDL/Spectre/HSPICE netlist generation

frontend/src/components/dieViewer/
  AnalogDeviceHighlights.tsx  ← Canvas overlay with labels and colors
```

### Pipeline

```
CellType layers
    │
    ├── extractMarkedDevices()      // marker layers (npn_id, pnp_id, …)
    │     │                             returns AnalogDevice[]
    │     └─ shapesInside()         // find shapes inside a marker bbox
    │
    ├── detectMOSFromLayers()       // well-based: wells → diff → poly → contacts
    │     │                             returns AnalogDevice[] (MOS only)
    │     └─ splitDiffusionAtGates()// Clipper2 polygonDifference() for multi-finger
    │                                    creates N devices (one per gate)
    │
    └── merge: all devices from both paths
    │
    ▼
  collectDieWideAnalogDevices()
    │
    ├── consumeSegmentShapes()      // inject Clipper2-generated segment shapes
    ├── For each device instance:
    │     resolveDeviceContacts()   // match contacts to terminals
    │         │                         returns termPoints + termContacts
    │         └── DEVICE_TERMINAL_DEFS / DIODE_DEFS table
    │
    ├── matchWireToPoint()          // find die-level wires by proximity
    └── generateSpiceNetlist()      // CDL/Spectre/HSPICE with VDD/GND config
```

### The terminal definition table

The heart of the system is `DEVICE_TERMINAL_DEFS` in `dieWideAnalog.ts`.
Each device kind declares:

```typescript
interface TerminalDef {
  name: string;          // Terminal name (D, G, S, B, E, C, PLUS, MINUS…)
  layers: string[];      // Layout layer names to check for this terminal
  priority?: number;     // Lower = wins (for overlapping layers)
}

const MOS_DEFS: TerminalDef[] = [
  { name: "D", layers: ["diffusion"] },
  { name: "G", layers: ["polysilicon"] },
  { name: "S", layers: ["diffusion"] },
  { name: "B", layers: ["bulk", "nwell", "pwell"] },
];

// Special case: diode-from-BJT has its own definitions using base/emitter
// layers instead of "contact":
const DIODE_DEFS: TerminalDef[] = [
  { name: "PLUS",  layers: ["base", "bulk"], priority: 1 },
  { name: "MINUS", layers: ["emitter"],      priority: 0 },
];
```

### How `resolveDeviceContacts` works

1. **Collect all contacts** from `ctLayers.contact` (all contacts in the cell
   type are candidates; bulk exclusion prevents false positives).

2. **For each contact**, iterate over `dev.terminals` and look up the terminal's
   definition by **name** (not index).

3. **point-in-shape**: a contact matches a terminal if its center falls inside
   any shape on the terminal's declared layers (rect, polygon via ray casting,
   circle, point, line).

4. **Priority resolution** (BJT/diode): if a contact falls inside multiple
   terminal layers, the terminal with the lowest `priority` wins. E(0) beats
   B(2), emitter(0) beats base(1).

5. **Shared-layer round-robin** (MOS D+S, 2T PLUS+MINUS): if no terminal has a
   priority, all matching terminals are candidates. `bySig` groups contacts
   by signature ("D,S") and distributes via round-robin.

6. **Bulk exclusion** (MOS): a contact on nwell/pwell is B only if it is NOT
   inside a diffusion or polysilicon shape (LVS layer exclusion).

7. **Output**: `termPoints` (display labels) + `termContacts` (contacts per
   terminal index for wire matching).

### Well contact rule

- Physical well contact shape exists → bulk gets positive `nextNet()` ID
  (regardless of metal1/via connectivity). Only if NO well contact at all →
  sentinel -2 → resolved to VDD/GND at die level.

### VDD/GND config persistence

- `AnalogNetlistPage.tsx`: VDD and GND name fields in SubBar
- `SpiceConfig` loaded on mount from backend, auto-saved with 500ms debounce
- Merges with existing config (preserves technology, models, etc.)
- `@globalpowernet@` / `@globalgroundnet@` placeholders in SPICE netlist

### Adding a new device type

1. **Define terminal layers** in `DEVICE_TERMINAL_DEFS` (`dieWideAnalog.ts`)
2. **Add marker extraction** in `extractMarkedDevices()` (`simpleAnalog.ts`):
   marker map, prefix map, case block
3. **Add netlist format** in `spice.ts`: term order, params, model, prefix
4. **Add overlay colour** in `AnalogDeviceHighlights.tsx`: color, fill, label

### Overlay rendering

`AnalogDeviceHighlights` component:
- Filled coloured bbox + label (`M1 pmos`, `Q3 npn`, …)
- Parameters below label (W/L, AE, squares)
- Terminal points at contact positions (G, S/D, B, …)
- Zoom-based hiding: terminal labels fade below 0.7×, params below 0.5×
- Devices sharing a cellId concatenate instance names ("M4 M5")
