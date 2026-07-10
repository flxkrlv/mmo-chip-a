# Problem Navigator

A unified panel that collects and displays all detected issues on the die, accessible from the `IssuesChip` button in the die viewer's toolbar.

## Architecture

**Component:** `frontend/src/components/dieViewer/ProblemNavigatorPanel.tsx`

**Entry point:** Click `IssuesChip` (`N/M` in SubBar) → toggles `ProblemNavigatorPanel` in the right sidebar, replacing `AnalogDiePanel`.

## Problem Categories

| Section | Icon | Detection | Source |
|---------|------|-----------|--------|
| **CONNECTIVITY** | ⚡ | unConnPin: terminals with netId ≥ 2000 (no wire found) | `collectDieWideAnalogDevices()` |
| | | unConnNet: nets (100 ≤ netId < 2000) with ≤1 device terminal | `collectProblems().unconnNets` |
| **WIRING** | ⑂ | unConnWires: endpoints of metal1 edges from different nets within 20px | `collectProblems()` — spatial bucketing |
| **VIAS** | ◉ | DanglingVia: via annotation (point/irregular) without metal1 and/or metal2 edge within 15px | `collectProblems()` — point-to-segment distance |
| **I/O PINS** | ⊘ | PinMismatch: I/O pin name ≠ name of the nearest annotation net (within 20px) | `collectProblems()` |
| **OVERLAPS** | ⊗ | OverlappingWire: two annotation net segments on the same metal layer that physically intersect | `collectProblems()` — segment intersection |
| **ELECTRICAL** | ⚠/ℹ | Warnings from `detectDeviceWarnings()`: shorted pins, floating base/gate, polarity mismatch, etc. | `collectDieWideAnalogDevices().warnings` |

## Data Flow

```
collectDieWideAnalogDevices(annotations)
  → { devices, namedNets, netIdMap, warnings }
       ↓
collectProblems(annotations, devices, netNames)
  → { connErrors, unconnNets, unconnWires, danglingVias, pinMismatches, overlappingWires }
       ↓
parseWarnings(warnings, devices)    ← regex /^\[(WARN|INFO)\]\s+(\S+)/
  → { level, instanceName, message, device? }
       ↓
ProblemNavigatorPanel renders collapsible sections with keyboard navigation
```

## Interaction

- **Click a row** → zoom to the problem location (cell, net, or point)
- **↑/↓ arrows** → cycle through all clickable items, auto-zoom
- **Sections collapsed by default** → click header to expand

## Instance Name Stability

All warnings and device references use stable instance names (from the device registry). `assignStableInstanceNames()` runs before `detectDeviceWarnings()`, and bulk warnings generated during the cell-type loop are patched post-rename via `_origName` tracking.

## Files

| File | Role |
|------|------|
| `ProblemNavigatorPanel.tsx` | UI component, problem detection logic, types |
| `DieViewerPage.tsx` | Integrates panel, wires `focusOnIds`/`centerOn` |
| `DieToolbar.tsx` | `IssuesChip` — clickable button with error/warning count |
| `dieWideAnalog.ts` | `collectDieWideAnalogDevices()` — source of devices + warnings + netIdMap |
