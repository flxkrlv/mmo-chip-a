# Reference / Legacy Code

This directory holds code removed from active development but kept as
algorithmic reference.

## Files

| File | Original location | Description |
|------|------------------|-------------|
| `analogDevices.ts` | `frontend/src/lib/extraction/` | Phase 1 auto-detection (dead code). See file header for notable algorithms. |

## Notable algorithms in `analogDevices.ts`

These functions exist only in that file (not replicated in `simpleAnalog.ts`):

- **`bodyCenterline()` / `bodyCenterlineLength()` / `bodyAvgWidth()`**  
  Medial axis extraction for resistor bodies. Finds the two farthest-apart
  parallel edges → centerline. Meander/serpentine detection.

- **`detectMultiplier()`**  
  Heuristic that finds repeated identical structures with equal spacing.

- **`polygonPrincipalAngle()`**  
  PCA-based orientation of a polygon.

- **Auto-detection functions** (`detectBJT`, `detectResistors`, `detectCapacitors`,
  `detectDiodes`, `detectJFET`)  
  Pure geometry-inference detectors (no user markers).

> ⚠️ These functions may not compile with current imports out-of-the-box.
> They serve as algorithm reference, not runnable code.
