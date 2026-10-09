import { beforeEach, describe, expect, it } from "vitest";
import type { Cell } from "shared";
import type { AnnotationAction } from "../api/actions";
import { useDieViewerStore } from "./dieViewer";

const cell = { id: "c1", cellTypeId: "t1", x: 0, y: 0 } as Cell;
const rotate: AnnotationAction = {
  kind: "upsertCell",
  cell: { ...cell, rotation: 90 },
  prevCell: cell
};

describe("undo history ownership", () => {
  beforeEach(() => {
    const s = useDieViewerStore.getState();
    s.ensureHistoryFor("die-a");
    useDieViewerStore.setState({ undoStack: [], redoStack: [] });
  });

  it("survives the die viewer's reset on mount (e.g. coming back from Merge)", () => {
    const s = useDieViewerStore.getState();
    s.pushUndo(rotate); // e.g. a rotation done in Merge cells
    s.pushRedo(rotate);
    s.reset();
    const after = useDieViewerStore.getState();
    expect(after.undoStack).toEqual([rotate]);
    expect(after.redoStack).toEqual([rotate]);
    expect(after.historyDieId).toBe("die-a");
  });

  it("reset still clears transient state", () => {
    useDieViewerStore.getState().setActiveTool("wire");
    useDieViewerStore.getState().reset();
    expect(useDieViewerStore.getState().activeTool).toBe("select");
  });

  it("is kept for the same die and dropped for another die", () => {
    useDieViewerStore.getState().pushUndo(rotate);
    useDieViewerStore.getState().ensureHistoryFor("die-a");
    expect(useDieViewerStore.getState().undoStack).toHaveLength(1);

    useDieViewerStore.getState().ensureHistoryFor("die-b");
    const s = useDieViewerStore.getState();
    expect(s.undoStack).toEqual([]);
    expect(s.redoStack).toEqual([]);
    expect(s.historyDieId).toBe("die-b");
  });
});
