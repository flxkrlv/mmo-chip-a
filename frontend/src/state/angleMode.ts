/**
 * angleMode.ts — the current die's angle mode per drawing tool
 * (lib/angleConstraint), stored per die in preferences.angleModesByDie so it
 * survives reloads and tool switches.
 */

import { useCallback } from "react";
import {
  DEFAULT_ANGLE_MODES,
  isAngleMode,
  type AngleMode,
  type AngleTool
} from "../lib/angleConstraint";
import { usePreferences } from "./preferences";
import { useSession } from "./session";

function modeFrom(
  byDie: Record<string, Partial<Record<AngleTool, AngleMode>>>,
  dieId: string | null,
  tool: AngleTool
): AngleMode {
  const saved = dieId ? byDie[dieId]?.[tool] : undefined;
  return isAngleMode(saved) ? saved : DEFAULT_ANGLE_MODES[tool];
}

/** Non-reactive read for event handlers (clicks, pointer moves). */
export function currentAngleMode(tool: AngleTool): AngleMode {
  return modeFrom(usePreferences.getState().angleModesByDie, useSession.getState().dieId, tool);
}

/** Reactive mode + setter for the current die (toolbar chips). */
export function useAngleMode(tool: AngleTool): [AngleMode, (mode: AngleMode) => void] {
  const dieId = useSession((s) => s.dieId);
  const mode = usePreferences((s) => modeFrom(s.angleModesByDie, dieId, tool));
  const setAngleMode = usePreferences((s) => s.setAngleMode);
  const setMode = useCallback(
    (m: AngleMode) => {
      if (dieId) setAngleMode(dieId, tool, m);
    },
    [dieId, setAngleMode, tool]
  );
  return [mode, setMode];
}
