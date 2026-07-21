"""Contour-based cell matching pipeline.

Adapted from the IC Topology Analyzer v2.2 approach (docs/reference/cv/2.py).
Key differences: no GUI, clean functions, rotation detection added, NMS tuned.
"""
from __future__ import annotations

import os
import cv2
import numpy as np

# ── Default detection parameters (matching 2.py's PRESET) ──────────────

DEFAULT_PARAMS = {
    "shape_thresh": 1.5,
    "area_lo": 0.8,
    "area_hi": 1.2,
    "aspect_thresh": 0.5,
    "solidity_thresh": 0.90,
    "extent_thresh": 0.90,
    "circularity_thresh": 0.90,
    "min_area": 200,
    "min_distance": 10,
    "approx_epsilon": 0.025,
    "nms_iou_thresh": 0.22,
    "min_ref_matches": 2,
    "struct_thresh": 0.25,
    "detection_mode": "canny",
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


def normalize_contour(cnt: np.ndarray, eps_ratio: float = 0.025) -> np.ndarray:
    """Approximate contour with fewer points using Douglas-Peucker.
    Higher eps_ratio = more aggressive simplification = straighter lines.
    Default 0.025 = 2.5% of arc length, smoothing pixel noise."""
    eps = eps_ratio * cv2.arcLength(cnt, True)
    approx = cv2.approxPolyDP(cnt, eps, True)
    return approx if len(approx) >= 4 else cnt


def _dedup_contours_by_iou(contours: list[np.ndarray],
                            iou_thresh: float = 0.7) -> list[np.ndarray]:
    """Deduplicate contours by bounding box IoU, keeping the largest per group.
    Multiple binarization variants produce shifted versions of the same contour;
    this keeps only the cleanest (largest area) copy of each."""
    if not contours:
        return []
    rects = [cv2.boundingRect(c) for c in contours]
    areas = [cv2.contourArea(c) for c in contours]
    order = sorted(range(len(contours)), key=lambda i: areas[i], reverse=True)
    keep: list[int] = []
    used: set[int] = set()
    for i in order:
        if i in used:
            continue
        keep.append(i)
        x1, y1, w1, h1 = rects[i]
        for j in order:
            if j in used or j == i:
                continue
            x2, y2, w2, h2 = rects[j]
            ix = max(0, min(x1 + w1, x2 + w2) - max(x1, x2))
            iy = max(0, min(y1 + h1, y2 + h2) - max(y1, y2))
            inter = ix * iy
            union = w1 * h1 + w2 * h2 - inter
            iou = inter / union if union > 0 else 0.0
            if iou > iou_thresh:
                used.add(j)
    return [contours[k] for k in keep]


# ── Contour extraction ─────────────────────────────────────────────────


def choose_best_contour_from_roi(roi_gray: np.ndarray,
                                  min_area: int = 12) -> np.ndarray | None:
    """Pick the best contour from a user-selected ROI using a weighted score.
    Returns the contour in ROI-local coordinates, or None."""
    variants = build_binary_variants(roi_gray)
    best_cnt = None
    best_score = -1.0
    roi_area = roi_gray.shape[0] * roi_gray.shape[1]
    h, w = roi_gray.shape[:2]

    for bw in variants:
        contours, hierarchy = cv2.findContours(bw, cv2.RETR_TREE,
                                               cv2.CHAIN_APPROX_SIMPLE)
        if hierarchy is None:
            continue
        hierarchy = hierarchy[0]
        for i, cnt in enumerate(contours):
            area = cv2.contourArea(cnt)
            if area < min_area:
                continue
            if area > roi_area * 0.97:
                continue
            # Skip top-level contours touching ROI border (edge garbage)
            x, y, cw, ch = cv2.boundingRect(cnt)
            if hierarchy[i][3] == -1 and (x <= 2 or y <= 2 or
                                          x + cw >= w - 2 or y + ch >= h - 2):
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
    """Extract ALL significant contours from a reference ROI using RETR_TREE.

    Returns top-level contours (pocket boundary) AND all nested child contours
    (base, emitter, collector, contacts). Top-level contours that touch the ROI
    border are filtered as edge garbage; internal contours are kept regardless
    of their position relative to the border.
    Contours from all 6 binarization variants are collected, then deduplicated
    by IoU (>0.7 = same structure, keep largest).
    """
    variants = build_binary_variants(roi_gray)
    h, w = roi_gray.shape[:2]
    collected: list[np.ndarray] = []

    for bw in variants:
        contours, hierarchy = cv2.findContours(bw, cv2.RETR_TREE,
                                               cv2.CHAIN_APPROX_SIMPLE)
        if hierarchy is None:
            continue
        hierarchy = hierarchy[0]
        for i, cnt in enumerate(contours):
            area = cv2.contourArea(cnt)
            if area < min_area:
                continue
            if area > h * w * 0.97:
                continue
            x, y, cw, ch = cv2.boundingRect(cnt)
            if cw < 3 or ch < 3:
                continue
            # Top-level contours touching the ROI border = edge garbage → skip.
            # Nested contours (parent != -1) are always kept — these are the
            # internal transistor structures (base, emitter, collector).
            parent = hierarchy[i][3]
            touches_border = (x <= 2 or y <= 2 or
                              x + cw >= w - 2 or y + ch >= h - 2)
            if parent == -1 and touches_border:
                continue
            collected.append(normalize_contour(cnt))

    # Deduplicate by IoU — different variants produce shifted versions of
    # the same contour. Keep the largest (cleanest) copy of each.
    return _dedup_contours_by_iou(collected, iou_thresh=0.7)


def find_all_contours(gray: np.ndarray,
                      min_area: int = 12) -> list[np.ndarray]:
    """Extract all external contours (RETR_EXTERNAL = no nesting) from the image,
    deduplicating across binary variants by quantised bounding box.
    RETR_EXTERNAL is correct for the search image: base/emitter/collector are
    disconnected binary regions and each has its own external boundary."""
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


def find_all_contours_canny(gray: np.ndarray,
                            min_area: int = 12) -> list[np.ndarray]:
    """Find contours using Canny edge detection instead of threshold binarization.
    
    Works on uniformly-bright images where threshold methods fail to produce
    closed regions. Uses bilateral filter → Canny → morphological close to
    convert faint edges into filled regions.
    """
    # Gentle denoise (no CLAHE — preserves raw gradients)
    den = cv2.bilateralFilter(gray, 5, 30, 30)
    edges = cv2.Canny(den, 20, 80)
    # Close gaps in edges so findContours sees filled regions
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
    result: list[np.ndarray] = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area:
            continue
        x, y, w, h = cv2.boundingRect(cnt)
        if w < 3 or h < 3:
            continue
        result.append(normalize_contour(cnt))
    return result


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


def _principal_angle(cnt: np.ndarray) -> int:
    """Return the dominant orientation (0 or 90 degrees) of a contour.
    Uses minAreaRect: if width > height, orientation is 0°, else 90°. 
    This is robust for Manhattan-geometry transistor contours."""
    rect = cv2.minAreaRect(cnt)
    w, h = rect[1]
    if w >= h:
        return 0
    else:
        return 90


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


# ── Cluster-based matching ────────────────────────────────────────────


def _cluster_radius(ref_cnts: list[np.ndarray]) -> float:
    """Cluster radius = half the max dimension of the largest reference contour.
    This keeps radius proportional to the actual cell size, not inflated by
    distant internal features."""
    if not ref_cnts:
        return 50.0
    areas = [cv2.contourArea(c) for c in ref_cnts]
    largest = ref_cnts[int(np.argmax(areas))]
    _, _, w, h = cv2.boundingRect(largest)
    return max(w, h) * 0.5


def _verify_internal_structure(
    ref_cnts: list[np.ndarray],
    candidate_cnts: list[np.ndarray],
    loose_matches: list[tuple[float, np.ndarray, int]],
    large_refs: set[int],
) -> float:
    """Fuzzy structural verification of a candidate's internal contours
    against the reference contour set.

    Returns a similarity score 0..1 based on:
      - area_ratio match between candidate/reference relative to pocket
      - relative position of each internal contour within the candidate crop

    Higher = more similar. Only considers matched internal contours.
    """
    if not loose_matches:
        return 0.0

    ref_areas = [cv2.contourArea(rc) for rc in ref_cnts]
    pocket_idx = int(np.argmax(ref_areas))
    ref_pocket_area = ref_areas[pocket_idx]
    ref_pocket_bbox = cv2.boundingRect(ref_cnts[pocket_idx])
    ref_pcx = ref_pocket_bbox[0] + ref_pocket_bbox[2] / 2
    ref_pcy = ref_pocket_bbox[1] + ref_pocket_bbox[3] / 2

    # Find candidate pocket (the one that matched a large reference)
    cand_pocket = None
    for _, cnt, idx in loose_matches:
        if idx in large_refs:
            cand_pocket = cnt
            break
    if cand_pocket is None:
        return 0.0

    cand_pocket_area = cv2.contourArea(cand_pocket)
    if cand_pocket_area < 1:
        return 0.0
    cb = cv2.boundingRect(cand_pocket)
    cand_pcx = cb[0] + cb[2] / 2
    cand_pcy = cb[1] + cb[3] / 2

    # Compute similarity for each internal match
    scores: list[float] = []
    for _, cnt, idx in loose_matches:
        if idx in large_refs:
            continue  # skip pocket-to-pocket match
        # Area ratio similarity: (cand_internal / cand_pocket) vs (ref_internal / ref_pocket)
        cand_internal_area = cv2.contourArea(cnt)
        ref_internal_area = ref_areas[idx]
        cand_ratio = cand_internal_area / cand_pocket_area
        ref_ratio = ref_internal_area / ref_pocket_area
        ratio_sim = np.exp(-0.5 * ((cand_ratio - ref_ratio) / (0.3 * ref_ratio + 0.01)) ** 2)

        # Relative position similarity: centroid offset normalized by pocket bbox
        cib = cv2.boundingRect(cnt)
        cand_off_x = (cib[0] + cib[2] / 2 - cand_pcx) / max(cb[2], 1)
        cand_off_y = (cib[1] + cib[3] / 2 - cand_pcy) / max(cb[3], 1)

        ref_b = cv2.boundingRect(ref_cnts[idx])
        ref_off_x = (ref_b[0] + ref_b[2] / 2 - ref_pcx) / max(ref_pocket_bbox[2], 1)
        ref_off_y = (ref_b[1] + ref_b[3] / 2 - ref_pcy) / max(ref_pocket_bbox[3], 1)

        pos_sim = np.exp(-0.5 * (
            (cand_off_x - ref_off_x) ** 2 +
            (cand_off_y - ref_off_y) ** 2
        ) / (2 * 0.20))

        scores.append(0.6 * ratio_sim + 0.4 * pos_sim)

    return float(np.mean(scores)) if scores else 0.0


def _loose_match_search_contours(
    ref_cnts: list[np.ndarray],
    search_cnts: list[np.ndarray],
    p: dict,
) -> list[tuple[float, np.ndarray, int]]:
    """First-pass matching with relaxed thresholds.
    Returns list of (total_score, contour, best_ref_idx)."""
    ref_areas = [cv2.contourArea(rc) for rc in ref_cnts]
    scored: list[tuple[float, np.ndarray, int]] = []

    for cnt in search_cnts:
        cnt_area = cv2.contourArea(cnt)
        if cnt_area < p["min_area"]:
            continue

        best_score = float("inf")
        best_idx = 0
        best_metrics = None

        for i, rc in enumerate(ref_cnts):
            m = contour_distance(rc, cnt, ref_areas[i])
            if m["total"] < best_score:
                best_score = m["total"]
                best_idx = i
                best_metrics = m

        if best_metrics is None:
            continue

        # Loose filters — use user params from DEFAULT_PARAMS / GUI
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
        scored.append((best_metrics["total"], cnt, best_idx))

    return scored


def _cluster_matches(
    scored: list[tuple[float, np.ndarray, int]],
    radius: float,
) -> list[dict]:
    """Group matches by centroid proximity, return clusters with metadata.
    Each cluster dict: {centroid, score, matches, ref_ids, n_matches, bbox}"""
    if not scored:
        return []

    centers = []
    for _, cnt, _ in scored:
        x, y, w, h = cv2.boundingRect(cnt)
        centers.append((x + w / 2, y + h / 2))
    centroids = np.array(centers, dtype=np.float64)
    n = len(scored)
    assigned = [False] * n
    clusters: list[list[int]] = []

    for i in range(n):
        if assigned[i]:
            continue
        group = [i]
        assigned[i] = True
        ci = centroids[i]
        for j in range(i + 1, n):
            if assigned[j]:
                continue
            if np.linalg.norm(centroids[j] - ci) <= radius:
                group.append(j)
                assigned[j] = True
        clusters.append(group)

    result: list[dict] = []
    for idxs in clusters:
        entries = [scored[i] for i in idxs]
        entries.sort(key=lambda x: x[0])
        ref_ids = set(idx for _, _, idx in entries)
        points = np.array([centroids[i] for i in idxs])
        cx, cy = float(points[:, 0].mean()), float(points[:, 1].mean())

        xs = [cv2.boundingRect(cnt)[0] for _, cnt, _ in entries]
        ys = [cv2.boundingRect(cnt)[1] for _, cnt, _ in entries]
        ws = [cv2.boundingRect(cnt)[2] for _, cnt, _ in entries]
        hs = [cv2.boundingRect(cnt)[3] for _, cnt, _ in entries]
        min_x, min_y = min(xs), min(ys)
        max_x = max(x + w for x, w in zip(xs, ws))
        max_y = max(y + h for y, h in zip(ys, hs))
        bw, bh = max_x - min_x, max_y - min_y

        score = entries[0][0]  # best score in cluster
        result.append({
            "centroid": (round(cx), round(cy)),
            "score": score,
            "confidence": round(1.0 / (1.0 + score), 4),
            "ref_ids": sorted(ref_ids),
            "n_matches": len(entries),
            "bbox": [min_x, min_y, bw, bh],
            "ref_count": len(ref_ids),
        })

    result.sort(key=lambda c: c["score"])
    return result


def match_contour_pipeline(
    search_rgb: np.ndarray,
    ref_bbox: tuple[int, int, int, int],
    params: dict | None = None,
) -> list[dict]:
    """Two-pass cluster-based contour matching.

    Pass 1 (loose): match each search contour (RETR_EXTERNAL) against all
    reference contours with relaxed thresholds. Track which reference index
    gave the best match.

    Pass 2 (cluster): group nearby matches into clusters. Require at least
    ``min_ref_matches`` distinct reference contours in the same spatial
    cluster. Apply strict user filters (area_lo/hi, aspect, etc.) per
    reference contour within the cluster.

    Returns one result per passing cluster.
    """
    p = {**DEFAULT_PARAMS, **(params or {})}
    search_gray = cv2.cvtColor(search_rgb, cv2.COLOR_RGB2GRAY)
    search_pp = preprocess(search_gray)

    rx0, ry0, rw, rh = ref_bbox
    ref_roi = search_pp[ry0:ry0 + rh, rx0:rx0 + rw]

    # Reference: extract contour set from the crop (RETR_TREE + IoU dedup).
    # Centroids are crop-local — all comparison is relative.
    ref_cnts = extract_all_contours_from_roi(ref_roi, min_area=p["min_area"])
    if not ref_cnts:
        single = choose_best_contour_from_roi(ref_roi, min_area=p["min_area"])
        if single is None:
            return []
        ref_cnts = [single]

    # Translate to search-image coords for detection_rotation
    ref_cnts = [c + np.array([[[rx0, ry0]]]) for c in ref_cnts]

    if len(ref_cnts) <= 1:
        # Fallback: just use match_similar with user's params
        ref_area = cv2.contourArea(ref_cnts[0])
        detection_mode = p.get("detection_mode", "threshold")
        all_cnts = (find_all_contours_canny if detection_mode == "canny" else find_all_contours)(search_pp, min_area=p["min_area"])
        scored = match_similar(ref_cnts[0], all_cnts, ref_area, p)
        scored.sort(key=lambda x: x[0])
        if not scored:
            return []
        # NMS
        cnts = nms_contours([c for _, c in scored],
                            iou_thresh=p["nms_iou_thresh"],
                            center_dist_thresh=p["min_distance"])
        results: list[dict] = []
        for _, cnt in match_similar(ref_cnts[0], cnts, ref_area, p):
            x, y, w, h = cv2.boundingRect(cnt)
            cx = int(x + w / 2)
            cy = int(y + h / 2)
            m = contour_distance(ref_cnts[0], cnt, ref_area)
            results.append({
                "x": cx, "y": cy, "rotation": 0,
                "confidence": round(1.0 / (1.0 + m["total"]), 4),
                "bbox": [x, y, w, h],
            })
        return results

    ref_areas = [cv2.contourArea(rc) for rc in ref_cnts]
    max_ref_area = ref_areas[int(np.argmax(ref_areas))]

    # Stage 1: Find pocket-like contours on the search image
    detection_mode = p.get("detection_mode", "threshold")
    search_fn = find_all_contours_canny if detection_mode == "canny" else find_all_contours
    all_cnts = search_fn(search_pp, min_area=p["min_area"])

    def _pocket_filter(cnt: np.ndarray) -> float | None:
        """Check if a search contour is pocket-like. Returns match score or None."""
        area = cv2.contourArea(cnt)
        if area < p["min_area"]:
            return None
        m = contour_distance(ref_cnts[0], cnt, max_ref_area)
        if not (p["area_lo"] <= m["ratio"] <= p["area_hi"]):
            return None
        if m["shape"] > p["shape_thresh"]:
            return None
        if m["asp_err"] > p["aspect_thresh"]:
            return None
        return m["total"]

    candidates: list[tuple[float, np.ndarray]] = []
    for cnt in all_cnts:
        s = _pocket_filter(cnt)
        if s is not None:
            candidates.append((s, cnt))
    if not candidates:
        return []
    candidates.sort(key=lambda x: x[0])

    # NMS on pocket candidates
    pocket_contours = nms_contours(
        [c for _, c in candidates],
        iou_thresh=p["nms_iou_thresh"],
        center_dist_thresh=p["min_distance"],
    )

    # Stage 2: For each pocket candidate, crop and verify internal structure
    sorted_idx = sorted(range(len(ref_areas)), key=lambda i: ref_areas[i], reverse=True)
    large_refs = set(sorted_idx[:2])
    min_cluster_matches = p.get("min_ref_matches", 2)

    results: list[dict] = []
    for pocket_cnt in pocket_contours:
        px, py, pw, ph = cv2.boundingRect(pocket_cnt)
        pocket_center = (px + pw // 2, py + ph // 2)

        # Crop around this pocket with margin proportional to pocket itself
        margin = max(pw, ph) // 1
        cx0 = max(0, px - margin)
        cy0 = max(0, py - margin)
        cw = min(search_pp.shape[1] - cx0, pw + 2 * margin)
        ch = min(search_pp.shape[0] - cy0, ph + 2 * margin)
        crop = search_pp[cy0:cy0 + ch, cx0:cx0 + cw]

        # Extract contours from this crop using the SAME method as reference
        crop_cnts = extract_all_contours_from_roi(crop, min_area=p["min_area"])

        if not crop_cnts:
            continue

        # Translate crop contours back to search-image coords
        crop_cnts = [c + np.array([[[cx0, cy0]]]) for c in crop_cnts]

        # Match against reference and check internal structure
        loose = _loose_match_search_contours(ref_cnts, crop_cnts, p)
        if not loose:
            continue

        ref_ids = set(idx for _, _, idx in loose)
        rid_set = set(ref_ids)

        # Must have a large (pocket boundary) match
        if not (rid_set & large_refs):
            continue

        # Require at least min_cluster_matches SMALL (internal) matches
        small_ids = set(rid_set - large_refs)
        if len(small_ids) < min_cluster_matches:
            continue

        # Fuzzy structural verification
        struct_score = _verify_internal_structure(ref_cnts, crop_cnts, loose, large_refs)
        if struct_score < p.get("struct_thresh", 0.35):
            continue

        confidence = 1.0 / (1.0 + loose[0][0])
        # Blend with structural score
        confidence = 0.5 * confidence + 0.5 * struct_score
        angle = _principal_angle(pocket_cnt)
        results.append({
            "x": pocket_center[0],
            "y": pocket_center[1],
            "rotation": angle,
            "confidence": round(confidence, 4),
            "bbox": [px, py, pw, ph],
        })

    # Dedup by proximity: keep highest-confidence result per location
    deduped: list[dict] = []
    for r in sorted(results, key=lambda x: -x["confidence"]):
        is_dup = False
        for d in deduped:
            dist = ((r["x"] - d["x"]) ** 2 + (r["y"] - d["y"]) ** 2) ** 0.5
            if dist < p["min_distance"]:
                is_dup = True
                break
        if not is_dup:
            deduped.append(r)
    return deduped[: p.get("max_matches", 100)]


# ── Debug pipeline ──────────────────────────────────────────────────────


def _draw_contour_on_image(image: np.ndarray, cnt: np.ndarray,
                            color: tuple[int, int, int]) -> np.ndarray:
    out = image.copy()
    cv2.drawContours(out, [cnt], -1, color, 2)
    return out


def _contour_depth(cnt_idx: int, hierarchy: np.ndarray) -> int:
    """Compute nesting depth of contour at cnt_idx from RETR_TREE hierarchy."""
    d = 0
    p = hierarchy[cnt_idx][3]
    while p != -1:
        d += 1
        p = hierarchy[p][3]
    return d


def _find_depth(rc: np.ndarray,
                 contours_by_var: list[tuple[list[np.ndarray], np.ndarray]]
                 ) -> int:
    """Search depth across all binary variants, return first match within 5 px."""
    rbox = cv2.boundingRect(rc)
    for cnts, hier in contours_by_var:
        for j in range(len(cnts)):
            cbox = cv2.boundingRect(cnts[j])
            dist = ((rbox[0] - cbox[0]) ** 2 + (rbox[1] - cbox[1]) ** 2) ** 0.5
            if dist < 5:
                return _contour_depth(j, hier)
    return -1


def _match_depth_to_ref(ref_cnts: list[np.ndarray],
                         roi_gray: np.ndarray) -> list[int]:
    """Match reference contours to hierarchy depths across all binary variants.
    Searches each variant's RETR_TREE hierarchy for the nearest contour match
    to each deduplicated reference contour."""
    if not ref_cnts:
        return []
    contours_by_var: list[tuple[list[np.ndarray], np.ndarray]] = []
    for bw in build_binary_variants(roi_gray):
        cnts, hier = cv2.findContours(bw, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
        if hier is not None:
            contours_by_var.append((cnts, hier[0]))
    return [_find_depth(rc, contours_by_var) for rc in ref_cnts]


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

    # Match hierarchy depths from first binary variant
    ref_depths = _match_depth_to_ref(ref_cnts, ref_roi)
    top_level_count = sum(1 for d in ref_depths if d == 0 or d == -1)
    nested_count = len(ref_depths) - top_level_count

    ref_contours_info = []
    for i, rc in enumerate(ref_cnts):
        bx, by, bw_, bh_ = cv2.boundingRect(rc)
        ref_contours_info.append({
            "bbox": [int(bx), int(by), int(bw_), int(bh_)],
            "area": round(cv2.contourArea(rc), 1),
            "aspect": round(contour_aspect(rc), 4),
            "solidity": round(contour_solidity(rc), 4),
            "extent": round(contour_extent(rc), 4),
            "circularity": round(contour_circularity(rc), 4),
            "depth": ref_depths[i] if i < len(ref_depths) else -1,
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
    overlay = ref_crop_rgb.copy()
    for i, rc in enumerate(ref_cnts):
        color = colors[i % len(colors)]
        cv2.drawContours(overlay, [rc - np.array([[[rx0, ry0]]])], -1, color, 2)
        bx, by, bw_, bh_ = cv2.boundingRect(rc)
        depth = ref_depths[i] if i < len(ref_depths) else -1
        label = f"#{i + 1} d{depth}" if depth >= 0 else f"#{i + 1}"
        cv2.putText(overlay, label, (bx - rx0 + 2, by - ry0 + 12),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, color, 1, cv2.LINE_AA)
    _, rcbuf = cv2.imencode(".png", cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR))
    result["ref_contour_png_b64"] = base64.b64encode(rcbuf.tobytes()).decode("ascii")
    detection_mode = p.get("detection_mode", "threshold")
    search_fn = find_all_contours_canny if detection_mode == "canny" else find_all_contours
    all_cnts = search_fn(search_pp, min_area=p["min_area"])
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

    # ── Cluster-based matching (for debug visualization) ──────────────
    detection_mode = p.get("detection_mode", "threshold")
    search_fn = find_all_contours_canny if detection_mode == "canny" else find_all_contours
    all_cnts = search_fn(search_pp, min_area=p["min_area"])
    loose_scored = _loose_match_search_contours(ref_cnts, all_cnts, p)
    cluster_debug: list[dict] = []
    if loose_scored:
        radius = _cluster_radius(ref_cnts)
        raw_clusters = _cluster_matches(loose_scored, radius)
        min_cluster_matches = p.get("min_ref_matches", 2)
        ref_areas_db = [cv2.contourArea(rc) for rc in ref_cnts]
        large_refs_db = set(sorted(
            range(len(ref_areas_db)), key=lambda i: ref_areas_db[i], reverse=True
        )[:2])
        for cl in raw_clusters:
            rid_set = set(cl["ref_ids"])
            has_large = bool(rid_set & large_refs_db)
            passed = has_large or cl["ref_count"] >= min_cluster_matches
            cluster_debug.append({**cl, "passed": passed})
    result["clusters"] = cluster_debug

    # ── Draw search preview ───────────────────────────────────────────
    sv = cv2.cvtColor(search_rgb, cv2.COLOR_RGB2BGR)
    for s in all_scored:
        xs, ys, ws_, hs_ = s["bbox"]
        cv2.rectangle(sv, (xs, ys), (xs + ws_, ys + hs_),
                      (0, 0, 255) if not s["passed"] else (0, 255, 0), 1)
    for i, rc in enumerate(ref_cnts):
        cv2.drawContours(sv, [rc], -1, colors[i % len(colors)], 2)
    # Draw cluster bboxes
    for cl in cluster_debug:
        x, y, w, h = cl["bbox"]
        color = (0, 255, 0) if cl["passed"] else (0, 0, 255)
        cv2.rectangle(sv, (x, y), (x + w, y + h), color, 2)
        label = f'C:{cl["ref_count"]}ref {cl["n_matches"]}m {cl["confidence"]:.2f}'
        cv2.putText(sv, label, (x + 2, y + 12),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1, cv2.LINE_AA)
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


def _tmpl_wh(angle: int, tw: int, th: int) -> tuple[int, int]:
    """Effective template width/height for a given rotation angle.
    At 0/180 degrees dimensions are (tw, th), at 90/270 they are swapped (th, tw).
    """
    return (tw, th) if angle in (0, 180) else (th, tw)


def match_template_pipeline(
    search_rgb: np.ndarray,
    ref_bbox: tuple[int, int, int, int],
    params: dict | None = None,
) -> list[dict]:
    """Template matching pipeline — Sobel filter + matchTemplate + multi-angle + NMS."""
    p = {
        "threshold": 0.5,
        "rotation_steps": 4,
        "max_matches": 100,
        "min_distance": 15,
        "sobel_ksize": 3,
        "nms_iou": 0.3,
        "nms_dist": 30,
        **(params or {}),
    }

    search_gray = cv2.cvtColor(search_rgb, cv2.COLOR_RGB2GRAY)
    ksize = p["sobel_ksize"]
    if ksize % 2 == 0:
        ksize += 1

    sobelx = cv2.Sobel(search_gray, cv2.CV_64F, 1, 0, ksize=ksize)
    sobely = cv2.Sobel(search_gray, cv2.CV_64F, 0, 1, ksize=ksize)
    search_edges = cv2.magnitude(sobelx, sobely)
    search_edges = cv2.normalize(search_edges, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)

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

    angles_to_try = [0]
    if p["rotation_steps"] >= 2:
        angles_to_try.append(180)
    if p["rotation_steps"] >= 4:
        angles_to_try.extend([90, 270])

    all_matches: list[tuple[float, int, int, int]] = []

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

    all_matches.sort(key=lambda x: -x[0])

    nms_iou = p["nms_iou"]
    nms_dist = p["nms_dist"]
    kept: list[tuple[float, int, int, int]] = []
    for conf, x, y, angle in all_matches:
        w, h = _tmpl_wh(angle, tw, th)
        overlap = False
        for k_conf, kx, ky, kangle in kept:
            kw, kh = _tmpl_wh(kangle, tw, th)
            ix = max(0, min(x + w, kx + kw) - max(x, kx))
            iy = max(0, min(y + h, ky + kh) - max(y, ky))
            inter = ix * iy
            union = w * h + kw * kh - inter
            iou = inter / union if union > 0 else 0
            if iou > nms_iou:
                overlap = True
                break
            cx = x + w // 2; cy = y + h // 2
            kcx = kx + kw // 2; kcy = ky + kh // 2
            if ((cx - kcx)**2 + (cy - kcy)**2)**0.5 < nms_dist:
                overlap = True
                break
        if overlap:
            continue
        kept.append((conf, x, y, angle))
        if len(kept) >= p["max_matches"]:
            break

    ref_cx = rx0 + rw // 2
    ref_cy = ry0 + rh // 2
    ref_tol = min(tw, th) * 0.3
    filtered: list[tuple[float, int, int, int]] = []
    for conf, x, y, angle in kept:
        w, h = _tmpl_wh(angle, tw, th)
        mx = x + w // 2
        my = y + h // 2
        dist = ((mx - ref_cx) ** 2 + (my - ref_cy) ** 2) ** 0.5
        if dist < ref_tol:
            continue
        filtered.append((conf, x, y, angle))

    results: list[dict] = []
    for conf, x, y, angle in filtered:
        w, h = _tmpl_wh(angle, tw, th)
        results.append({
            "x": x + w // 2,
            "y": y + h // 2,
            "rotation": angle,
            "confidence": round(conf, 4),
            "bbox": [x, y, w, h],
        })

    return results
