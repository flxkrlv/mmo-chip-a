# Fix: Schematic SVG fit-to-container

## Problem

`Netlist2SvgView.tsx` injects an SVG from netlist2svg with explicit `width="5000"` `height="3000"` (or similar). This:

1. Blows out the page layout (horizontal scroll) because the SVG's intrinsic size exceeds the viewport
2. Panzoom cannot reach parts of the schematic beyond the "accessible" area — pan bounds are calculated from the container size, but the SVG content extends way past those bounds

## Diagnosis

- Container has `overflow: hidden` but the SVG child is still laid out at its intrinsic size
- `panzoom` is on the **container div** — it transforms the container, but the SVG content area is still physically huge, creating an invisible "dead zone" that can't be panned to

## Fix

**File:** `frontend/src/components/netlist/Netlist2SvgView.tsx` — `renderSchematic()` callback

**Change (lines 142-144):**

```typescript
container.innerHTML = svg;
svgRef.current = container.querySelector("svg");
if (svgRef.current) {
  // ── Fit SVG to container ─────────────────────────────
  svgRef.current.style.width = "100%";
  svgRef.current.style.height = "100%";
  svgRef.current.setAttribute("preserveAspectRatio", "xMidYMid meet");
  // ────────────────────────────────────────────────────
  colorPowerNets(svgRef.current);
  annotateDeviceData(svgRef.current, netlistJson);
  fixBlockLabels(svgRef.current);
}
initPanzoom();
```

**Why this works:**

| Before | After |
|--------|-------|
| SVG has `width="5000"` → renders at 5000px wide → overflows container | SVG has `style.width="100%"` → scales to container width via viewBox |
| Page layout broken by oversized SVG child | SVG stays within its parent bounds |
| Panzoom reachable area determined by oversized SVG → can't reach edges | SVG fits container → panzoom uses container bounds → navigation works everywhere |
| `getSvgString()` relies on `getAttribute("width")` which remains unchanged | Export still works — we set size via `style`, not `setAttribute` |
| Resize not handled | `width: 100%` responds to container resize automatically |

**No changes needed:**
- `startTransform: "scale(1)"` — correct, means "no extra transform" and SVG already fits
- `contain: "outside"` — keeps full navigation when zoomed in
- `minScale: 0.2`, `maxScale: 6` — fine
- Panzoom init on container div — unchanged
- All zoom controls (+/-/reset) — unchanged

## Verification

1. Open any analog netlist page — schema should fit the container without horizontal scroll
2. Zoom in/out with mouse wheel — should work, can reach all parts
3. Download SVG — file should have original dimensions
4. Resize panel — SVG should refit automatically
5. Cell-level schematic (`RECellPage` → `analogSchematic` tab) — same fix applies since it uses the same `Netlist2SvgView` component
