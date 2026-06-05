import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SessionState {
  /** The die the user is currently working on. Survives navigation to other
   *  phases (incl. Library) and a page reload, so the phase tabs can route
   *  back to the same die instead of dropping the context. */
  dieId: string | null;
}

interface SessionActions {
  setDieId: (dieId: string | null) => void;
}

/**
 * App-level navigation context. Deliberately tiny and separate from
 * `dieViewer` (which is per-die-session and resets) and `preferences`
 * (user display prefs).
 */
export const useSession = create<SessionState & SessionActions>()(
  persist(
    (set) => ({
      dieId: null,
      setDieId: (dieId) => set({ dieId })
    }),
    { name: "mmo-chip-session", version: 1 }
  )
);
