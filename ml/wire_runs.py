"""Robust wire-centreline extraction ("runs") for the vectorize path.

The plain skeleton decoder (heatmap.extract_trace_skeleton) walks degree-2
corridors between junction clusters as-is — noise inside an otherwise clean
metal mask creates spurious junctions that cut one physical wire into
several traces, and every skeleton wiggle becomes a vertex. This module
decodes the same skeleton but post-processes the branch graph the way a
chip drawing is actually drawn:

  1. spur pruning — dead-end arms shorter than `spur_px` (noise stubs) are
     removed and their junction dissolves, so one physical wire stops
     splitting into fragments;
  2. collinear merge — a junction with exactly two incident branches whose
     directions align (the line passes straight through) dissolves; real
     corners (~90°/45°) and true T/X junctions stay;
  3. straight-run simplification — each branch is Douglas-Peucker'd and
     consecutive segments turning less than `turn_tol_deg` are fused, so a
     trace is a minimal-vertex polyline: straight orthogonal / diagonal
     runs with vertices only at real turns;
  4. grouping — connected components of the SURVIVING branch graph (after
     the width filter) become `group` ids: one group = one net candidate,
     because a closed metal contour cannot contain two nets — that would be
     a virtual break.

Works on the mask the vectorize path already builds, so live viewport
decodes and whole-die sweeps produce identical geometry for the same pixels.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

@dataclass
class _Edge:
    """One corridor path between two node clusters (or a detached cycle).

    `points` are ordered (x, y) corridor pixels from the `a` end toward the
    `b` end. `a`/`b` are node-cluster ids, or None for a cycle with no node
    at that end. A loop edge has a == b (attached to the same node twice).
    """
    a: int | None
    b: int | None
    points: list[tuple[int, int]]
    removed: bool = False


@dataclass
class _Graph:
    nodes: dict[int, tuple[int, int]]                 # id -> (x, y)
    edges: list[_Edge] = field(default_factory=list)

    def degree(self, node: int) -> int:
        d = 0
        for e in self.edges:
            if e.removed:
                continue
            if e.a == node:
                d += 1
            if e.b == node and e.a != e.b:
                d += 1
            elif e.b == node and e.a == e.b:
                d += 2
        return d


def _build_graph(binary: np.ndarray) -> tuple[_Graph, np.ndarray]:
    """skeletonize + cluster junction/end pixels + one edge per corridor."""
    from scipy.ndimage import center_of_mass, label as scipy_label
    from skimage.morphology import skeletonize

    skel = skeletonize(binary).astype(np.uint8)
    h, w = skel.shape
    padded = np.pad(skel, 1, mode="constant")
    neighbours = np.zeros((h, w), dtype=np.uint8)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy != 0 or dx != 0:
                neighbours += padded[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]

    node_mask = skel.astype(bool) & ((neighbours >= 3) | (neighbours == 1))
    node_labels, n_nodes = scipy_label(node_mask)
    nodes: dict[int, tuple[int, int]] = {}
    if n_nodes:
        coms = center_of_mass(node_mask, node_labels, range(1, n_nodes + 1))
        for lab, (cy, cx) in enumerate(coms, start=1):
            nodes[lab] = (int(round(cx)), int(round(cy)))

    # Corridor components (8-connected label): between junction clusters each
    # component is a simple path; a node-free ring is one closed component.
    corridors = skel.astype(bool) & ~node_mask
    cor_labels, n_cor = scipy_label(
        corridors.astype(np.uint8), structure=np.ones((3, 3), dtype=np.uint8)
    )

    graph = _Graph(nodes=nodes)
    for lab in range(1, n_cor + 1):
        ys, xs = np.nonzero(cor_labels == lab)
        pts = list(zip(xs.tolist(), ys.tolist()))
        if not pts:
            continue
        pt_set = set(pts)
        # Order the path: walk from an endpoint (a pixel with exactly one
        # corridor neighbour inside the component); cycles walk from any px.
        def cor_nbrs(p: tuple[int, int]) -> list[tuple[int, int]]:
            x, y = p
            return [
                (x + dx, y + dy)
                for dy in (-1, 0, 1)
                for dx in (-1, 0, 1)
                if (dx or dy) and (x + dx, y + dy) in pt_set
            ]

        start = next((p for p in pts if len(cor_nbrs(p)) == 1), pts[0])
        ordered = [start]
        seen = {start}
        while True:
            nxt = [q for q in cor_nbrs(ordered[-1]) if q not in seen]
            if not nxt:
                break
            ordered.append(nxt[0])
            seen.add(nxt[0])

        def end_node(p: tuple[int, int]) -> int | None:
            x, y = p
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if not (dx or dy):
                        continue
                    lab_n = int(node_labels[y + dy, x + dx]) if 0 <= y + dy < h and 0 <= x + dx < w else 0
                    if lab_n:
                        return lab_n
            return None

        a = end_node(ordered[0])
        b = end_node(ordered[-1])
        graph.edges.append(_Edge(a=a, b=b, points=ordered))
    return graph, skel


def _incident(graph: _Graph, node: int) -> list[tuple[_Edge, bool]]:
    """(edge, at_start) pairs for every surviving edge end at `node`.
    at_start=True when the edge's `a` end is the node; a loop edge yields
    (edge, True) and (edge, False)."""
    out: list[tuple[_Edge, bool]] = []
    for e in graph.edges:
        if e.removed:
            continue
        if e.a == node:
            out.append((e, True))
        if e.b == node:
            out.append((e, False))
    return out


def _other(e: _Edge, at_start: bool) -> int | None:
    return e.b if at_start else e.a


def _prune_spurs(graph: _Graph, spur_px: int) -> int:
    """(Superseded by the graph-phase min_len drop in extract_wire_runs —
    kept for reference/debugging.) Iteratively drop dead-end arms shorter
    than spur_px; removing one may expose another, hence the loop."""
    removed = 0
    changed = True
    while changed:
        changed = False
        for e in list(graph.edges):
            if e.removed:
                continue
            ends = [(e.a, True), (e.b, False)]
            for node, _at_start in ends:
                if node is None:
                    continue
                if graph.degree(node) != 1:
                    continue
                if len(e.points) < spur_px:
                    e.removed = True
                    removed += 1
                    changed = True
                    break
    return removed


def _edge_dir_at(graph: _Graph, e: _Edge, at_start: bool) -> tuple[float, float] | None:
    """Unit direction of travel INTO the edge's far end when walking from the
    `at_start` end (i.e. the direction of the last/first few pixels)."""
    pts = e.points if at_start else list(reversed(e.points))
    if len(pts) < 2:
        return None
    k = min(4, len(pts))
    x0, y0 = pts[0]
    x1, y1 = pts[k - 1]
    dx, dy = x1 - x0, y1 - y0
    n = math.hypot(dx, dy)
    if n == 0:
        return None
    return (dx / n, dy / n)


def _merge_collinear(graph: _Graph, tol_deg: float) -> int:
    """Dissolve junctions with exactly two aligned incidents (straight pass-
    through). Real corners (~90°) and T/X junctions survive. Returns merges."""
    merges = 0
    changed = True
    while changed:
        changed = False
        for node in list(graph.nodes):
            if node not in graph.nodes:
                continue
            inc = _incident(graph, node)
            if len(inc) != 2:
                continue
            (e1, s1), (e2, s2) = inc
            if e1 is e2:
                continue  # loop attached twice — not a pass-through
            if len(e1.points) < 1 or len(e2.points) < 1:
                continue
            d1 = _edge_dir_at(graph, e1, not s1)  # travel INTO the node along e1
            d2 = _edge_dir_at(graph, e2, s2)      # travel OUT of the node along e2
            if d1 is None or d2 is None:
                continue
            dot = max(-1.0, min(1.0, d1[0] * d2[0] + d1[1] * d2[1]))
            ang = math.degrees(math.acos(dot))
            if ang > tol_deg:
                continue
            # Orient: e1 must walk INTO the node (node at its b end), e2 must
            # walk OUT of the node (node at its a end); then concatenate.
            if s1:
                e1.a, e1.b = e1.b, e1.a
                e1.points.reverse()
            if not s2:
                e2.a, e2.b = e2.b, e2.a
                e2.points.reverse()
            # after reorientation e1.b == node and e2.a == node
            e1.points = e1.points + [graph.nodes[node]] + e2.points
            e1.b = e2.b
            e2.removed = True
            del graph.nodes[node]
            merges += 1
            changed = True
            break
    return merges


def _angle_between(v1: tuple[float, float], v2: tuple[float, float]) -> float:
    n1 = math.hypot(*v1)
    n2 = math.hypot(*v2)
    if n1 == 0 or n2 == 0:
        return 180.0
    dot = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)
    return math.degrees(math.acos(max(-1.0, min(1.0, dot))))


def _fuse_small_turns(pts: list[list[int]], tol_deg: float) -> list[list[int]]:
    """Drop vertices whose turn angle is below tol_deg — the trace keeps
    vertices only at real (≈45°/90°) direction changes."""
    out = [list(p) for p in pts]
    changed = True
    while changed and len(out) > 2:
        changed = False
        i = 1
        while i < len(out) - 1:
            v1 = (out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1])
            v2 = (out[i + 1][0] - out[i][0], out[i + 1][1] - out[i][1])
            if _angle_between(v1, v2) <= tol_deg:
                del out[i]
                changed = True
            else:
                i += 1
    return out


def _group_edges(graph: _Graph) -> dict[int, int]:
    """Union-find over surviving edges: shared node → same group; detached
    cycles get their own group. Returns edge index -> group id."""
    parent: dict[int, int] = {}

    def find(x: int) -> int:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for idx, e in enumerate(graph.edges):
        if e.removed:
            continue
        find(idx)
        if e.a is not None and e.b is not None:
            union(idx, 10_000_000 + e.a)
            union(idx, 10_000_000 + e.b)
    # Detached cycles (a is None): unique group via the edge's own index.
    out: dict[int, int] = {}
    seen_groups: dict[int, int] = {}
    next_group = 0
    for idx, e in enumerate(graph.edges):
        if e.removed:
            continue
        root = find(idx)
        if root not in seen_groups:
            seen_groups[root] = next_group
            next_group += 1
        out[idx] = seen_groups[root]
    return out


def extract_wire_runs(
    mask_prob: np.ndarray,
    threshold: float = 0.5,
    epsilon: float = 2.5,
    min_len: int = 14,
    width_map: np.ndarray | None = None,
    width_min: float = 0.0,
    width_max: float = 0.0,
    score_map: np.ndarray | None = None,
    turn_tol_deg: float = 20.0,
    max_traces: int = 200_000,
) -> dict:
    """Skeleton → cleaned branch graph → one minimal-vertex polyline per
    straight run, grouped by graph connectivity. Returns
    {"traces": [{points, score, width?, group}], "stats": {...}}."""
    binary = mask_prob > threshold
    stats = {"kept": 0, "dropped_width": 0, "dropped_short": 0, "merged": 0}
    if not binary.any():
        return {"traces": [], "stats": stats}

    graph, _skel = _build_graph(binary)
    # Graph-phase short-edge drop FIRST: noise arms off a junction vanish
    # here, which dissolves the junction (degree 3→2) so the collinear merge
    # below can stitch the long branches back into ONE wire. Doing it in the
    # emit phase instead would keep spurious junctions alive.
    for e in graph.edges:
        if len(e.points) < min_len:
            e.removed = True
            stats["dropped_short"] += 1
    stats["merged"] = _merge_collinear(graph, tol_deg=30.0)

    strength = mask_prob if score_map is None else score_map
    traces: list[dict] = []
    for idx, e in enumerate(graph.edges):
        if e.removed:
            continue
        ys_arr = np.array([p[1] for p in e.points])
        xs_arr = np.array([p[0] for p in e.points])
        median_w = float(np.median(width_map[ys_arr, xs_arr])) if width_map is not None else None
        if width_map is not None and median_w is not None:
            if (width_min > 0 and median_w < width_min) or (width_max > 0 and median_w > width_max):
                stats["dropped_width"] += 1
                e.removed = True
                continue
        sel = strength[ys_arr, xs_arr]
        score = float(sel.mean()) if sel.size else 0.0

        # Polyline: node centroid anchors at both attached ends + DP.
        pts_src: list[tuple[int, int]] = []
        if e.a is not None and e.a in graph.nodes:
            pts_src.append(graph.nodes[e.a])
        pts_src.extend(e.points)
        if e.b is not None and e.b in graph.nodes:
            pts_src.append(graph.nodes[e.b])
        arr = np.array(pts_src, dtype=np.int32).reshape(-1, 1, 2)
        approx = (cv2.approxPolyDP(arr, epsilon, closed=False).reshape(-1, 2)
                  if len(arr) >= 3 else arr.reshape(-1, 2))
        polyline = _fuse_small_turns([[int(x), int(y)] for x, y in approx], turn_tol_deg)
        if len(polyline) < 2:
            continue
        trace: dict = {"points": polyline, "score": round(score, 4)}
        if median_w is not None:
            trace["width"] = round(median_w, 2)
        traces.append((idx, trace))

    groups = _group_edges(graph)
    out: list[dict] = []
    for idx, t in traces:
        t = dict(t)
        t["group"] = int(groups.get(idx, idx))
        out.append(t)
        stats["kept"] += 1
        if len(out) >= max_traces:
            print(f"[warn] wire runs: hit cap {max_traces} — mask is noisy")
            break
    return {"traces": out, "stats": stats}
