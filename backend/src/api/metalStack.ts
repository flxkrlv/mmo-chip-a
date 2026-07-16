import { Router } from "express";
import type { MetalStack, DieConfig } from "shared";
import { readDieRecord, writeDieRecord } from "../store.js";

const DEFAULT_METAL_STACK: MetalStack = {
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

export { DEFAULT_METAL_STACK };

export function validateMetalStack(stack: MetalStack): string | null {
  if (!stack.metals || stack.metals.length < 1) {
    return "At least one metal layer is required";
  }
  const metalIds = new Set<string>();
  for (let i = 0; i < stack.metals.length; i++) {
    const m = stack.metals[i];
    if (!m.id || !m.layer || !m.name) return `Metal at index ${i} is missing required fields (id, layer, name)`;
    if (metalIds.has(m.id)) return `Duplicate metal id: ${m.id}`;
    metalIds.add(m.id);
    if (m.z !== i + 1) return `Metals must be sorted by z (expected ${i + 1}, got ${m.z} at index ${i})`;
  }
  const viaIds = new Set<string>();
  for (let i = 0; i < stack.vias.length; i++) {
    const v = stack.vias[i];
    if (!v.id || !v.from || !v.to || !v.layer) return `Via at index ${i} is missing required fields (id, from, to, layer)`;
    if (viaIds.has(v.id)) return `Duplicate via id: ${v.id}`;
    viaIds.add(v.id);
    if (!metalIds.has(v.from)) return `Via ${v.id} references unknown metal: ${v.from}`;
    if (!metalIds.has(v.to)) return `Via ${v.id} references unknown metal: ${v.to}`;
  }
  if (stack.defaultMetalId && !metalIds.has(stack.defaultMetalId)) {
    return `defaultMetalId "${stack.defaultMetalId}" not found in metals`;
  }
  if (stack.defaultViaId && !viaIds.has(stack.defaultViaId)) {
    return `defaultViaId "${stack.defaultViaId}" not found in vias`;
  }
  return null;
}

export function createMetalStackRouter(config: { dataRoot: string }) {
  const router = Router();

  router.get("/api/dies/:dieId/metal-stack", async (request, response, next) => {
    try {
      const record = await readDieRecord(config.dataRoot, request.params.dieId);
      const stack = record.config?.metalStack ?? DEFAULT_METAL_STACK;
      response.json(stack);
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/dies/:dieId/metal-stack", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const stack = request.body as MetalStack;
      const error = validateMetalStack(stack);
      if (error) {
        response.status(400).json({ error });
        return;
      }
      const record = await readDieRecord(config.dataRoot, dieId);
      record.config = { ...record.config, metalStack: stack } as DieConfig;
      await writeDieRecord(config.dataRoot, record);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
