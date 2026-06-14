# Plan — mmo-chip mixed-signal RE

## Progress (2026-06-14)

### ✅ Done Today

**1. Analog Netlist tab**
- New route `/analog-netlist`, tab "Netlist (Analog)" in TopBar
- Left panel: device instances grouped by kind (MOS, BJT, R, C, D…) with color swatches
- Right panel: CodeViewer with CDL/Spectre/HSPICE syntax highlighting
- Dialect selector toolbar (CDL | Spectre | HSPICE)
- Copy/download netlist
- Warnings panel (unconnected terminals, etc.)

**2. Cross-tab navigation**
- **Analog Netlist → Die Viewer**: double-click device instance → navigate to die viewer, camera frames the cell, device highlighted in Inspector
- **Die Viewer → RE Cell**: double-click on any cell annotation on die image (analog device bbox OR drawn rect cell) → opens in RE Cell with that cell
- **Die Viewer → RE Cell** (from Items panel): link icon 🔗 per cell row

**3. Hotkeys**
- Number keys `1`-`5` for tab switching (1=Die viewer, 2=Merge, 3=RE Cell, 4=Code, 5=Netlist Analog)
- Defined in `NAV_HOTKEYS` in `hotkeys.ts`
- Global listener in `App.tsx` (ignores inputs/modifiers)

**4. Performance fixes**
- Removed debug `console.log` from `dieWideAnalog.ts` (was logging every wire-match, hundreds per tick)
- `analogDevicesRef` prevents `TiledCanvas` re-renders on annotation ticks (was flushing tile cache, causing ~1s base image reload)
- Removed `analogDevices`/`annotations` from `onCanvasClick`/`onCanvasDoubleClick` dependency arrays (use refs)

**5. Bugfixes**
- `AnalogDeviceHighlights` canvas had `pointerEvents: "auto"` → stole all mouse events (pan/zoom/drag broken). Reverted to `pointerEvents: "none"`, click handling moved to `onCanvasClick`/`onCanvasDoubleClick` in DieViewerPage
- Focus retry with `setTimeout` when `canvasHandle.current` is null (TiledCanvas not mounted yet)
- URL query params (`?focusCell=&focusDevice=`) for cross-tab focus (more reliable than `location.state`)

---

### Next (short-term)

**Netlist visualization (Level 3 — SPICE graph view)**
- Parse CDL → device net graph
- Render as force-directed graph with Cytoscape.js or similar
- Click on graph node → frame cell on die viewer + select device
- Integration as sub-tab or separate page

**Die viewer CDL preview sync**
- Currently independent from Netlist tab (both call `collectDieWideAnalogDevices`)
- Shared state for selected device → highlight in both views

**SPICE netlist quality**
- Named nets from IO pins + annotation net names
- Model cards (.MODEL) with extracted parameters
- Dialect-specific formatting tweaks

---

### Future directions (from earlier discussion)

1. Syntactic viewer + instance tree ← done (Netlist tab)
2. Click device → frame on die ← done
3. SPICE deck as clickable net graph ← current target
4. Full schematic capture (bidirectional)
5. Symbolic schematic canvas (NMOS → transistor symbol, R → zigzag)
6. Integration with ngspice simulation
