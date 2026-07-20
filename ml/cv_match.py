"""Contour-based cell matching pipeline.

Adapted from the IC Topology Analyzer v2.2 approach (docs/reference/cv/2.py).
Key differences: no GUI, clean functions, rotation detection added, NMS tuned.
"""
from __future__ import annotations

import cv2
import numpy as np

# ── Default detection parameters (matching 2.py's PRESET) ──────────────

DEFAULT_PARAMS = {
    "shape_thresh": 1.25,
    "area_lo": 0.5,
    "area_hi": 2.0,
    "aspect_thresh": 1.25,
    "solidity_thresh": 0.60,
    "extent_thresh": 0.60,
    "circularity_thresh": 0.75,
    "min_area": 12,
    "min_distance": 10,
    "nms_iou_thresh": 0.22,
}


# ── Preprocessing ──────────────────────────────────────────────────────


def preprocess(gray: np.ndarray) -> np.ndarray:
    """CLAHE → bilateral filter → Gaussian blur → sharpen."""
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    den = cv2.bilateralFilter(gray, 7, 45, 45)
    blur = cv2.GaussianBlur(den, (3, 3), 0)
    sharp = cv2.addWeighted(den, 1.45, blur, -0.45, 0)
    return sharp


# ── Binary variants ────────────────────────────────────────────────────


def build_binary_variants(gray: np.ndarray) -> list[np.ndarray]:
    """Produce 6 binary variants (Otsu ±, Adaptive Gaussian ±, Adaptive Mean ±)
    with morphological cleaning."""
    _, bw1 = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, bw2 = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    bw3 = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                cv2.THRESH_BINARY, 31, 4)
    bw4 = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                cv2.THRESH_BINARY_INV, 31, 4)
    bw5 = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                cv2.THRESH_BINARY, 35, 3)
    bw6 = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                cv2.THRESH_BINARY_INV, 35, 3)

    kernel3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    kernel5 = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))

    variants: list[np.ndarray] = []
    for bw in (bw1, bw2, bw3, bw4, bw5, bw6):
        a = cv2.morphologyEx(bw, cv2.MORPH_OPEN, kernel3, iterations=1)
        b = cv2.morphologyEx(a, cv2.MORPH_CLOSE, kernel3, iterations=2)
        c = cv2.morphologyEx(b, cv2.MORPH_CLOSE, kernel5, iterations=1)
        variants.append(c)
    return variants


# ── Contour helpers ────────────────────────────────────────────────────


def contour_aspect(cnt: np.ndarray) -> float:
    rect = cv2.minAreaRect(cnt)
    w, h = rect[1]
    if min(w, h) < 1e-3:
        return 1.0
    return max(w, h) / min(w, h)


def contour_solidity(cnt: np.ndarray) -> float:
    hull = cv2.convexHull(cnt)
    hull_area = cv2.contourArea(hull)
    if hull_area < 1e-3:
        return 1.0
    return cv2.contourArea(cnt) / hull_area


def contour_extent(cnt: np.ndarray) -> float:
    _, _, w, h = cv2.boundingRect(cnt)
    rect_area = float(max(1, w * h))
    return cv2.contourArea(cnt) / rect_area


def contour_circularity(cnt: np.ndarray) -> float:
    area = cv2.contourArea(cnt)
    per = cv2.arcLength(cnt, True)
    if per < 1e-6:
        return 0.0
    return 4.0 * np.pi * area / (per * per)


def normalize_contour(cnt: np.ndarray, eps_ratio: float = 0.01) -> np.ndarray:
    eps = eps_ratio * cv2.arcLength(cnt, True)
    approx = cv2.approxPolyDP(cnt, eps, True)
    return approx if len(approx) >= 4 else cnt


# ── Contour extraction ─────────────────────────────────────────────────


def choose_best_contour_from_roi(roi_gray: np.ndarray,
                                  min_area: int = 12) -> np.ndarray | None:
    """Pick the best contour from a user-selected ROI using a weighted score.
    Returns the contour in ROI-local coordinates, or None."""
    variants = build_binary_variants(roi_gray)
    best_cnt = None
    best_score = -1.0
    roi_area = roi_gray.shape[0] * roi_gray.shape[1]

    for bw in variants:
        contours, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL,
                                       cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < min_area:
                continue
            if area > roi_area * 0.97:
                continue
            ext = contour_extent(cnt)
            sol = contour_solidity(cnt)
            circ = contour_circularity(cnt)
            score = area * (0.45 + 0.20 * ext + 0.20 * sol + 0.15 * circ)
            if score > best_score:
                best_score = score
                best_cnt = cnt

    if best_cnt is not None:
        best_cnt = normalize_contour(best_cnt)
    return best_cnt


def extract_all_contours_from_roi(roi_gray: np.ndarray,
                                   min_area: int = 12) -> list[np.ndarray]:
    """Extract ALL significant contours from a reference ROI.

    Unlike choose_best_contour_from_roi which returns the single best contour,
    this returns all contours that are:
      - Not touching the ROI border (likely external cell boundaries)
      - Above min_area
      - Not too large (> 97% of ROI)
    This preserves the unique multi-contour signature of a transistor
    (pocket boundary + base + emitter + contacts).
    """
    variants = build_binary_variants(roi_gray)
    seen: set[tuple[int, int, int, int]] = set()
    h, w = roi_gray.shape[:2]
    results: list[np.ndarray] = []

    for bw in variants:
        contours, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL,
                                       cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < min_area:
                continue
            if area > h * w * 0.97:
                continue
            x, y, cw, ch = cv2.boundingRect(cnt)
            if cw < 3 or ch < 3:
                continue
            # Skip contours touching the ROI border (external cell boundary)
            if x <= 2 or y <= 2 or x + cw >= w - 2 or y + ch >= h - 2:
                continue
            key = (int(x / 4), int(y / 4), int(cw / 4), int(ch / 4))
            if key in seen:
                continue
            seen.add(key)
            results.append(normalize_contour(cnt))

    return results


def find_all_contours(gray: np.ndarray,
                      min_area: int = 12) -> list[np.ndarray]:
    """Extract all external contours from the image, deduplicating across
    binary variants by quantised bounding box."""
    all_contours: list[np.ndarray] = []
    seen: set[tuple[int, int, int, int]] = set()

    for bw in build_binary_variants(gray):
        contours, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL,
                                       cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < min_area:
                continue
            x, y, w, h = cv2.boundingRect(cnt)
            if w < 3 or h < 3:
                continue
            key = (int(x / 4), int(y / 4), int(w / 4), int(h / 4))
            if key in seen:
                continue
            seen.add(key)
            all_contours.append(normalize_contour(cnt))

    return all_contours


# ── Matching ────────────────────────────────────────────────────────────


def contour_distance(template: np.ndarray, candidate: np.ndarray,
                     template_area: float) -> dict[str, float]:
    """Compute a weighted distance between two contours.

    Returns dict with raw metrics and a `total` score (lower = more similar).
    Mirrors the formula from 2.py.
    """
    t_aspect = contour_aspect(template)
    t_solidity = contour_solidity(template)
    t_extent = contour_extent(template)
    t_circ = contour_circularity(template)

    area = cv2.contourArea(candidate)
    ratio = area / (template_area + 1e-6)
    shape = cv2.matchShapes(template, candidate, cv2.CONTOURS_MATCH_I2, 0)

    asp = contour_aspect(candidate)
    sol = contour_solidity(candidate)
    ext = contour_extent(candidate)
    circ = contour_circularity(candidate)

    asp_err = abs(asp - t_aspect) / (t_aspect + 1e-6)
    sol_err = abs(sol - t_solidity)
    ext_err = abs(ext - t_extent)
    circ_err = abs(circ - t_circ)

    total = (1.9 * shape + 0.9 * asp_err + 0.55 * sol_err +
             0.55 * ext_err + 0.45 * circ_err + 0.35 * abs(1.0 - ratio))

    return {
        "shape": shape,
        "ratio": ratio,
        "asp_err": asp_err,
        "sol_err": sol_err,
        "ext_err": ext_err,
        "circ_err": circ_err,
        "total": total,
    }


def match_similar(template: np.ndarray, candidates: list[np.ndarray],
                  template_area: float,
                  params: dict | None = None) -> list[tuple[float, np.ndarray]]:
    """Filter candidates by threshold, return sorted list of (total_score, contour)."""
    p = {**DEFAULT_PARAMS, **(params or {})}
    scored: list[tuple[float, np.ndarray]] = []

    for cnt in candidates:
        area = cv2.contourArea(cnt)
        if area < p["min_area"]:
            continue

        m = contour_distance(template, cnt, template_area)

        if not (p["area_lo"] <= m["ratio"] <= p["area_hi"]):
            continue
        if m["shape"] > p["shape_thresh"]:
            continue
        if m["asp_err"] > p["aspect_thresh"]:
            continue
        if m["sol_err"] > p["solidity_thresh"]:
            continue
        if m["ext_err"] > p["extent_thresh"]:
            continue
        if m["circ_err"] > p["circularity_thresh"]:
            continue

        scored.append((m["total"], cnt))

    scored.sort(key=lambda x: x[0])
    return scored


# ── Non-Maximum Suppression ────────────────────────────────────────────


def nms_contours(contours: list[np.ndarray],
                 iou_thresh: float = 0.22,
                 center_dist_thresh: int = 10) -> list[np.ndarray]:
    """Non-maximum suppression by IoU and center distance."""
    if not contours:
        return []

    rects = [cv2.boundingRect(c) for c in contours]
    areas = [r[2] * r[3] for r in rects]
    order = np.argsort(areas)[::-1]
    keep: list[int] = []
    used: set[int] = set()

    for i in order:
        if i in used:
            continue
        keep.append(i)
        x1, y1, w1, h1 = rects[i]
        c1x = x1 + w1 / 2.0
        c1y = y1 + h1 / 2.0

        for j in order:
            if j in used or j == i:
                continue
            x2, y2, w2, h2 = rects[j]
            c2x = x2 + w2 / 2.0
            c2y = y2 + h2 / 2.0

            ix = max(0, min(x1 + w1, x2 + w2) - max(x1, x2))
            iy = max(0, min(y1 + h1, y2 + h2) - max(y1, y2))
            inter = ix * iy
            union = w1 * h1 + w2 * h2 - inter
            iou = inter / union if union > 0 else 0.0
            center_dist = ((c1x - c2x) ** 2 + (c1y - c2y) ** 2) ** 0.5

            if iou > iou_thresh or center_dist < center_dist_thresh:
                used.add(j)

    return [contours[k] for k in keep]


# ── Rotation detection ──────────────────────────────────────────────────


def _rotate_contour(cnt: np.ndarray, angle_deg: int,
                     center: tuple[float, float]) -> np.ndarray:
    """Rotate contour N degrees clockwise around center."""
    theta = np.radians(angle_deg)
    cos, sin = np.cos(theta), np.sin(theta)
    pts = cnt[:, 0, :].astype(np.float64)
    pts[:, 0] -= center[0]
    pts[:, 1] -= center[1]
    rotated = np.empty_like(pts)
    rotated[:, 0] = pts[:, 0] * cos - pts[:, 1] * sin
    rotated[:, 1] = pts[:, 0] * sin + pts[:, 1] * cos
    rotated[:, 0] += center[0]
    rotated[:, 1] += center[1]
    return rotated.astype(np.int32).reshape(-1, 1, 2)


def detect_rotation(template: np.ndarray, candidate: np.ndarray,
                    steps: int = 4) -> tuple[int, float]:
    """Try rotating template by `steps` angles (0°, 90°, 180°, 270° for
    steps=4, or 0°, 180° for steps=2) and return (best_angle, best_shape_score).
    """
    angles = [0]
    if steps >= 2:
        angles.append(180)
    if steps >= 4:
        angles.extend([90, 270])
    if steps >= 8:
        angles.extend([45, 135, 225, 315])

    moments = cv2.moments(template)
    cx = moments["m10"] / (moments["m00"] + 1e-6)
    cy = moments["m01"] / (moments["m00"] + 1e-6)

    best_angle = 0
    best_score = float("inf")

    for angle in angles:
        rotated = _rotate_contour(template, angle, (cx, cy))
        score = cv2.matchShapes(rotated, candidate, cv2.CONTOURS_MATCH_I2, 0)
        if score < best_score:
            best_score = score
            best_angle = angle

    return best_angle, best_score


# ── Main matching pipelines ─────────────────────────────────────────────


def match_contour_pipeline(
    search_rgb: np.ndarray,
    ref_bbox: tuple[int, int, int, int],
    params: dict | None = None,
) -> list[dict]:
    """Multi-contour matching pipeline — uses ALL reference contours.

    Instead of picking a single best contour from the reference, this extracts
    ALL contours from the reference ROI (pocket + base + emitter + contacts)
    and matches each candidate against all of them. A candidate passes if its
    best match to any reference contour satisfies the thresholds.

    This matches how 2.py would work when the reference crop contains multiple
    overlapping structures — each contour contributes shape information.
    """
    p = {**DEFAULT_PARAMS, **(params or {})}
    search_gray = cv2.cvtColor(search_rgb, cv2.COLOR_RGB2GRAY)

    search_pp = preprocess(search_gray)

    rx0, ry0, rw, rh = ref_bbox
    ref_roi = search_pp[ry0:ry0 + rh, rx0:rx0 + rw]

    # Extract ALL reference contours (not just the best one)
    ref_cnts = extract_all_contours_from_roi(ref_roi, min_area=p["min_area"])
    if not ref_cnts:
        # Fall back to best contour if multi-contour finds nothing
        single = choose_best_contour_from_roi(ref_roi, min_area=p["min_area"])
        if single is None:
            return []
        ref_cnts = [single]

    # Translate to search-image coords
    ref_cnts = [c + np.array([[[rx0, ry0]]]) for c in ref_cnts]

    # Unique match candidate ids (tracked by bounding box to avoid dupes)
    all_cnts = find_all_contours(search_pp, min_area=p["min_area"])

    # For each search contour, compute best score across ALL reference contours
    scored_pool: list[tuple[float, np.ndarray]] = []
    for cnt in all_cnts:
        best_score = float("inf")
        for rc in ref_cnts:
            ra = cv2.contourArea(rc)
            m = contour_distance(rc, cnt, ra)
            if m["total"] < best_score:
                best_score = m["total"]
                best_metrics = m
        # Apply filters using the best match metrics
        if not (p["area_lo"] <= best_metrics["ratio"] <= p["area_hi"]):
            continue
        if best_metrics["shape"] > p["shape_thresh"]:
            continue
        if best_metrics["asp_err"] > p["aspect_thresh"]:
            continue
        if best_metrics["sol_err"] > p["solidity_thresh"]:
            continue
        if best_metrics["ext_err"] > p["extent_thresh"]:
            continue
        if best_metrics["circ_err"] > p["circularity_thresh"]:
            continue
        scored_pool.append((best_metrics["total"], cnt))

    if not scored_pool:
        return []

    scored_pool.sort(key=lambda x: x[0])

    # Score percentile filter
    scores_arr = [s for s, _ in scored_pool]
    limit = np.percentile(scores_arr, 75) + 0.15
    filtered = [cnt for s, cnt in scored_pool if s <= limit]
    if not filtered:
        return []

    # NMS
    filtered = nms_contours(filtered, iou_thresh=p["nms_iou_thresh"],
                            center_dist_thresh=p["min_distance"])

    # Re-score against the BEST matching reference contour for each candidate
    rescored: list[tuple[float, np.ndarray, np.ndarray]] = []  # (score, cnt, best_ref_cnt)
    for cnt in filtered:
        best_score = float("inf")
        best_rc = ref_cnts[0]
        for rc in ref_cnts:
            ra = cv2.contourArea(rc)
            m = contour_distance(rc, cnt, ra)
            if m["total"] < best_score:
                best_score = m["total"]
                best_rc = rc
        rescored.append((best_score, cnt, best_rc))
    rescored.sort(key=lambda x: x[0])

    # Build results
    results: list[dict] = []
    rotation_steps = p.get("rotation_steps", 4)
    for total_score, cnt, best_rc in rescored:
        x, y, w, h = cv2.boundingRect(cnt)
        moments = cv2.moments(cnt)
        if moments["m00"] < 1e-6:
            cx, cy = x + w // 2, y + h // 2
        else:
            cx = int(moments["m10"] / moments["m00"])
            cy = int(moments["m01"] / moments["m00"])

        angle, _ = detect_rotation(best_rc, cnt, steps=rotation_steps)
        confidence = 1.0 / (1.0 + total_score)

        results.append({
            "x": cx,
            "y": cy,
            "rotation": angle,
            "confidence": round(confidence, 4),
            "bbox": [x, y, w, h],
        })

    return results


# ── Debug pipeline ──────────────────────────────────────────────────────


def _draw_contour_on_image(image: np.ndarray, cnt: np.ndarray,
                            color: tuple[int, int, int]) -> np.ndarray:
    out = image.copy()
    cv2.drawContours(out, [cnt], -1, color, 2)
    return out


def _resize_for_preview(image: np.ndarray, max_side: int = 1024) -> np.ndarray:
    h, w = image.shape[:2]
    scale = min(max_side / max(h, w), 1.0)
    if scale < 1.0:
        new_w, new_h = int(w * scale), int(h * scale)
        return cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return image


def debug_match_pipeline(
    search_rgb: np.ndarray,
    ref_bbox: tuple[int, int, int, int],
    params: dict | None = None,
    dump_path: str | None = None,
) -> dict:
    import base64
    if dump_path: import json
    p = {**DEFAULT_PARAMS, **(params or {})}
    search_gray = cv2.cvtColor(search_rgb, cv2.COLOR_RGB2GRAY)
    search_pp = preprocess(search_gray)
    rx0, ry0, rw, rh = ref_bbox
    rx0 = max(0, rx0); ry0 = max(0, ry0)
    rw = min(rw, search_gray.shape[1] - rx0)
    rh = min(rh, search_gray.shape[0] - ry0)
    ref_roi = search_pp[ry0:ry0 + rh, rx0:rx0 + rw]
    ref_cnts = extract_all_contours_from_roi(ref_roi, min_area=p["min_area"])
    if not ref_cnts:
        single = choose_best_contour_from_roi(ref_roi, min_area=p["min_area"])
        if single is not None: ref_cnts = [single]
    ref_cnts = [c + np.array([[[rx0, ry0]]]) for c in ref_cnts]
    ref_crop_rgb = search_rgb[ry0:ry0 + rh, rx0:rx0 + rw]
    _, cbuf = cv2.imencode(".png", cv2.cvtColor(ref_crop_rgb, cv2.COLOR_RGB2BGR))
    ref_crop_b64 = base64.b64encode(cbuf.tobytes()).decode("ascii")
    ref_contours_info = []
    for rc in ref_cnts:
        bx, by, bw_, bh_ = cv2.boundingRect(rc)
        ref_contours_info.append({
            "bbox": [int(bx), int(by), int(bw_), int(bh_)],
            "area": round(cv2.contourArea(rc), 1),
            "aspect": round(contour_aspect(rc), 4),
            "solidity": round(contour_solidity(rc), 4),
            "extent": round(contour_extent(rc), 4),
            "circularity": round(contour_circularity(rc), 4),
        })
    colors = [(0, 255, 0), (0, 200, 255), (255, 100, 0), (200, 0, 255), (0, 255, 255)]
    result = {
        "ref_crop_png_b64": ref_crop_b64,
        "ref_contours": ref_contours_info,
        "ref_contour_count": len(ref_cnts),
        "ref_contour_png_b64": None,
        "search_preview_png_b64": None,
        "top_matches": [],
        "all_scored": [],
        "total_candidates": 0,
        "total_contours_found": 0,
        "params_used": p,
    }
    if not ref_cnts: return result
    black = np.zeros((rh, rw, 3), dtype=np.uint8)
    for i, rc in enumerate(ref_cnts):
        cv2.drawContours(black, [rc - np.array([[[rx0, ry0]]])], -1, colors[i % len(colors)], 2)
    _, rcbuf = cv2.imencode(".png", black)
    result["ref_contour_png_b64"] = base64.b64encode(rcbuf.tobytes()).decode("ascii")
    all_cnts = find_all_contours(search_pp, min_area=p["min_area"])
    result["total_contours_found"] = len(all_cnts)
    if not all_cnts: return result
    all_scored = []
    for cnt in all_cnts:
        best_score = float("inf")
        best_m = None
        for rc in ref_cnts:
            ra = cv2.contourArea(rc)
            m = contour_distance(rc, cnt, ra)
            if m["total"] < best_score: best_score = m["total"]; best_m = m
        if best_m is None: continue
        bx2, by2, bw2, bh2 = cv2.boundingRect(cnt)
        passed = (
            p["area_lo"] <= best_m["ratio"] <= p["area_hi"]
            and best_m["shape"] <= p["shape_thresh"]
            and best_m["asp_err"] <= p["aspect_thresh"]
            and best_m["sol_err"] <= p["solidity_thresh"]
            and best_m["ext_err"] <= p["extent_thresh"]
            and best_m["circ_err"] <= p["circularity_thresh"])
        all_scored.append({
            "bbox": [int(bx2), int(by2), int(bw2), int(bh2)],
            "total_score": round(best_score, 4),
            "shape_dist": round(best_m["shape"], 4),
            "area_ratio": round(best_m["ratio"], 4),
            "aspect_err": round(best_m["asp_err"], 4),
            "solidity_err": round(best_m["sol_err"], 4),
            "extent_err": round(best_m["ext_err"], 4),
            "circularity_err": round(best_m["circ_err"], 4),
            "passed": passed})
    all_scored.sort(key=lambda x: x["total_score"])
    result["all_scored"] = all_scored[:200]
    result["total_candidates"] = sum(1 for s in all_scored if s["passed"])
    top_matches = []
    for s in all_scored:
        if not s["passed"]: continue
        if len(top_matches) >= 20: break
        bx2, by2, bw2, bh2 = s["bbox"]; cx = bx2 + bw2 // 2; cy = by2 + bh2 // 2
        pts = np.array([[[bx2, by2]], [[bx2 + bw2, by2]], [[bx2 + bw2, by2 + bh2]], [[bx2, by2 + bh2]]], dtype=np.int32)
        angle, _ = detect_rotation(ref_cnts[0], pts, steps=p.get("rotation_steps", 4))
        top_matches.append({
            "bbox": [int(bx2), int(by2), int(bw2), int(bh2)],
            "centroid": [cx, cy], "rotation": angle,
            "confidence": round(1.0 / (1.0 + s["total_score"]), 4),
            "total_score": round(s["total_score"], 4),
            "shape_dist": round(s["shape_dist"], 4),
            "area_ratio": round(s["area_ratio"], 4),
            "aspect_err": round(s["aspect_err"], 4),
            "solidity_err": round(s["solidity_err"], 4),
            "extent_err": round(s["extent_err"], 4),
            "circularity_err": round(s["circularity_err"], 4)})
    result["top_matches"] = top_matches
    sv = cv2.cvtColor(search_rgb, cv2.COLOR_RGB2BGR)
    for s in all_scored:
        xs, ys, ws_, hs_ = s["bbox"]
        cv2.rectangle(sv, (xs, ys), (xs + ws_, ys + hs_),
                      (0, 0, 255) if not s["passed"] else (0, 255, 0), 1)
    for i, rc in enumerate(ref_cnts):
        cv2.drawContours(sv, [rc], -1, colors[i % len(colors)], 2)
    sv_rs = _resize_for_preview(sv, 2048)
    _, sbuf = cv2.imencode(".jpg", sv_rs, [cv2.IMWRITE_JPEG_QUALITY, 85])
    result["search_preview_png_b64"] = base64.b64encode(sbuf.tobytes()).decode("ascii")
    if dump_path:
        dump = {k: v for k, v in result.items() if not k.endswith("_png_b64") and k != "search_preview_png_b64"}
        d = os.path.dirname(dump_path); os.makedirs(d, exist_ok=True)
        with open(dump_path, "w") as f: json.dump(dump, f, indent=2, default=str)
        cv2.imwrite(dump_path.replace(".json", ".jpg"), sv_rs)
        print(f"[cv_match] debug dumped to {dump_path}")
    return result


def match_template_pipeline(
    search_rgb: np.ndarray,
    ref_bbox: tuple[int, int, int, int],
    params: dict | None = None,
) -> list[dict]:
    """Template matching pipeline — Sobel filter + matchTemplate + multi-angle + NMS.

    Based on the approach from docs/reference/cv/1/o.py: Sobel edge detection
    prior to template matching makes it robust to SEM intensity variation.
    Works on pixel-level patterns (poly-over-diffusion), not contour shapes.

    Args:
        search_rgb: RGB image of the die region to search.
        ref_bbox: (x, y, w, h) of the reference cell in search-image coords.
        params: Override params: threshold (0..1), rotation_steps, max_matches,
                min_distance.

    Returns:
        List of matches, each: {x, y, rotation, confidence, bbox}.
    """
    p = {
        "threshold": 0.5,
        "rotation_steps": 4,
        "max_matches": 100,
        "min_distance": 15,
        "nms_iou_thresh": 0.15,
        **(params or {}),
    }

    search_gray = cv2.cvtColor(search_rgb, cv2.COLOR_RGB2GRAY)

    # Sobel filter
    sobelx = cv2.Sobel(search_gray, cv2.CV_64F, 1, 0, ksize=3)
    sobely = cv2.Sobel(search_gray, cv2.CV_64F, 0, 1, ksize=3)
    search_edges = cv2.magnitude(sobelx, sobely)
    search_edges = cv2.normalize(search_edges, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)

    # Extract reference template from the Sobel image
    rx0, ry0, rw, rh = ref_bbox
    rx0 = max(0, rx0)
    ry0 = max(0, ry0)
    rw = min(rw, search_gray.shape[1] - rx0)
    rh = min(rh, search_gray.shape[0] - ry0)
    if rw <= 0 or rh <= 0:
        return []

    ref_template = search_edges[ry0:ry0 + rh, rx0:rx0 + rw]
    tw = ref_template.shape[1]
    th = ref_template.shape[0]

    # Precompute Sobel for all rotated versions of the template
    # (rotate Sobel image, not original — edges rotate with the structure)
    angles_to_try = [0]
    if p["rotation_steps"] >= 2:
        angles_to_try.append(180)
    if p["rotation_steps"] >= 4:
        angles_to_try.extend([90, 270])

    all_matches: list[tuple[float, int, int, int]] = []  # (confidence, x, y, angle)

    for angle in angles_to_try:
        if angle == 0:
            tmpl = ref_template
        elif angle == 90:
            tmpl = cv2.rotate(ref_template, cv2.ROTATE_90_CLOCKWISE)
        elif angle == 180:
            tmpl = cv2.rotate(ref_template, cv2.ROTATE_180)
        elif angle == 270:
            tmpl = cv2.rotate(ref_template, cv2.ROTATE_90_COUNTERCLOCKWISE)
        else:
            continue

        if tmpl.shape[0] > search_edges.shape[0] or tmpl.shape[1] > search_edges.shape[1]:
            continue

        result = cv2.matchTemplate(search_edges, tmpl, cv2.TM_CCOEFF_NORMED)
        locations = np.where(result >= p["threshold"])
        for pt in zip(*locations[::-1]):
            all_matches.append((float(result[pt[1], pt[0]]), int(pt[0]), int(pt[1]), angle))

    if not all_matches:
        return []

    # Sort by confidence desc
    all_matches.sort(key=lambda x: -x[0])

    # NMS by IoU + centroid distance — keeps highest-confidence match per cell
    kept: list[tuple[float, int, int, int]] = []
    for conf, x, y, angle in all_matches:
        overlap = False
        for k_conf, kx, ky, _ in kept:
            # IoU between (x,y,tw,th) and (kx,ky,tw,th)
            ix = max(0, min(x + tw, kx + tw) - max(x, kx))
            iy = max(0, min(y + th, ky + th) - max(y, ky))
            inter = ix * iy
            union = tw * th + tw * th - inter
            iou = inter / union if union > 0 else 0
            if iou > 0.3:
                overlap = True
                break
            # Also centroid distance for far-away same-pattern cells
            cx = x + tw // 2; cy = y + th // 2
            kcx = kx + tw // 2; kcy = ky + th // 2
            dist = ((cx - kcx)**2 + (cy - kcy)**2)**0.5
            if dist < 30:
                overlap = True
                break
        if overlap:
            continue
        kept.append((conf, x, y, angle))
        if len(kept) >= p["max_matches"]:
            break

    # Filter out matches on the reference cell itself (not nearby cells)
    ref_cx = rx0 + rw // 2
    ref_cy = ry0 + rh // 2
    # Use a tight radius: a fraction of the template size
    ref_tol = min(tw, th) * 0.3
    filtered: list[tuple[float, int, int, int]] = []
    for conf, x, y, angle in kept:
        mx = x + tw // 2
        my = y + th // 2
        dist = ((mx - ref_cx) ** 2 + (my - ref_cy) ** 2) ** 0.5
        if dist < ref_tol:
            continue
        filtered.append((conf, x, y, angle))

    results: list[dict] = []
    for conf, x, y, angle in filtered:
        results.append({
            "x": x + tw // 2,
            "y": y + th // 2,
            "rotation": angle,
            "confidence": round(conf, 4),
            "bbox": [x, y, tw, th],
        })

    return results
