# Contour-based Cell Detection (Experimental)

A two-stage CV pipeline that finds transistor cells on a die image by
detecting pocket-like contours and verifying their internal structure.

## Pipeline

### Stage 1 — Pocket Detection

- Canny edge detection (threshold 20/80) + morphological close
- Finds all closed external contours on the full die image
- Filters by: `area_lo ≤ area / ref_pocket_area ≤ area_hi`
- Additional filters: `shape < shape_thresh`, `asp_err < aspect_thresh`
- NMS eliminates overlapping candidates
- Returns a list of "pocket candidates"

### Stage 2 — Internal Structure Verification

For each pocket candidate:
1. **Crop** around the pocket (margin = pocket size)
2. Run `extract_all_contours_from_roi` on the crop (THRESHOLD-based, same as reference)
3. **Loose match** crop contours against all reference contours
4. **Count filter**: requires both a "large" (pocket) match and `min_ref_matches` small (internal) matches
5. **Structural verification**: compares area ratios and relative positions of internal contours against reference (gaussian similarity)
6. Accept if `struct_score > struct_thresh`
7. **Dedup** by centroid proximity keeps highest-confidence result per location

## Key Parameters

| Param | Default | Effect |
|-------|---------|--------|
| `detection_mode` | `canny` | `canny` or `threshold` |
| `area_lo / area_hi` | 0.8 / 1.2 | Pocket size tolerance (±20%) |
| `shape_thresh` | 1.5 | Max matchShapes distance |
| `aspect_thresh` | 0.5 | Max aspect ratio error |
| `min_ref_matches` | 2 | Required internal contour matches |
| `struct_thresh` | 0.25 | Internal structure similarity threshold |
| `min_area` | 200 | Minimum contour area (px²) |
| `min_distance` | 10 | NMS / dedup distance (px) |

## Detection Modes

- **Canny** (default): Works better on uniform-brightness images where
  threshold-based binarization fails to produce closed regions
- **Threshold**: Uses 6 binary variants (Otsu, Adaptive Gaussian, Adaptive Mean)
  with morphological cleaning. Better when local contrast varies.

## Files

- `ml/cv_match.py` — main pipeline: `match_contour_pipeline`
- `ml/sidecar.py` — endpoints: `/cv/match`, `/cv/debug`, `/cv/debug-dump`
- `frontend/InspectorPanel.tsx` — GUI controls in the ML tab
