# Analog Device Detection

## For users: how to draw devices

Device detection uses **marker layers** — you draw named shapes on specific layers
to tell the tool where each device is and what it is.

The detection runs on a **cell type** basis.  A cell type can contain multiple
devices; they are extracted at die-wide level and connected to die-level wires.

### MOS Transistor

MOS detection is **well-based** — no markers needed.  The tool infers
transistors from the actual layout layers:

| Layer | Purpose |
|-------|---------|
| `nwell` | PMOS transistors are detected here |
| `pwell` | NMOS transistors are detected here |
| `diffusion` | Body region (drain + source) |
| `polysilicon` | Gate fingers crossing the diffusion |

**Geometry:** W/L computed from polysilicon ∩ diffusion intersection.
Fingers = number of polysilicon stripes crossing one diffusion body.
Multiplier = devices with same type and W/L are grouped.

**Bulk:** The tool looks for contacts on nwell/pwell that are NOT also on
diffusion or polysilicon — those are bulk (well tap) contacts.  If the
well contact also touches diffusion, it's treated as S/D, not bulk.  If
no bulk contact exists at all:
- PMOS → VCC (bulk = power)
- NMOS → GND (bulk = ground)

Marker-based MOS (`mos_id` + drain/gate/source/bulk) is removed —
well-based handles everything automatically.

### BJT

| Layer | Purpose |
|-------|---------|
| `npn_id` | NPN bounding box |
| `pnp_id` | PNP bounding box |
| `collector` | Collector region |
| `base` | Base region (fallback: `bulk` layer) |
| `emitter` | Emitter region |

**Geometry:** AE = overlap(base, emitter).  PE = emitter perimeter (for LPNP).
Multiplier = number of emitter fingers.

### Diode

Two ways to draw:

1. **Marker `diode_id`** — diode detected from bbox. Rough area/perimeter.

2. **As NPN/PNP without collector** — draw `npn_id` (or `pnp_id`) with
   `base` + `emitter` layers but **no** `collector` layer.  The tool
   automatically detects this as a diode:
   - Base = anode (PLUS)
   - Emitter = cathode (MINUS)
   - area_um2 = AE (base-emitter overlap, same calculation as BJT)
   - perimeter_um = PE

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

**Geometry:** Squares = length / width. Resistance = squares × sheet R₀.
If body is drawn as a polyline, segments are summed (meander mode).

### Capacitor

| Layer | Purpose |
|-------|---------|
| `cap_id` | Bounding box (overlap area = capacitance) |

Capacitance = area × density (1 fF/µm² default).
Terminals: PLUS, MINUS — both on `contact` layer.

---

## For developers: architecture & how to add a new device

### Code layout

```
frontend/src/api/dieWideAnalog.ts       ← die-wide collection, terminal contact
                                          resolution, wire matching
frontend/src/lib/extraction/
  simpleAnalog.ts                       ← marker-based device extraction
  (detectMOSFromLayers() — well-based MOS)
  analogDevices.ts                      ← geometric parameter computation
  (computeMOSParams, computeBJTParams, …)
frontend/src/lib/export/spice.ts        ← CDL/Spectre/HSPICE netlist generation
frontend/src/components/dieViewer/
  AnalogDeviceHighlights.tsx            ← Canvas overlay with labels
```

### Pipeline

```
CellType layers
    │
    ├── extractMarkedDevices()     ← marker layers (npn_id, mos_id, …)
    │     │                             returns AnalogDevice[]
    │     └─ shapesInside()        ← find shapes inside a marker bbox
    │
    ├── detectMOSFromLayers()      ← nwell/pwell + diffusion + polysilicon
    │                                   returns AnalogDevice[] (MOS only)
    │
    └── merge: well-detected MOS replaces marker-detected MOS
              (dedup by device id)
    │
    ▼
  collectDieWideAnalogDevices()
    │
    ├── For each device instance:
    │     resolveDeviceContacts()  ← match contacts to terminals
    │         │                        returns termPoints + termContacts
    │         └── DEVICE_TERMINAL_DEFS table
    │
    ├── matchWireToPoint()        ← find die-level wires by proximity
    │
    └── generateSpiceNetlist()    ← CDL/Spectre/HSPICE output
```

### The terminal definition table

The heart of the system is `DEVICE_TERMINAL_DEFS` in `dieWideAnalog.ts`.
Each device kind declares:

```typescript
interface TerminalDef {
  name: string;          // Terminal name (D, G, S, B, E, C, PLUS, MINUS…)
  layers: string[];      // Layout layer names to check for this terminal
  priority?: number;     // Lower = wins (for overlapping layers, e.g. BJT)
}

const MOS_DEFS: TerminalDef[] = [
  { name: "D", layers: ["diffusion"] },
  { name: "G", layers: ["polysilicon"] },
  { name: "S", layers: ["diffusion"] },
  { name: "B", layers: ["bulk", "nwell", "pwell"] },
];
```

### Adding a new device type

1. **Define terminal layers** in `DEVICE_TERMINAL_DEFS`:
   ```typescript
   // in dieWideAnalog.ts
   const INDUCTOR_DEFS: TerminalDef[] = [
     { name: "PLUS",  layers: ["contact"] },
     { name: "MINUS", layers: ["contact"] },
   ];
   // Add to the dictionary:
   DEVICE_TERMINAL_DEFS["inductor"] = INDUCTOR_DEFS;
   ```

2. **Add marker extraction** in `extractMarkedDevices()` (`simpleAnalog.ts`):
   - Add to `markerMap` and `prefixMap`
   - Add a `case "inductor":` block that reads marker shapes and
     returns an `AnalogDevice` with proper terminals and geometry

3. **Add netlist format** in `spice.ts`:
   - Add to `termOrder()` (terminal pin order for SPICE)
   - Add to `paramString()` (geometry parameters output)
   - Add to `modelLine()` (model definition)
   - Add to prefix tables if needed

4. **Add overlay colour** in `AnalogDeviceHighlights.tsx`:
   - Add to `DEVICE_COLORS` and `DEVICE_FILL`
   - Add to `deviceTypeString()` if you want a custom label

### How `resolveDeviceContacts` works

This function matches contact-shapes to device terminals using these rules:

1. **Collect all contacts** from `ctLayers.contact` (no bbox filter — all contacts
   in the cell type are candidates; false positives for bulk are prevented by
   the exclusion rule).

2. **For each contact**, iterate over `dev.terminals` and look up the terminal's
   definition by **name** (not index — this is critical for devices where
   terminal order differs from the definition table).

3. **point-in-shape**: a contact matches a terminal if its center falls inside
   any shape on the terminal's declared layers.  Supports rect, polygon (ray
   casting), circle, point, and line shapes.

4. **Priority resolution** (BJT): if a contact falls inside multiple terminal
   layers (e.g. emitter ⊂ base), the terminal with the lowest `priority`
   number wins.  E(0) beats B(2).

5. **Shared-layer round-robin** (MOS D+S, 2T PLUS+MINUS): if no terminal has a
   priority, all matching terminals are kept as candidates.  The `bySig`
   grouping collects contacts by signature ("D,S" or "PLUS,MINUS") and
   distributes them via round-robin.

6. **Bulk exclusion** (MOS): a contact on nwell/pwell is B (bulk) **only if**
   it is NOT also inside a diffusion or polysilicon shape.  This prevents
   drain/source contacts from being mislabelled as bulk.

7. **Output**: `termPoints` (one display label per contact, post-round-robin)
   and `termContacts` (contacts per terminal index for wire matching).

### Well-based MOS detection

`detectMOSFromLayers()` in `simpleAnalog.ts` works without markers:

- Iterates nwell (PMOS) and pwell (NMOS) shapes
- For each well, finds overlapping diffusion → that's the body
- Finds polysilicon crossing the body → those are gates
- W/L = intersection dimensions, fingers = gate count
- Bulk net: well contact → via → metal1.  If missing → -2 (sentinel:
  resolved to VCC/GND in die-wide pipeline)
- S/D nets: dummy IDs from contacts on diffusion; die-wide wire matching
  resolves real connections

### Overlay rendering

`AnalogDeviceHighlights` in `AnalogDeviceHighlights.tsx`:

- Each device: filled coloured bbox + label (`M1 pmos`, `Q3 npn`, …)
- Label shows instance name + device type (from `deviceTypeString()`)
- Below label: parameter hints (W/L, AE, squares, …) — slightly larger font
- Terminal points: individual labels at contact positions (G, S/D, B, …)
- Zoom-based hiding: terminal labels vanish below 0.7× zoom, params below 0.5×
- Click/double-click: hit-tests bbox, click → inspect, double-click → open in RE Cell
