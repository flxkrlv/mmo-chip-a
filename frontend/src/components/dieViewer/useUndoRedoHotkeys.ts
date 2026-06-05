import { useEffect } from "react";
import type { ActionDispatcher } from "../../api/actions";
import { isTypingTarget } from "../../lib/keyboard";
import { useDieViewerStore } from "../../state/dieViewer";

/**
 * The single ⌘Z / ⌘⇧Z (Ctrl on Windows/Linux) handler. It dispatches
 * dynamically: if a tool has registered an `undoOverride` in the store
 * (e.g. the wire tool while a draft is in progress, for per-point undo),
 * the keystroke routes there; otherwise it drives the global action
 * dispatcher's undo/redo. Reading the override via `getState()` at event
 * time keeps the listener bound once and always current.
 */
export function useUndoRedoHotkeys(dispatcher: ActionDispatcher): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "z" && e.key !== "Z") return;
      if (isTypingTarget(e.target)) return; // let inputs do native text undo
      e.preventDefault();
      const override = useDieViewerStore.getState().undoOverride;
      if (override) {
        if (e.shiftKey) override.redo();
        else override.undo();
      } else if (e.shiftKey) {
        void dispatcher.redo();
      } else {
        void dispatcher.undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatcher]);
}
