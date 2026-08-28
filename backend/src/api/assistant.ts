import { Router } from "express";
import type { AssistantAnalysisRequest } from "shared";
import { readAnnotations, readDieRecord } from "../store.js";
import { analyseSubcircuits } from "../assistant/subcircuitAnalysis.js";
import { analyseFullGraphWithLlm } from "../assistant/llmGraphAnalysis.js";

/**
 * The assistant router is intentionally read-only. It validates the current
 * annotation revision, analyses the browser extraction snapshot, and never
 * calls writeAnnotations or a mutation endpoint.
 */
export function createAssistantRouter(config: { dataRoot: string }) {
  const router = Router();

  router.post("/api/dies/:dieId/assistant/analyze", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const body = (request.body ?? {}) as AssistantAnalysisRequest;

      if (!body.circuit || !Array.isArray(body.circuit.devices) || !Array.isArray(body.circuit.namedNets)) {
        response.status(400).json({ ok: false, error: "A serialised circuit snapshot with devices and namedNets is required." });
        return;
      }
      if (body.expectedRev != null && body.expectedRev !== annotations.rev) {
        response.status(409).json({
          ok: false,
          error: "The annotations changed before analysis could start.",
          detail: `Expected revision ${body.expectedRev}, current revision ${annotations.rev}. Refresh the extracted circuit and retry.`,
        });
        return;
      }

      const deterministic = analyseSubcircuits(dieId, annotations.rev, body);
      const data = await analyseFullGraphWithLlm(deterministic, body.circuit, body.llmConfig);
      response.json({ ok: true, data });
    } catch (error) {
      if (error instanceof Error && /required|exceeds/.test(error.message)) {
        response.status(400).json({ ok: false, error: error.message });
        return;
      }
      next(error);
    }
  });

  return router;
}
