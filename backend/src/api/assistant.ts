import { Router } from "express";
import type { AssistantAnalysisRequest, AssistantDiscussRequest, AssistantLvsCheckRequest, AssistantLvsCheckResponse } from "shared";
import { readAnnotations, readDieRecord } from "../store.js";
import { prepareAssistantSnapshot } from "../assistant/assistantSnapshot.js";
import { analyseFullGraphWithLlm, discussFindingWithLlm } from "../assistant/llmGraphAnalysis.js";
import { emitSubcircuitSpice } from "../assistant/subcircuitExtract.js";
import { loadLibrary, listLibraries, addSpiceCell, DEFAULT_LIBRARY_ID, type LvsLibrary, type LvsLibraryCell } from "../assistant/lvsLibrary.js";
import { matchSubcircuit } from "../assistant/lvsMatch.js";
import { dedupeCells } from "../assistant/lvsDedup.js";
import { pendingVisionRequests } from "../assistant/visionTool.js";

/**
 * The assistant router is intentionally read-only. It validates the current
 * annotation revision, analyses the browser extraction snapshot, and never
 * calls writeAnnotations or a mutation endpoint.
 */
export function createAssistantRouter(config: { dataRoot: string }) {
  const router = Router();

  router.post("/api/dies/:dieId/assistant/analyze", async (request, response) => {
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

      const prepared = prepareAssistantSnapshot(dieId, annotations.rev, body);
      const data = await analyseFullGraphWithLlm(prepared, body.circuit, body.llmConfig, body.assistantDataFlags);
      response.json({ ok: true, data });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown LLM error";
      if (/required|exceeds/.test(reason)) {
        response.status(400).json({ ok: false, error: reason });
        return;
      }
      console.error(`[assistant/analyze] failed for ${request.params.dieId}: ${reason}`);
      response.status(502).json({ ok: false, error: `Assistant analysis failed: ${reason}` });
    }
  });

  router.post("/api/dies/:dieId/assistant/analyze/stream", async (request, response) => {
    const { dieId } = request.params;
    try {
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

      const prepared = prepareAssistantSnapshot(dieId, annotations.rev, body);

      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders?.();
      const sendEvent = (event: string, payload: unknown) => {
        try { response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
      };

      const data = await analyseFullGraphWithLlm(prepared, body.circuit, body.llmConfig, body.assistantDataFlags, (ev) => {
        if (ev.type === "token") sendEvent("token", { content: ev.content });
        else if (ev.type === "thinking") sendEvent("thinking", { content: ev.content });
      });
      sendEvent("done", { ok: true, data });
      response.end();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown LLM error";
      console.error(`[assistant/analyze/stream] failed for ${request.params.dieId}: ${reason}`);
      if (response.headersSent) {
        try {
          response.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: `Assistant analysis failed: ${reason}` })}\n\n`);
          response.end();
        } catch { /* ignore */ }
      } else if (/required|exceeds/.test(reason)) {
        response.status(400).json({ ok: false, error: reason });
      } else {
        response.status(502).json({ ok: false, error: `Assistant analysis failed: ${reason}` });
      }
    }
  });

  router.post("/api/dies/:dieId/assistant/discuss", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const body = (request.body ?? {}) as AssistantDiscussRequest;
      if (!body.finding || !Array.isArray(body.finding.deviceUuids) || !body.circuit || !Array.isArray(body.circuit.devices)) {
        response.status(400).json({ ok: false, error: "A finding and a serialised circuit snapshot are required." });
        return;
      }
      if (body.expectedRev != null && body.expectedRev !== annotations.rev) {
        response.status(409).json({
          ok: false,
          error: "The annotations changed before discussion could start.",
          detail: `Expected revision ${body.expectedRev}, current revision ${annotations.rev}. Refresh the extracted circuit and retry.`,
        });
        return;
      }
      const { reply, durationMs, cardUpdate, lvsResults } = await discussFindingWithLlm(
        body.finding,
        Array.isArray(body.messages) ? body.messages : [],
        body.circuit,
        body.llmConfig,
        body.brief ?? {},
        body.mode ?? "functional_blocks",
        config.dataRoot,
        body.toolFlags,
        dieId,
        body.assistantDataFlags,
      );
      response.json({ ok: true, reply, durationMs, cardUpdate: cardUpdate ?? null, lvsResults: lvsResults ?? [] });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown LLM error";
      console.error(`[assistant/discuss] failed for ${request.params.dieId}: ${reason}`);
      response.status(502).json({ ok: false, error: `Assistant discussion failed: ${reason}` });
    }
  });

  router.post("/api/dies/:dieId/assistant/discuss/stream", async (request, response) => {
    const { dieId } = request.params;
    try {
      await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);
      const body = (request.body ?? {}) as AssistantDiscussRequest;
      if (!body.finding || !Array.isArray(body.finding.deviceUuids) || !body.circuit || !Array.isArray(body.circuit.devices)) {
        response.status(400).json({ ok: false, error: "A finding and a serialised circuit snapshot are required." });
        return;
      }
      if (body.expectedRev != null && body.expectedRev !== annotations.rev) {
        response.status(409).json({
          ok: false,
          error: "The annotations changed before discussion could start.",
          detail: `Expected revision ${body.expectedRev}, current revision ${annotations.rev}. Refresh the extracted circuit and retry.`,
        });
        return;
      }

      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders?.();
      const sendEvent = (event: string, payload: unknown) => {
        try { response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
      };

      const { reply, durationMs, cardUpdate, lvsResults } = await discussFindingWithLlm(
        body.finding,
        Array.isArray(body.messages) ? body.messages : [],
        body.circuit,
        body.llmConfig,
        body.brief ?? {},
        body.mode ?? "functional_blocks",
        config.dataRoot,
        body.toolFlags,
        dieId,
        body.assistantDataFlags,
        (ev) => {
          if (ev.type === "token") sendEvent("token", { content: ev.content });
          else if (ev.type === "thinking") sendEvent("thinking", { content: ev.content });
          else if (ev.type === "tool_start") sendEvent("tool_start", { tool: ev.tool, args: ev.args });
          else if (ev.type === "tool_result") sendEvent("tool_result", { tool: ev.tool, ok: ev.ok, images: ev.images });
        },
      );
      sendEvent("done", { ok: true, reply, durationMs, cardUpdate: cardUpdate ?? null, lvsResults: lvsResults ?? [] });
      response.end();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown LLM error";
      console.error(`[assistant/discuss/stream] failed for ${request.params.dieId}: ${reason}`);
      if (response.headersSent) {
        try {
          response.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: `Assistant discussion failed: ${reason}` })}\n\n`);
          response.end();
        } catch { /* ignore */ }
      } else {
        response.status(502).json({ ok: false, error: `Assistant discussion failed: ${reason}` });
      }
    }
  });

  // ── LVS reference-library check (standalone, used by the manual card button) ──

  router.get("/api/dies/:dieId/assistant/lvs-libraries", async (_request, response) => {
    try {
      const libs = await listLibraries(config.dataRoot);
      response.json({ ok: true, data: libs });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      response.status(500).json({ ok: false, error: reason });
    }
  });

  router.post("/api/dies/:dieId/assistant/lvs-check", async (request, response) => {
    try {
      const body = (request.body ?? {}) as AssistantLvsCheckRequest;
      if (!body.circuit || !Array.isArray(body.circuit.devices) || !Array.isArray(body.deviceUuids)) {
        response.status(400).json({ ok: false, error: "A circuit snapshot and deviceUuids are required." });
        return;
      }
      const candidate = emitSubcircuitSpice(body.circuit.devices, body.circuit.namedNets, body.deviceUuids);
      const topologies = Array.isArray(body.topologies) && body.topologies.length > 0 ? body.topologies : null;

      let library: LvsLibrary | null = null;
      if (topologies) {
        // Search the selected topology groups across every available library.
        const libs = await listLibraries(config.dataRoot);
        const cells: LvsLibraryCell[] = [];
        for (const lib of libs) {
          const full = await loadLibrary(config.dataRoot, lib.libId);
          if (full) cells.push(...full.cells.filter((cell) => topologies.includes(cell.topology ?? "")));
        }
        library = cells.length > 0 ? { libId: "filtered", cells } : null;
      } else {
        const libId = body.libraryId || DEFAULT_LIBRARY_ID;
        library = await loadLibrary(config.dataRoot, libId);
        if (!library) {
          response.status(404).json({
            ok: false,
            error: `Reference library '${libId}' not found. Import it (scripts/import-analog-circuits) or add a user library.`,
          });
          return;
        }
      }

      if (!library || library.cells.length === 0) {
        response.status(404).json({
          ok: false,
          error: topologies
            ? `No reference cells found for topologies: ${topologies.join(", ")}.`
            : `Reference library '${body.libraryId || DEFAULT_LIBRARY_ID}' is empty.`,
        });
        return;
      }

      // Collapse topologically-identical reference cells so vyges-lvs runs once
      // per unique topology+connectivity rather than once per parameter variant.
      const dedup = dedupeCells(library.cells);
      const dedupedLibrary: LvsLibrary = { libId: library.libId, cells: dedup.representatives };
      const totalCells = dedup.originalCount;

      // When the user explicitly narrowed to topology groups, the structural
      // prefilter (signature distance ≤ tolerance) would otherwise drop the
      // entire group for a small candidate (e.g. 2 NMOS vs 3,506 bandgaps) and
      // report "0 cells compared". Relax it so the selected group is actually
      // checked (capped by budget), and stream progress so long checks stay
      // visible in the UI.
      const tolerance = topologies ? Number.MAX_SAFE_INTEGER : (body.tolerance ?? 3);

      // Stream progress via Server-Sent Events so large group checks don't hit
      // the request timeout and the UI can show a live count.
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders?.();
      const sendEvent = (event: string, payload: unknown) => {
        response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      const summary = await matchSubcircuit(candidate, dedupedLibrary, {
        tolerance,
        budget: body.budget ?? 50,
        onProgress: (checked, total) => sendEvent("progress", { checked, total }),
      });

      const data: AssistantLvsCheckResponse["data"] = {
        candidateSignature: summary.candidateSignature,
        candidateNetlist: summary.candidateNetlist,
        checkedCount: summary.checkedCount,
        totalCells,
        uniqueCells: dedupedLibrary.cells.length,
        matches: summary.matches,
        best: summary.best,
        topologyCounts: summary.topologyCounts,
      };
      sendEvent("result", { ok: true, data });
      response.end();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      console.error(`[assistant/lvs-check] failed: ${reason}`);
      try {
        response.write(`event: error\ndata: ${JSON.stringify({ ok: false, error: `LVS check failed: ${reason}` })}\n\n`);
      } catch {
        /* ignore */
      }
      response.end();
    }
  });

  router.post("/api/dies/:dieId/assistant/lvs-library/:libId/cell", async (request, response) => {
    try {
      const { libId } = request.params;
      const { cellId, spice } = (request.body ?? {}) as { cellId?: string; spice?: string };
      if (!cellId || !spice) {
        response.status(400).json({ ok: false, error: "cellId and spice are required." });
        return;
      }
      const library = await addSpiceCell(config.dataRoot, libId, cellId, spice);
      response.json({ ok: true, data: { libId: library.libId, cellCount: library.cells.length } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      response.status(502).json({ ok: false, error: `Add cell failed: ${reason}` });
    }
  });

  // ── Vision tool: pending requests and result delivery ──

  router.get("/api/dies/:dieId/assistant/pending-vision", (request, response) => {
    const { dieId } = request.params;
    const pending = [...pendingVisionRequests.values()]
      .filter((r) => r.dieId === dieId)
      .map((r) => ({ requestId: r.requestId, deviceUuids: r.deviceUuids, devices: r.devices, layerName: r.layerName }));
    response.json({ ok: true, requests: pending });
  });

  router.post("/api/dies/:dieId/assistant/vision-result/:requestId", (request, response) => {
    const { requestId } = request.params;
    const body = (request.body ?? {}) as { images?: string[]; layerName?: string };
    const req = pendingVisionRequests.get(requestId);
    if (!req) {
      response.status(404).json({ ok: false, error: `Vision request ${requestId} not found or already consumed.` });
      return;
    }
    pendingVisionRequests.delete(requestId);
    req.resolve(body.images ?? [], body.layerName);
    response.json({ ok: true });
  });

  return router;
}
