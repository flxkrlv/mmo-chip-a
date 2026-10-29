# Vector mode: runs decoder + seamless whole-die sweep + orthogonal skeletonization research

State: 2026-10-29, branch `experimental` (wire detection lives here until mature).

## What was built today

### 1. Runs decoder (`ml/wire_runs.py`) — one wire = one trace

Replaces the raw skeleton walk for the vectorize path (`extract_trace_skeleton`
stays for the ML path). The skeleton branch graph is post-processed the way
chip drawings actually look:

1. **Short noise arms drop in the graph phase** (branches < `min_len`), BEFORE
   junction dissolving — otherwise stubs keep spurious junctions alive and a
   straight wire keeps splitting.
2. **Collinear pass-through junctions dissolve**: a node with exactly two
   incident branches whose directions align (≤30°) is removed and the
   branches concatenate. Real corners (~90°) and T/X junctions survive.
3. **Straight-run simplification**: Douglas-Peucker (ε=2.5 px) + fusing
   consecutive segments that turn <20° → vertices only at real 45°/90° turns.
4. **Grouping**: connected components of the surviving graph → `group` id per
   trace. One closed contour = one group = one net candidate ("inside a
   closed contour there can be only one node" — a second one would be a
   virtual break). Materialization unions by `group` first, then by shared
   endpoints.

Synthetic verification: straight wire + noise stubs → ONE 2-point trace;
L-wire → one trace, one 90° turn; T-junction → 3 arms, one group; closed
ring → one group; 45° diagonal → single straight segment. 9/9 offline tests
(`python ml/test_vectorize.py`).

### 2. Whole-die sweep v2 — seamless by construction

The old block sweep decoded each 2048-px block independently → wires got cut
at block seams (the user saw exactly that). Now:

- Each block posts its (padded) crop to `POST /vectorize/mask`; the sidecar
  returns a **binary mask** whose core is pixel-exact (the padding covers
  morphology kernels + the adaptive-gaussian block, so every op saw its full
  neighbourhood).
- The backend pastes the cores into ONE die-sized mask → decodes it ONCE via
  `POST /vectorize/decode`. **Tile seams are impossible by construction** —
  a wire is always decoded whole.
- The payload is cached as `full.json` under
  `dataRoot/vectorize/<dieId>/<paramsHash>/`; `GET /vectorize/blocks` serves
  it for any viewport. The overlay prefers it; live viewport decode is the
  fallback while a sweep hasn't run for the current params.

### 3. Robustness fixes found by live testing

- Buffer values must be 0/**255** (not 0/1) — the decode thresholds `>127`.
- Paste offset is `x0-cx0` exactly (a double-pad shift once zeroed the mask;
  caught by nonzero-counting on the saved `mask.png` debug artifact).
- Sweep endpoints are intentionally **not** CV-gated: the user's live
  viewport decodes kept starving the sweep with 429s. The live overlay also
  pauses itself (store flag) while a sweep runs. Retries: 20×3 s; global
  decode timeout 30 min (it takes ~5–6 min for a 57 Mpx die).
- **Coverage guards**: a bright-field die with a wide brightness band yields
  a 90 %+ white mask — junk in, crash out (the first run died in
  skeletonize with no traceback). Now: the sweep aborts after 3 blocks with
  "threshold captures ~N% — that is background, not metal", and `/vectorize/
  decode` refuses >70 % coverage. NB on this die's image: median 168
  (bright) — the default [120..255] band selects 92.6 % of the frame; the
  band/pipette must be tuned first (for dark metal: band [140..255] +
  `dark metal` ≈ 17 %).
- A killed backend leaves an **orphaned decode** holding the sidecar's CV
  gate for ~5 min (uvicorn logs after completion) — restart the sidecar to
  clear.
- Overlay cache poisoning: a completed-but-empty sweep wrote a 50-byte
  `full.json` (valid JSON, empty arrays) which the overlay trusted and went
  permanently blank ("0 trace(s) decoded", no outlines). Fixed: an all-empty
  payload is treated as a cache miss (live fallback), and the layer caches
  nothing empty. Poisoned files removed.

## Orthogonal skeletonization: research answer

The user asked: is there an algorithm that finds traces by themselves as the
most straight, only-orthogonal-or-diagonal paths inside the (already good)
metal polygons?

**Short answer: yes — it's the Straight Skeleton of the polygon** (the thing
CGAL ships as `Straight_skeleton_builder_2`), plus the Voronoi/medial-axis
family as the pixel-side sibling. What the options are, for our stack:

| Approach | What it gives | Fit for us |
|---|---|---|
| **Straight skeleton** (Felkel & Obdržálek 1998; CGAL 2D Straight Skeleton & Polygon Offsetting) | Defined **on a polygon**: edges move inward at equal speed; the wavefront trace is the skeleton. For rectilinear input the skeleton is rectilinear; bisector arcs appear only at true 45° geometry. No pixel noise, no spurs — spurs are impossible by construction. One closed contour → one skeleton tree → its "spine" = the wire. | **The canonical answer.** Needs the pipeline the user proposed: contours → (simplify) → skeleton per polygon. No mature pure-Python lib; CGAL binding (C++/pybind11) or a hand-rolled wavefront. |
| **Medial axis via Voronoi of boundary samples** (`scipy.spatial.Voronoi` on densely sampled contour points; clip to inside; drop parabolic arcs near reflex vertices) | Approximates the polygon medial axis with **zero new dependencies**; straight edges between Voronoi vertices; naturally centered. | Practical middle ground: implementable in ~100 lines in `wire_runs.py` as an alternative decoder mode; then the existing DP + turn-fusion straightens it. |
| Pixel thinning (Zhang–Suen / Guo–Hall / skimage `skeletonize`) + graph post-processing — **what we have now** | Cheap, works on the mask directly, no contour step. Orthogonality is achieved by post-fusion, not guaranteed. | Already good on synthetic + live ROI (296 traces / 157 groups); keep as the default "fast" mode. |
| Distance-transform ridge + directional walking ("grassfire with momentum") | Walk from endpoints, prefer neighbours that continue the current quantized direction; turn only on ±45°/90° evidence. | Simple custom variant; sensitive to width changes; a fallback if Voronoi disappoints. |
| CEASAR / level-set centerlines (Bitter et al.) | Robust 3D centerlines for volumes. | Overkill for 2D dies. |

**Decision**: adopt the user's architecture — contours first (they're already
excellent), then a **polygon-based skeleton**. Concretely:

1. Keep the mask + `extract_trace_polylines` contours (works).
2. Simplify each contour (approxPolyDP ε≈1–2 px) → closed polygon.
3. Compute the polygon skeleton per contour:
   - v1: Voronoi-medial-axis (scipy, no new deps), prune parabolic/short
     spurs, take spine + real junctions;
   - v2 (if needed): bind CGAL's straight skeleton (`cgal-skk` / pybind11)
     for exact rectilinear behaviour.
4. Straighten with the existing DP + turn fusion; emit traces with `group`
   (one contour = one group — unchanged contract downstream).

This also removes the width-filter's job: a skeleton computed *inside a
clean polygon* has no blob/noise problem — width stays only as metadata
(wire width in µm for SPICE).

## What the user should do after reload

1. Tune the band (or pipette) on the visible source until the preview shows
   metal only — the coverage guard now stops the sweep with a clear message
   if the threshold catches background.
2. Press **Decode whole die** (~1 min masks + several minutes global decode).
3. Pan/zoom — traces come from the cache; **Vector → nets** materializes
   with group-aware one-contour-one-net semantics.
