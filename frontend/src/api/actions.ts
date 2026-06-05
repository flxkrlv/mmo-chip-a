import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AnnotationNet,
  Cell,
  CellType,
  DieAnnotations,
  Guide,
  HumanAnnotation,
  IgnoreRect,
  IOPin,
  ROIRectangle
} from "shared";
import type { NetChange } from "../lib/netGraph";
import { annotationKeys, removeById, upsertById } from "./annotations";
import { apiDelete, apiPut } from "./client";
import { useDieViewerStore } from "../state/dieViewer";

// ── Action union ─────────────────────────────────────────────────────
//
// Every annotation mutation in the UI is funnelled through this union. Each
// variant carries enough payload to re-apply forward AND compute its inverse
// without consulting current state — `removeAnnotation` carries the full
// entity it deleted so undo can put the same one back.
//
// Adding a new edit kind means three edits in this file:
//   1. add a variant to AnnotationAction
//   2. extend `inverseOf`
//   3. extend `applyAction` (cache transform) and `requestAction` (HTTP)

export type AnnotationAction =
  // Whole-net upsert. `prevNet` is the net's state before this edit (null if
  // it didn't exist), so the inverse is computable without consulting state.
  | { kind: "upsertNet"; net: AnnotationNet; prevNet: AnnotationNet | null }
  | { kind: "removeNet"; net: AnnotationNet }
  // Whole-cell / whole-cell-type upsert. `prev*` is the entity before the edit
  // (null if it didn't exist) so the inverse is computable without state.
  | { kind: "upsertCell"; cell: Cell; prevCell: Cell | null }
  | { kind: "removeCell"; cell: Cell }
  | { kind: "upsertCellType"; cellType: CellType; prevCellType: CellType | null }
  | { kind: "removeCellType"; cellType: CellType }
  | { kind: "addPin"; pin: IOPin }
  | { kind: "removePin"; pin: IOPin }
  // Whole-pin upsert with `prevPin` (null if new) so renames undo cleanly.
  | { kind: "upsertPin"; pin: IOPin; prevPin: IOPin | null }
  // ── ML annotations (schema v2) ─────────────────────────────────────
  // `HumanAnnotation` covers point_via / irregular_via (persisted classes;
  // `trace` is derived from nets, never edited here). ROIs and ignore rects
  // are separate optional collections. All carry `prev*` for clean undo.
  | {
      kind: "upsertAnnotation";
      annotation: HumanAnnotation;
      prevAnnotation: HumanAnnotation | null;
    }
  | { kind: "removeAnnotation"; annotation: HumanAnnotation }
  | { kind: "upsertRoi"; roi: ROIRectangle; prevRoi: ROIRectangle | null }
  | { kind: "removeRoi"; roi: ROIRectangle }
  | { kind: "upsertIgnore"; ignore: IgnoreRect; prevIgnore: IgnoreRect | null }
  | { kind: "removeIgnore"; ignore: IgnoreRect }
  | { kind: "upsertGuide"; guide: Guide; prevGuide: Guide | null }
  | { kind: "removeGuide"; guide: Guide }
  // One user gesture that touches several nets atomically (cross-net merge,
  // graph-splitting delete). Applied/persisted in order; undone in reverse.
  | { kind: "batch"; actions: AnnotationAction[] };

export function inverseOf(action: AnnotationAction): AnnotationAction {
  switch (action.kind) {
    case "upsertNet":
      return action.prevNet === null
        ? { kind: "removeNet", net: action.net }
        : { kind: "upsertNet", net: action.prevNet, prevNet: action.net };
    case "removeNet":
      return { kind: "upsertNet", net: action.net, prevNet: null };
    case "upsertCell":
      return action.prevCell === null
        ? { kind: "removeCell", cell: action.cell }
        : { kind: "upsertCell", cell: action.prevCell, prevCell: action.cell };
    case "removeCell":
      return { kind: "upsertCell", cell: action.cell, prevCell: null };
    case "upsertCellType":
      return action.prevCellType === null
        ? { kind: "removeCellType", cellType: action.cellType }
        : {
            kind: "upsertCellType",
            cellType: action.prevCellType,
            prevCellType: action.cellType
          };
    case "removeCellType":
      return { kind: "upsertCellType", cellType: action.cellType, prevCellType: null };
    case "addPin":
      return { kind: "removePin", pin: action.pin };
    case "removePin":
      return { kind: "addPin", pin: action.pin };
    case "upsertPin":
      return action.prevPin === null
        ? { kind: "removePin", pin: action.pin }
        : { kind: "upsertPin", pin: action.prevPin, prevPin: action.pin };
    case "upsertAnnotation":
      return action.prevAnnotation === null
        ? { kind: "removeAnnotation", annotation: action.annotation }
        : {
            kind: "upsertAnnotation",
            annotation: action.prevAnnotation,
            prevAnnotation: action.annotation
          };
    case "removeAnnotation":
      return {
        kind: "upsertAnnotation",
        annotation: action.annotation,
        prevAnnotation: null
      };
    case "upsertRoi":
      return action.prevRoi === null
        ? { kind: "removeRoi", roi: action.roi }
        : { kind: "upsertRoi", roi: action.prevRoi, prevRoi: action.roi };
    case "removeRoi":
      return { kind: "upsertRoi", roi: action.roi, prevRoi: null };
    case "upsertIgnore":
      return action.prevIgnore === null
        ? { kind: "removeIgnore", ignore: action.ignore }
        : {
            kind: "upsertIgnore",
            ignore: action.prevIgnore,
            prevIgnore: action.ignore
          };
    case "removeIgnore":
      return { kind: "upsertIgnore", ignore: action.ignore, prevIgnore: null };
    case "upsertGuide":
      return action.prevGuide === null
        ? { kind: "removeGuide", guide: action.guide }
        : { kind: "upsertGuide", guide: action.prevGuide, prevGuide: action.guide };
    case "removeGuide":
      return { kind: "upsertGuide", guide: action.guide, prevGuide: null };
    case "batch":
      return { kind: "batch", actions: [...action.actions].reverse().map(inverseOf) };
  }
}

/**
 * Map net-graph `{ prev, next }` diffs to an action. Returns a single action
 * for one change, a `batch` for several (one undo step), or null for none.
 */
export function netChangesToAction(changes: NetChange[]): AnnotationAction | null {
  const actions: AnnotationAction[] = [];
  for (const c of changes) {
    if (c.next) actions.push({ kind: "upsertNet", net: c.next, prevNet: c.prev });
    else if (c.prev) actions.push({ kind: "removeNet", net: c.prev });
  }
  if (actions.length === 0) return null;
  if (actions.length === 1) return actions[0];
  return { kind: "batch", actions };
}

/** Pure transform: apply an action to a snapshot of the annotations. */
export function applyAction(annotations: DieAnnotations, action: AnnotationAction): DieAnnotations {
  switch (action.kind) {
    case "upsertNet":
      return { ...annotations, nets: upsertById(annotations.nets, action.net) };
    case "removeNet":
      return { ...annotations, nets: removeById(annotations.nets, action.net.id) };
    case "upsertCell":
      return { ...annotations, cells: upsertById(annotations.cells, action.cell) };
    case "removeCell":
      return { ...annotations, cells: removeById(annotations.cells, action.cell.id) };
    case "upsertCellType":
      return {
        ...annotations,
        cellTypes: upsertById(annotations.cellTypes, action.cellType)
      };
    case "removeCellType":
      return {
        ...annotations,
        cellTypes: removeById(annotations.cellTypes, action.cellType.id)
      };
    case "addPin":
      return {
        ...annotations,
        pins: upsertById(annotations.pins ?? [], action.pin)
      };
    case "removePin":
      return {
        ...annotations,
        pins: removeById(annotations.pins ?? [], action.pin.id)
      };
    case "upsertPin":
      return {
        ...annotations,
        pins: upsertById(annotations.pins ?? [], action.pin)
      };
    case "upsertAnnotation":
      return {
        ...annotations,
        annotations: upsertById(annotations.annotations ?? [], action.annotation)
      };
    case "removeAnnotation":
      return {
        ...annotations,
        annotations: removeById(
          annotations.annotations ?? [],
          action.annotation.id
        )
      };
    case "upsertRoi":
      return { ...annotations, rois: upsertById(annotations.rois ?? [], action.roi) };
    case "removeRoi":
      return { ...annotations, rois: removeById(annotations.rois ?? [], action.roi.id) };
    case "upsertIgnore":
      return {
        ...annotations,
        ignores: upsertById(annotations.ignores ?? [], action.ignore)
      };
    case "removeIgnore":
      return {
        ...annotations,
        ignores: removeById(annotations.ignores ?? [], action.ignore.id)
      };
    case "upsertGuide":
      return {
        ...annotations,
        guides: upsertById(annotations.guides ?? [], action.guide)
      };
    case "removeGuide":
      return {
        ...annotations,
        guides: removeById(annotations.guides ?? [], action.guide.id)
      };
    case "batch":
      return action.actions.reduce(applyAction, annotations);
  }
}

/** Persist the action against the backend. Returns the new revision. */
export async function requestAction(
  dieId: string,
  action: AnnotationAction
): Promise<{ ok: true; rev: number }> {
  switch (action.kind) {
    case "upsertNet":
      return apiPut(`/api/dies/${dieId}/nets/${action.net.id}`, action.net);
    case "removeNet":
      return apiDelete(`/api/dies/${dieId}/nets/${action.net.id}`);
    case "upsertCell":
      return apiPut(`/api/dies/${dieId}/cells/${action.cell.id}`, action.cell);
    case "removeCell":
      return apiDelete(`/api/dies/${dieId}/cells/${action.cell.id}`);
    case "upsertCellType":
      return apiPut(
        `/api/dies/${dieId}/cell-types/${action.cellType.id}`,
        action.cellType
      );
    case "removeCellType":
      return apiDelete(`/api/dies/${dieId}/cell-types/${action.cellType.id}`);
    case "addPin":
      return apiPut(`/api/dies/${dieId}/pins/${action.pin.id}`, action.pin);
    case "removePin":
      return apiDelete(`/api/dies/${dieId}/pins/${action.pin.id}`);
    case "upsertPin":
      return apiPut(`/api/dies/${dieId}/pins/${action.pin.id}`, action.pin);
    case "upsertAnnotation":
      return apiPut(
        `/api/dies/${dieId}/annotations/${action.annotation.id}`,
        action.annotation
      );
    case "removeAnnotation":
      return apiDelete(
        `/api/dies/${dieId}/annotations/${action.annotation.id}`
      );
    case "upsertRoi":
      return apiPut(`/api/dies/${dieId}/rois/${action.roi.id}`, action.roi);
    case "removeRoi":
      return apiDelete(`/api/dies/${dieId}/rois/${action.roi.id}`);
    case "upsertIgnore":
      return apiPut(
        `/api/dies/${dieId}/ignores/${action.ignore.id}`,
        action.ignore
      );
    case "removeIgnore":
      return apiDelete(`/api/dies/${dieId}/ignores/${action.ignore.id}`);
    case "upsertGuide":
      return apiPut(`/api/dies/${dieId}/guides/${action.guide.id}`, action.guide);
    case "removeGuide":
      return apiDelete(`/api/dies/${dieId}/guides/${action.guide.id}`);
    case "batch": {
      // Persist sub-actions in order; report the final revision.
      let result: { ok: true; rev: number } = { ok: true, rev: 0 };
      for (const sub of action.actions) result = await requestAction(dieId, sub);
      return result;
    }
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────

export interface ActionDispatcher {
  /** Apply an action as the user's intent — pushes onto the undo stack. */
  dispatch: (action: AnnotationAction) => Promise<void>;
  /** Pop the most recent action and apply its inverse. Best-effort: if the
   *  inverse can't be applied (e.g. a remote client already removed the
   *  entity), the entry is dropped from history. */
  undo: () => Promise<void>;
  /** Re-apply the last undone action. */
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * One dispatcher per die. Dispatching is the only way to mutate annotations;
 * persistence happens automatically (optimistic cache update → server call
 * → rollback on error → invalidate on settled).
 */
export function useActionDispatcher(dieId: string): ActionDispatcher {
  const qc = useQueryClient();

  const undoStack = useDieViewerStore((s) => s.undoStack);
  const redoStack = useDieViewerStore((s) => s.redoStack);
  const pushUndo = useDieViewerStore((s) => s.pushUndo);
  const popUndo = useDieViewerStore((s) => s.popUndo);
  const pushRedo = useDieViewerStore((s) => s.pushRedo);
  const popRedo = useDieViewerStore((s) => s.popRedo);
  const clearRedo = useDieViewerStore((s) => s.clearRedo);

  const apply = useCallback(
    async (action: AnnotationAction): Promise<boolean> => {
      const key = annotationKeys.forDie(dieId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<DieAnnotations>(key);
      if (previous) {
        qc.setQueryData<DieAnnotations>(key, applyAction(previous, action));
      }
      try {
        await requestAction(dieId, action);
        return true;
      } catch (error) {
        // Rollback the optimistic update.
        if (previous) qc.setQueryData(key, previous);
        console.warn(`[action] ${action.kind} failed`, error);
        return false;
      } finally {
        // Safety net: server is authoritative. The WS notification usually
        // beats this, but invalidating here guarantees eventual consistency
        // even if the socket dropped.
        void qc.invalidateQueries({ queryKey: key });
      }
    },
    [qc, dieId]
  );

  const dispatch = useCallback<ActionDispatcher["dispatch"]>(
    async (action) => {
      const ok = await apply(action);
      if (!ok) return;
      pushUndo(action);
      clearRedo();
    },
    [apply, pushUndo, clearRedo]
  );

  const undo = useCallback<ActionDispatcher["undo"]>(async () => {
    const action = popUndo();
    if (!action) return;
    const ok = await apply(inverseOf(action));
    if (ok) pushRedo(action);
    // best-effort: on failure the action is already off the stack.
  }, [apply, popUndo, pushRedo]);

  const redo = useCallback<ActionDispatcher["redo"]>(async () => {
    const action = popRedo();
    if (!action) return;
    const ok = await apply(action);
    if (ok) pushUndo(action);
  }, [apply, popRedo, pushUndo]);

  return {
    dispatch,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0
  };
}
