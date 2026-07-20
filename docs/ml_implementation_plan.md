# ML/CV Implementation Plan

## Decisions Made

| Question | Decision |
|----------|----------|
| Via layer approach | Separate models per layer (one checkpoint per via layer). |
| Image source for ML | Automatically use the currently visible overlay (or base image if none). |
| CV cell detection | **Contour pipeline** (multi-contour: extract all contours from ref, match each candidate against best ref). **Template pipeline** (Sobel → matchTemplate) as alternative with better rotation handling. Both implemented. |
| Cell training | No training needed — contour shape descriptors + template matching are sufficient. |

---

## Phase 1: Multi-layer ML Vias + Overlay Support

### Phase 1.1 — ML Export & Inference on overlay image

**Backend:**

| File | Change |
|------|--------|
| `backend/src/api/mlExport.ts` | Add `overlayFilename?: string` to request body |
| `backend/src/mlExport/exporter.ts` | When `overlayFilename` is set, read overlay instead of `originalPath`. Adjust coordinate scaling. |
| `backend/src/api/ml.ts` | Routes `/vias` and `/vias/tile` accept optional `overlaySource` query param |
| `backend/src/ml/predict.ts` | `runPrediction` loads overlay image when `overlaySource` is provided |

**Frontend:**

| File | Change |
|------|--------|
| `frontend/src/api/ml.ts` | `exportMlData` passes current visible overlay filename. `startMLJob` passes overlay source. |
| `frontend/src/routes/DieViewerPage.tsx` | When triggering inference or export, read current visible overlay from `useOverlayLayers` |
| `frontend/src/state/preferences.ts` | Add `mlSourceOverlay: string \| null` |

**Shared types:**

| Type | Change |
|------|--------|
| `MLExportRequest` | Add `overlayFilename?: string` |
| `MLInferenceJob` | Add `overlayFilename?: string` |

### Phase 1.2 — GUI Inference + Multi-Layer Vias Workflow

**Frontend — ML tab in die viewer (`InspectorTab = "ml"`):**

- **Model selector**: list available checkpoints from `/api/ml/models`. Infer via layer from filename convention (e.g. `via12_model.pt` → VIA12).
- **Via layer badge**: show which via layer the active checkpoint corresponds to.
- **"Run inference" button**: starts die-wide inference job. Disabled if no model loaded or job running.
- **"Source" badge**: "Source: {overlay filename}" or "Source: base image".
- **Confidence threshold slider**: already exists.

**ML vias as editable annotations:**

- Currently ML vias are a read-only overlay layer (`MLViasLayer.ts`)
- **"Approve selected" button** (ML tab, active when ML vias selected):
  - Converts selected ML vias to `HumanAnnotation` with `source: "approved"`, `layer: "VIA12"`
  - After approval: editable/deletable on AnnotationLayer
- **"Place all ML vias" button**: bulk-approve visible ML vias with confidence > threshold
- ML via colour by layer (from metalStack config)

**Backend:**

| File | Change |
|------|--------|
| `backend/src/ml/predict.ts` | `toPrediction` adds `viaLayer` to each via point (from checkpoint filename) |

**Shared types:**

| Type | Change |
|------|--------|
| `MLVia` | Add `viaLayer?: string` |

**Python sidecar:**

| File | Change |
|------|--------|
| `ml/sidecar.py` | `/health` returns `via_layer` (inferred from checkpoint filename) |

### Phase 1.3 — ML Export overlay info

**Frontend — export dialog:**

- Show source info: "Source: {visible overlay name}" or "Source: base image"
- Optional toggle

**Backend:**

| File | Change |
|------|--------|
| `backend/src/mlExport/exporter.ts` | Write `source_image` as overlay filename. Handle different overlay dimensions. |

---

## Phase 2: CV Cell Detection (Contour Pipeline)

### 2.1 — Reference code analysis (done)

Studied `docs/reference/cv/`:

| File | Approach | Key techniques |
|------|----------|----------------|
| `1/o.py` | Pixel template matching | Sobel → matchTemplate(TM_CCOEFF_NORMED) + imgaug (rotate, noise) |
| `1/import cv2.py` | Feature matching | ORB + BFMatcher (NORM_HAMMING) |
| `2.py` | Contour-based | CLAHE → bilateral → sharpen → 6 binarization variants → contour → matchShapes + 6 weighted metrics + NMS. Full GUI app. |

**Adopted from reference:**

| Technique | Source | Why |
|-----------|--------|-----|
| CLAHE → bilateral → sharpen | `2.py` | SEM-specific preprocessing |
| 6 binarization variants + morphology | `2.py` | Handles varying SEM contrast |
| Multi-contour extraction (all contours, not just best) | custom | Preserves pocket + base + emitter signature |
| Shape descriptors (aspect, solidity, extent, circularity) | `2.py` | Describe transistor geometry |
| `matchShapes()` (Hu moments) | `2.py` | Rotation/scale-invariant |
| Weighted distance formula | `2.py` | Combines 6 metrics into single score |
| NMS (IoU + center) | `2.py` | Eliminates overlapping detections |
| Sobel → matchTemplate pipeline | `1/o.py` | Pixel-level pattern matching for whole-cell references |

**Not adopted:**
- ORB feature matching (`1/import cv2.py`) — not needed
- Deroute NeuralNetwork (C# simple NN) — too basic for our use case

### 2.2 — Python sidecar CV endpoint (implemented)

**File: `ml/cv_match.py`** — three pipelines:

Pipeline:

```
reference ROI crop
  ↓
PREPROCESS: CLAHE(clipLimit=3.0, (8,8)) → bilateralFilter(7,45,45) → GaussianBlur(3,3) → sharpen(1.45, -0.45)
  ↓
6 BINARIZATION VARIANTS:
  · THRESH_BINARY + OTSU
  · THRESH_BINARY_INV + OTSU
  · ADAPTIVE_THRESH_GAUSSIAN_C + THRESH_BINARY (31, 4)
  · ADAPTIVE_THRESH_GAUSSIAN_C + THRESH_BINARY_INV (31, 4)
  · ADAPTIVE_THRESH_MEAN_C + THRESH_BINARY (35, 3)
  · ADAPTIVE_THRESH_MEAN_C + THRESH_BINARY_INV (35, 3)
  ↓ morphology: open(3,3) → close(3,3)×2 → close(5,5)×1
  ↓
FIND EXTERNAL CONTOURS across all variants
  ↓ dedup by quantized bbox key
  ↓
CHOOSE BEST REFERENCE CONTOUR from ROI:
  score = area × (0.45 + 0.20·extent + 0.20·solidity + 0.15·circularity)
  (ignore contours > 97% of ROI area or < min_area)
  ↓ normalize with approxPolyDP (ε = 0.01·arcLength)
  ↓
  = reference contour
  ↓
FULL SEARCH IMAGE → same preprocessing + all contours (globally)
  ↓
FOR EACH CANDIDATE CONTOUR:
  ┌────────────────────────────────────────────┐
  │ area_ratio = area / ref_area              │
  │ shape_dist = matchShapes(ref, cnt, I2, 0) │
  │ aspect_err, solidity_err, extent_err,     │
  │ circularity_err                           │
  │                                           │
  │ FILTER:                                   │
  │  · area_lo ≤ ratio ≤ area_hi              │
  │  · shape_dist ≤ shape_thresh (1.25)       │
  │  · aspect_err ≤ aspect_thresh (1.25)      │
  │  · solidity_err ≤ solidity_thresh (0.60)  │
  │  · extent_err ≤ extent_thresh (0.60)      │
  │  · circularity_err ≤ circularity_thresh   │
  │    (0.75)                                 │
  │                                           │
  │ total_score =                             │
  │   1.9·shape_dist + 0.9·aspect_err +       │
  │   0.55·solidity_err + 0.55·extent_err +   │
  │   0.45·circularity_err +                  │
  │   0.35·|1 - area_ratio|                   │
  └────────────────────────────────────────────┘
  ↓
NMS (IoU ≤ 0.22 or center_dist < 10px → suppress smaller)
  ↓
Rotation detection: for each matched contour, rotate reference
contour by N angles (0°, 90°, 180°, 270°), pick best matchShapes
  ↓
sort by total_score asc → return [{x, y, rotation, confidence, bbox}]
```

Parameters (adjustable):

| Param | Default | Description |
|-------|---------|-------------|
| `shape_thresh` | 1.25 | Max matchShapes distance |
| `area_lo` | 0.22 | Min area ratio (candidate / ref) |
| `area_hi` | 4.5 | Max area ratio |
| `aspect_thresh` | 1.25 | Max aspect ratio error |
| `solidity_thresh` | 0.60 | Max solidity error |
| `extent_thresh` | 0.60 | Max extent error |
| `circularity_thresh` | 0.75 | Max circularity error |
| `min_area` | 12 | Minimum contour area (px²) |
| `min_distance` | 10 | NMS center distance threshold |
| `rotation_steps` | 4 | Rotation detection angles (1, 2, or 4) |

**`ml/sidecar.py` — new endpoint:**

```python
@app.post("/cv/match")
def cv_match(
    reference: UploadFile = File(...),
    search: UploadFile = File(...),
    threshold: float = Form(0.7),        # total_score → confidence: 1/(1+total)
    rotation_steps: int = Form(4),
    max_matches: int = Form(100),
    min_distance: int = Form(10),
    # Pass-through for contour params (optional, use defaults if omitted)
    shape_thresh: float = Form(1.25),
    area_lo: float = Form(0.22),
    area_hi: float = Form(4.5),
    aspect_thresh: float = Form(1.25),
    solidity_thresh: float = Form(0.60),
    extent_thresh: float = Form(0.60),
    circularity_thresh: float = Form(0.75),
    min_area: int = Form(12),
) -> dict:
    """Contour-based cell matching.
    Returns {matches: [{x, y, rotation, confidence, bbox}], total: N}
    """
```

### 2.3 — Backend CV route

**`backend/src/api/ml.ts`:**

| Route | Description |
|-------|-------------|
| `POST /api/ml/cv/match` | Proxy to sidecar. Accepts dieId + cellTypeId (for crop) + optional overlayFilename. Returns matches in die-global coordinates. |

**`backend/src/ml/predict.ts`:**

- `runCVMatch(params)`: crops reference cell from die/overlay, crops search region (full die or visible area), calls sidecar, translates coordinates back to die space

### 2.4 — Shared types

```typescript
export interface CVMatchResult {
  x: number;             // die-global x
  y: number;             // die-global y
  rotation: 0 | 90 | 180 | 270;
  confidence: number;    // 0..1, derived from total_score
  bbox: [number, number, number, number]; // x, y, w, h in die coords
}

export interface CVMatchRequest {
  dieId: string;
  cellTypeId: string;
  overlayFilename?: string;
  threshold?: number;
  rotationSteps?: number;
  maxMatches?: number;
  minDistance?: number;
  // contour-specific (optional, use defaults)
  shapeThresh?: number;
  areaLo?: number;
  areaHi?: number;
  aspectThresh?: number;
  solidityThresh?: number;
  minArea?: number;
}

export interface CVMatchResponse {
  matches: CVMatchResult[];
  referenceBbox: [number, number, number, number];
  searchRegion: [number, number, number, number];
  total: number;
}
```

**Cell type changes:**

| Type | Change |
|------|--------|
| `Cell` | Add `mlDetected?: boolean`, `mlConfidence?: number` |

### 2.5 — Frontend GUI: "Set as CV reference"

**ML/CV tab additions:**

- **CV Cell Detection section**
- **Condition**: cell with ≥1 analog device must be selected
- **"Set as CV reference" button**:
  - Stores `cellTypeId` as the CV reference
  - Shows preview: cropped image of the reference cell
- **Parameters**:
  - Confidence threshold (slider, 0–100%)
  - Rotation steps (1, 2, or 4)
  - Max matches (number)
  - Advanced expandable: contour-specific params
- **"Run CV detection" button**: triggers `POST /api/ml/cv/match`

**After CV matching:**

For each match with confidence > threshold:
1. Find existing `CellType` matching the reference
2. Create `Cell` instance at match coordinates with rotation
3. Set `mlDetected: true` and `mlConfidence`
4. All instances share the same `CellType` (linked until "Make unique")

**Rendering:**
- ML-detected cell rectangles: dashed border, distinct colour
- Click shows confidence score in inspector

### 2.6 — ML folder in left panels

**`MergeLeftPanel.tsx` / `CellRELeftPanel.tsx`:**

- ML folder (placeholder exists) populated with CV-detected cells:
  - `TreeRow` per ML-detected cell type (dimmed)
  - Instance rows show confidence score
  - Right-click context menu:
    - **"Accept"** → removes `mlDetected` flag, cell becomes normal
    - **"Reject"** → deletes cell instance (and cell type if last instance)
    - **"Make unique"** → breaks type link

---

## Plan B (not implemented yet)

**Template pipeline** (Sobel → matchTemplate):
- May be added later if contour pipeline has insufficient recall for certain cell types
- Simpler, faster, but less robust to imaging condition changes

**Deroute NeuralNetwork**:
- Evaluate if both CV approaches underperform

---

## Implementation Order

| Step | Phase | Description | Dependencies |
|------|-------|-------------|--------------|
| 1 | 1.1 | Overlay image support in ML export + inference | None |
| 2 | 1.2 | GUI inference controls, via layer display, approve workflow | Step 1 |
| 3 | 1.3 | Overlay support in ML export dialog | Step 1 |
| 4 | 2.2 | Python sidecar `ml/cv_match.py` (contour pipeline) | None (can parallel with Phase 1) |
| 5 | 2.3 | Backend CV route + coordinate translation | Step 4 |
| 6 | 2.4 | Frontend CV reference GUI + cell placement | Step 5 |
| 7 | 2.5 | ML folder population + accept/reject workflow | Step 6 |
