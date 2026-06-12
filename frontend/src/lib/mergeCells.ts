import type { Cell, CellType, DieAnnotations } from "shared";
import type { AnnotationAction } from "../api/actions";

// ── Orientation ──────────────────────────────────────────────────────

export type Rotation = 0 | 90 | 180 | 270;

export interface Orient {
  flippedH: boolean;
  flippedV: boolean;
  rotation: Rotation;
}

export function orientOf(cell: Cell): Orient {
  return {
    flippedH: cell.flippedH === true,
    flippedV: cell.flippedV === true,
    rotation: (cell.rotation ?? 0) as Rotation
  };
}

export function rotateCw(r: Rotation): Rotation {
  return (((r + 90) % 360) as Rotation);
}

// ── Size / grouping helpers ──────────────────────────────────────────

export function typeSize(ct: CellType): { w: number; h: number; area: number } {
  const w = ct.cropRect.width;
  const h = ct.cropRect.height;
  return { w, h, area: w * h };
}

/**
 * Distance between two cell-type footprints, resilient to 90° rotation and
 * flips: we compare the *unordered* {short, long} side pair plus the area, so
 * a tall cell and the same cell rotated 90° score as identical. Lower = more
 * likely the same cell — that's the candidate sort order.
 */
export function sizeDistance(a: CellType, b: CellType): number {
  const sa = typeSize(a);
  const sb = typeSize(b);
  const aMin = Math.min(sa.w, sa.h);
  const aMax = Math.max(sa.w, sa.h);
  const bMin = Math.min(sb.w, sb.h);
  const bMax = Math.max(sb.w, sb.h);
  const dimDiff = Math.abs(aMin - bMin) + Math.abs(aMax - bMax);
  // Normalise the area term so it's comparable to pixel dim diffs.
  const areaDiff = Math.abs(sa.area - sb.area) / Math.max(aMax, bMax, 1);
  return dimDiff + areaDiff;
}

const byName = (a: CellType, b: CellType) =>
  (a.name ?? "").localeCompare(b.name ?? "", undefined, { numeric: true });

export interface GroupedTypes {
  matched: CellType[];
  unmatched: CellType[];
}

export function groupCellTypes(annotations: DieAnnotations): GroupedTypes {
  const matched: CellType[] = [];
  const unmatched: CellType[] = [];
  for (const ct of annotations.cellTypes) {
    if (ct.matched === true) matched.push(ct);
    else unmatched.push(ct);
  }
  matched.sort(byName);
  unmatched.sort(byName);
  return { matched, unmatched };
}

export function membersOf(annotations: DieAnnotations, typeId: string): Cell[] {
  return annotations.cells.filter((c) => c.cellTypeId === typeId);
}

export function cellTypeById(
  annotations: DieAnnotations,
  id: string | null | undefined
): CellType | null {
  if (!id) return null;
  return annotations.cellTypes.find((ct) => ct.id === id) ?? null;
}

export function cellById(
  annotations: DieAnnotations,
  id: string | null | undefined
): Cell | null {
  if (!id) return null;
  return annotations.cells.find((c) => c.id === id) ?? null;
}

/**
 * The reference cell shown as the fixed specimen: the explicitly-selected
 * member, else the first member of the specimen type. Null when the type has
 * no member cells yet (caller falls back to the cell-type crop template).
 */
export function resolveSpecimenCell(
  annotations: DieAnnotations,
  specimenTypeId: string | null,
  specimenCellId: string | null
): Cell | null {
  if (!specimenTypeId) return null;
  if (specimenCellId) {
    const sel = cellById(annotations, specimenCellId);
    if (sel && sel.cellTypeId === specimenTypeId) return sel;
  }
  return membersOf(annotations, specimenTypeId)[0] ?? null;
}

export interface Candidate {
  cell: Cell;
  cellType: CellType;
  /** Already merged into the active specimen (shows the green check, pinned
   *  to the front of the list). */
  done: boolean;
}

/**
 * All cells offered as candidates for the active specimen: every cell whose
 * type is still unmatched, plus the ones already merged into this specimen
 * (kept visible with a check). Sorted: done first, then by ascending size
 * distance to the specimen footprint.
 */
export function candidatesFor(
  annotations: DieAnnotations,
  specimenType: CellType | null
): Candidate[] {
  const typeOf = new Map(annotations.cellTypes.map((ct) => [ct.id, ct]));
  const out: Candidate[] = [];
  for (const cell of annotations.cells) {
    const ct = typeOf.get(cell.cellTypeId);
    if (!ct) continue;
    // A cell already belongs to the active specimen type (including its
    // founding / first member) → show it as done, pinned to the front.
    const inSpecimen = specimenType != null && ct.id === specimenType.id;
    const isUnmatched = ct.matched !== true;
    // Members of *other* matched (real) types aren't candidates.
    if (!inSpecimen && !isUnmatched) continue;
    out.push({ cell, cellType: ct, done: inSpecimen });
  }
  out.sort((a, b) => {
    if (a.done !== b.done) return a.done ? -1 : 1;
    if (!specimenType) return byName(a.cellType, b.cellType);
    const d = sizeDistance(a.cellType, specimenType) - sizeDistance(b.cellType, specimenType);
    if (d !== 0) return d;
    return byName(a.cellType, b.cellType);
  });
  return out;
}

// ── Crop URLs ────────────────────────────────────────────────────────
//
// The server cache key for a cell crop is `${cellId}-${left}-${top}.jpg`, so
// re-aligning (which changes the cell's x/y) naturally yields a fresh crop.
// We mirror x/y into the query so the *browser* cache busts too.

export function cellCropUrl(dieId: string, cell: Cell): string {
  const x = Math.max(0, Math.round(cell.x));
  const y = Math.max(0, Math.round(cell.y));
  return `/api/dies/${dieId}/cells/${cell.id}/crop?x=${x}&y=${y}`;
}

export function cellTypeCropUrl(dieId: string, cellTypeId: string): string {
  return `/api/dies/${dieId}/cell-types/${cellTypeId}/crop`;
}

// ── Action builders ──────────────────────────────────────────────────

const newId = () => crypto.randomUUID();

export interface MergePlan {
  action: AnnotationAction;
  /** The candidate's current type carries layer annotations the merge would
   *  detach (the target has none) — surface a confirm before dispatching. */
  losesAnnotations: boolean;
}

function hasLayerShapes(ct: CellType | null): boolean {
  if (!ct || !ct.layers) return false;
  return Object.values(ct.layers).some((s) => s != null && s.length > 0);
}

/**
 * Re-type `candidate` into `specimenType` with the given orientation/position,
 * promote the specimen to a matched type, and clean up the candidate's now
 * orphaned placeholder type. One batched (single-undo) action.
 */
export function buildMergeAction(
  annotations: DieAnnotations,
  candidate: Cell,
  specimenType: CellType,
  orient: Orient & { x: number; y: number }
): MergePlan {
  const prevCell = candidate;
  const prevType = cellTypeById(annotations, candidate.cellTypeId);

  const nextCell: Cell = {
    ...candidate,
    cellTypeId: specimenType.id,
    x: Math.round(orient.x),
    y: Math.round(orient.y),
    flippedH: orient.flippedH || undefined,
    flippedV: orient.flippedV || undefined,
    rotation: orient.rotation === 0 ? undefined : orient.rotation,
    merged: true
  };

  const actions: AnnotationAction[] = [
    { kind: "upsertCell", cell: nextCell, prevCell }
  ];

  if (specimenType.matched !== true) {
    actions.push({
      kind: "upsertCellType",
      cellType: { ...specimenType, matched: true },
      prevCellType: specimenType
    });
  }

  // Drop the candidate's old placeholder if nothing else references it (and
  // it isn't the specimen itself / an already-matched real type).
  if (
    prevType &&
    prevType.id !== specimenType.id &&
    prevType.matched !== true &&
    !annotations.cells.some(
      (c) => c.id !== candidate.id && c.cellTypeId === prevType.id
    )
  ) {
    actions.push({ kind: "removeCellType", cellType: prevType });
  }

  return {
    action: actions.length === 1 ? actions[0] : { kind: "batch", actions },
    losesAnnotations: hasLayerShapes(prevType) && !hasLayerShapes(specimenType)
  };
}

/**
 * Detach `cell` from its (matched) type back into a fresh standalone unmatched
 * placeholder type — the inverse intent of a merge. One batched action.
 */
export function buildUnmatchAction(
  annotations: DieAnnotations,
  cell: Cell
): AnnotationAction {
  const prevType = cellTypeById(annotations, cell.cellTypeId);
  const cropRect = prevType
    ? { x: 0, y: 0, width: prevType.cropRect.width, height: prevType.cropRect.height }
    : { x: 0, y: 0, width: 0, height: 0 };
  const placeholder: CellType = {
    id: newId(),
    name: `cell ${cell.id.slice(0, 6)}`,
    cropRect,
    matched: false
  };
  const nextCell: Cell = { ...cell, cellTypeId: placeholder.id, merged: undefined };
  return {
    kind: "batch",
    actions: [
      { kind: "upsertCellType", cellType: placeholder, prevCellType: null },
      { kind: "upsertCell", cell: nextCell, prevCell: cell }
    ]
  };
}

/** A single-field orientation/position edit on a candidate (flip/rotate/align)
 *  — its own undo step. */
export function buildOrientAction(
  cell: Cell,
  patch: Partial<Pick<Cell, "flippedH" | "flippedV" | "rotation" | "x" | "y">>
): AnnotationAction {
  const next: Cell = { ...cell, ...patch };
  // Normalise falsy orientation to absent so the JSON stays clean.
  if (next.flippedH === false) delete next.flippedH;
  if (next.flippedV === false) delete next.flippedV;
  if (next.rotation === 0) delete next.rotation;
  return { kind: "upsertCell", cell: next, prevCell: cell };
}
