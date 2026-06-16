import { useCallback, useEffect, useRef } from "react";
import type { Cell, CellType, DieAnnotations } from "shared";
import type { ActionDispatcher } from "../../api/actions";
import { normalizeRect, type Rect } from "../../lib/geometry";
import { isTypingTarget } from "../../lib/keyboard";
import type { LiveValue } from "../../lib/liveValue";
import type { AnnotationHit } from "../../renderer/layers/AnnotationLayer";
import { useDieViewerStore, type ToolKind } from "../../state/dieViewer";
import { uuid } from "../../lib/uuid";

/** Cell annotations carry `id: "cell:<cellId>"` and no sub-parts, so the hit's
 *  partId is exactly that. */
const CELL_ID_PREFIX = "cell:";

/** Below this (image px) a drawn rectangle is treated as an accidental click
 *  and discarded instead of committed. */
const MIN_CELL_SIZE = 1;

export interface CellTool {
  /** Resolve a hit to its placed cell + its type, for select-tool drag-move.
   *  Null when the hit isn't a cell (or its type is missing). */
  cellFromHit: (
    hit: AnnotationHit | null
  ) => { cell: Cell; cellType: CellType } | null;
  /** Commit the current rubber-band rect as a fresh cell type + placed cell
   *  instance. No-op (just clears) if the rect is missing or degenerate. */
  commitCell: () => void;
  /** Esc: leave the tool (any in-progress rubber-band is transient). */
  cancel: () => void;
}

/**
 * The free "Add cell" tool: drag a rectangle (rubber-band lives in
 * `cellRectLive` so dragging never re-renders the page). The drawn rect
 * stays on screen as a *draft* — drag a corner to resize or the body to
 * move it — until the user presses **Enter** to commit (creates a new
 * origin-relative `CellType` + placed `Cell`, one batched undo step) or
 * **Escape** to discard.
 */
export function useCellTool(opts: {
  dispatcher: ActionDispatcher;
  annotations: DieAnnotations | undefined;
  cellRectLive: LiveValue<Rect | null>;
  activeTool: ToolKind;
  setActiveTool: (tool: ToolKind) => void;
}): CellTool {
  const { dispatcher, annotations, cellRectLive, activeTool, setActiveTool } =
    opts;

  // Always-fresh snapshots so the resolver stays referentially stable (the
  // pointer-down router closes over it without re-binding on every edit).
  const cellsRef = useRef<Cell[]>([]);
  cellsRef.current = annotations?.cells ?? [];
  const cellTypesRef = useRef<CellType[]>([]);
  cellTypesRef.current = annotations?.cellTypes ?? [];

  const cellFromHit = useCallback(
    (hit: AnnotationHit | null) => {
      if (!hit || !hit.partId.startsWith(CELL_ID_PREFIX)) return null;
      const cellId = hit.partId.slice(CELL_ID_PREFIX.length);
      const cell = cellsRef.current.find((c) => c.id === cellId);
      if (!cell) return null;
      const cellType = cellTypesRef.current.find(
        (ct) => ct.id === cell.cellTypeId
      );
      if (!cellType) return null;
      return { cell, cellType };
    },
    []
  );

  const commitCell = useCallback(() => {
    const rect = cellRectLive.get();
    if (!rect) return;
    const n = normalizeRect(rect);
    if (n.width < MIN_CELL_SIZE || n.height < MIN_CELL_SIZE) {
      cellRectLive.set(null);
      return;
    }
    const x = Math.round(n.x);
    const y = Math.round(n.y);
    const width = Math.round(n.width);
    const height = Math.round(n.height);

    const cellType: CellType = {
      id: uuid(),
      name: `Cell ${(annotations?.cellTypes.length ?? 0) + 1}`,
      cropRect: { x: 0, y: 0, width, height }
    };
    const cell: Cell = {
      id: uuid(),
      cellTypeId: cellType.id,
      x,
      y
    };
    void dispatcher.dispatch({
      kind: "batch",
      actions: [
        { kind: "upsertCellType", cellType, prevCellType: null },
        { kind: "upsertCell", cell, prevCell: null }
      ]
    });
    // Stay in the tool, ready to draw the next one (legacy parity).
    cellRectLive.set(null);
  }, [annotations, cellRectLive, dispatcher]);

  const cancel = useCallback(() => {
    if (cellRectLive.get()) {
      cellRectLive.set(null);
    } else {
      setActiveTool("select");
    }
  }, [cellRectLive, setActiveTool]);

  // Leaving the tool abandons any uncommitted rectangle.
  useEffect(() => {
    if (activeTool !== "addCell" && cellRectLive.get()) cellRectLive.set(null);
  }, [activeTool, cellRectLive]);

  // Keyboard: Enter commits the pending draft rect, Escape discards it (or
  // leaves the tool when there's nothing to discard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useDieViewerStore.getState().activeTool !== "addCell") return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "Enter") {
        if (!cellRectLive.get()) return;
        e.preventDefault();
        commitCell();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, commitCell, cellRectLive]);

  return { cellFromHit, commitCell, cancel };
}
