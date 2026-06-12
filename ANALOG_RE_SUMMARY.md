# SESSION SUMMARY — analog-re-wip branch

## Context

We are working on extending [mmo-chip](https://github.com/flxkrlv/mmo-chip-a) (a die RE tool) with analog/mixed-signal circuit extraction — the **analog-re-wip** branch on the fork `flxkrlv/mmo-chip-a`.

The original repo: `giulioz/mmo-chip` (CMOS gate array / standard cell reverse engineering tool).  
Our fork: `github.com/flxkrlv/mmo-chip-a`, branch `analog-re-wip`.

## What has been implemented (working)

### 1. Wire-to-terminal snapping ✅
- **`frontend/src/lib/extraction/terminalDetect.ts`** — auto-detects cell terminals by finding `metal1 ∩ contact` overlaps on each cell type. Returns `InstanceTerminal[]` with die-world coordinates.
- **`frontend/src/components/dieViewer/useWireTool.ts`** — extended with:
  - `TerminalSnapTarget` type + `TERMINAL_SNAP_TOLERANCE_PX`
  - `findNearestTerminal` optional callback in hook options
  - `resolveTerminalSnap()` — finds nearest terminal within tolerance
  - Modified `resolveWireSnap()`, `addWirePoint()`, `computeWirePreview()` — terminal has priority between edge-split and via
- **`frontend/src/components/dieViewer/snapHalo.ts`** — added `drawTerminalHalo()` (orange ring + crosshair) + `TERMINAL_RING_COLOR`
- **`frontend/src/components/dieViewer/WireDraftOverlay.tsx`** — draws orange terminal halo on hover/preview
- **`frontend/src/routes/DieViewerPage.tsx`** — wired `findNearestTerminal` callback into `useWireTool` via `buildInstanceTerminalMap` memoized on `annotations`

**Bug fixed:** `snapRef.current = {...}` reassignment was missing `findNearestTerminal` — the ref value was lost on every render.

### 2. SPICE/CDL export (pre-existing, works)
- **`frontend/src/lib/export/spice.ts`** — generates CDL/Spectre/HSPICE from `AnalogDevice[]`
- **`frontend/src/api/dieWideAnalog.ts`** — `collectDieWideAnalogDevices()` matches cell instances to die-level wires, assigns instance names (Q1, M1, R1...)
- **`frontend/src/components/dieViewer/AnalogDiePanel.tsx`** — right-panel UI: device count, CDL copy button, per-kind breakdown

### 3. Changes to support analog layers
- **`frontend/src/state/cellRE.ts`** — `TOOL_LAYERS` now includes `wire_hitbox` for rect/polygon tools (was missing)
- **`frontend/src/state/dieViewer.ts`** — defined `AnalogLayerId` type (was missing, caused compilation error)

## What has been partially implemented (not yet integrated — code exists on branch)

### 4. Device highlighting overlay
- **`frontend/src/components/dieViewer/AnalogDeviceHighlights.tsx`** — canvas overlay that draws:
  - Colored bounding boxes per device kind (green=NPN, blue=MOS, orange=resistor, cyan=cap, red=diode)
  - Instance name labels (Q1, M1, R1) with dark background
  - Parameter hints (W/L for MOS, AE for BJT, resistance for resistors)
  - Click hit-test → fires `onDeviceClick` callback
  - Properly subscribes to `LiveValue<Viewport>` via ResizeObserver + rAF (no render-loop)
- **Not yet wired into DieViewerPage.tsx** — was causing infinite render loop, rolled back. Needs careful integration.

### 5. Device inspector panel
- **`frontend/src/components/dieViewer/DeviceInspector.tsx`** — right-panel showing:
  - Device kind, instance name, model name
  - Geometry: W/L, AE, squares, capacitance, multiplier/fingers
  - Terminal nets
  - Bounding box position
- **Not yet wired** — was replacing AnalogDiePanel when a device was selected.

## How snapping works (user-facing)

1. User draws `metal1` + `contact` layers in Cell RE (intersecting shapes)
2. `terminalDetect.ts` finds all metal1∩contact overlaps → terminal positions
3. `buildInstanceTerminalMap()` converts cell-local → die-world coordinates using cell instance positions
4. On die viewer, when wire tool is active, cursor snaps to terminal centers
5. Orange halo (vs blue for vertex snap) appears
6. Click places a wire node at terminal center
7. SPICE export's `matchWireNetId()` finds the node by distance → accurate net matching

**No `wire_hitbox` needed** for snapping — metal1+contact is sufficient. `wire_hitbox` is a fallback.

## Current state

- Branch: `analog-re-wip` on `flxkrlv/mmo-chip-a`
- Snapping works; user confirmed orange halo appears at terminal positions
- Die viewer right panel has working AnalogDiePanel (device count + CDL export)
- Device overlay needs re-integration (was causing render freeze)
- SPICE netlist export confirmed working:
  ```
  * Source: DIE_ANALOG
  .SUBCKT DIE_ANALOG net2020 net2021 net2022 net6150 net6153 net6154 VDD GND
   Q1 net6153 net6154 net6153 NPN_GEN AREA=5.73e-9
   ...
  .MODEL NPN_GEN NPN (BF=200 IS=1e-16 VAF=50)
  ```

## User details
- GitHub: `flxkrlv`
- Workspace: `F:\MMOCHIP_WORKDIR\mmo-chip`
- Running via `npm run dev` on http://localhost:5173
- Die ID used for testing: `5ab40aca-43f3-43ca-9657-63897cc427bc`
- Has 30+ cell types, 33 cell instances on the test die
- Cell types have metal1+contact shapes (4 metal1 per NPN cell type)

## Known issues / next steps

1. **Device overlay crashes die viewer** — `AnalogDeviceHighlights` integration in DieViewerPage.tsx caused infinite render loop, was rolled back. Needs stable integration (component itself is fine — subscribes to LiveValue correctly).
2. **Terminal snapping priority** — terminal shouldn't always beat voroni territory since some terminals are deep inside cells; may need z-order / area-based priority.
3. **`AnalogDiePanel.tsx` has unresolved imports:** `detectAnalogDevices` and `shapeToPolygon` are used but not imported. These only affect the die-level shape detection path (not cell-level), which is a secondary feature. The existing code path uses `collectDieWideAnalogDevices` which works fine.
4. **Device overlay needs a toggle button** — the checkbox UI was partially added in the right panel section.
5. **Netlist visualization** — explicitly deferred.

## Technology stack
- Frontend: React + TypeScript + Vite + Zustand
- Backend: Node + Express + tsx
- Shared types: `shared/src/types.ts`
- State management: Zustand stores + LiveValue for hot-path updates
- Rendering: Canvas 2D with tile pyramid for die images
- Drawing: AnnotationLayer with spatial index (RBush)
