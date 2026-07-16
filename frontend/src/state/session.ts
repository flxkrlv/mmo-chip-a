import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MetalStack } from "shared";

export const DEFAULT_METAL_STACK: MetalStack = {
  metals: [
    { id: "ME1", layer: "metal1", z: 1, name: "Metal 1", color: "#2dd4bf" },
    { id: "ME2", layer: "metal2", z: 2, name: "Metal 2", color: "#a78bfa" },
    { id: "ME3", layer: "metal3", z: 3, name: "Metal 3", color: "#4ade80" },
    { id: "ME4", layer: "metal4", z: 4, name: "Metal 4", color: "#f472b6" },
    { id: "ME5", layer: "metal5", z: 5, name: "Metal 5", color: "#fb923c" },
    { id: "ME6", layer: "metal6", z: 6, name: "Metal 6", color: "#60a5fa" },
  ],
  vias: [
    { id: "VIA12", from: "ME1", to: "ME2", layer: "via1", color: "#82d6a6" },
    { id: "VIA23", from: "ME2", to: "ME3", layer: "via2", color: "#82d6a6" },
    { id: "VIA34", from: "ME3", to: "ME4", layer: "via3", color: "#82d6a6" },
    { id: "VIA45", from: "ME4", to: "ME5", layer: "via4", color: "#82d6a6" },
    { id: "VIA56", from: "ME5", to: "ME6", layer: "via5", color: "#82d6a6" },
  ],
  defaultMetalId: "ME1",
  defaultViaId: "VIA12",
};

/** Build a MetalStack with `count` metals (1..6) and `Math.max(0, count - 1)` vias.
 *  Uses the naming/color conventions from DEFAULT_METAL_STACK. */
export function buildMetalStack(count: number): MetalStack {
  const n = Math.max(1, Math.min(6, count));
  return {
    metals: DEFAULT_METAL_STACK.metals.slice(0, n),
    vias: DEFAULT_METAL_STACK.vias.slice(0, Math.max(0, n - 1)),
    defaultMetalId: DEFAULT_METAL_STACK.metals[0].id,
    defaultViaId: n >= 2 ? DEFAULT_METAL_STACK.vias[0].id : DEFAULT_METAL_STACK.defaultViaId,
  };
}

export async function fetchMetalStack(dieId: string): Promise<MetalStack> {
  const res = await fetch(`/api/dies/${dieId}/metal-stack`);
  if (!res.ok) return DEFAULT_METAL_STACK;
  return res.json() as Promise<MetalStack>;
}

interface SessionState {
  /** The die the user is currently working on. Survives navigation to other
   *  phases (incl. Library) and a page reload, so the phase tabs can route
   *  back to the same die instead of dropping the context. */
  dieId: string | null;
  /** Per-die metal stack configuration. Loaded from server on die open. */
  metalStack: MetalStack | null;
}

interface SessionActions {
  setDieId: (dieId: string | null) => void;
  setMetalStack: (stack: MetalStack | null) => void;
}

/**
 * App-level navigation context + per-die metal stack config.
 */
export const useSession = create<SessionState & SessionActions>()(
  persist(
    (set) => ({
      dieId: null,
      metalStack: null,
      setDieId: (dieId) => set({ dieId }),
      setMetalStack: (stack) => set({ metalStack: stack }),
    }),
    { name: "mmo-chip-session", version: 1 }
  )
);
