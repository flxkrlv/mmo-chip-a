import { useEffect, useRef } from "react";
import { sendStatus } from "../api/annotationsWebSocket";
import { useSession } from "../state/session";

/**
 * Broadcast the current die + tool to other users via WebSocket.
 * Call from any page/component that has a tool.
 */
export function useUserStatus(dieId: string | null, tool: string | null): void {
  // Debounce to avoid flooding on die-change
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      sendStatus(dieId, tool);
    }, 200);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, [dieId, tool]);
}

/**
 * Simplified: just tracks the session dieId (no tool). Use this on pages
 * that don't have an active tool (Library, etc.).
 */
export function usePageStatus(dieId: string | null): void {
  useUserStatus(dieId, null);
}
