/**
 * spiceHandoff.ts — a tiny server-side mailbox for an agent's finished SPICE
 * run. The SPICE page polls `/latest` and offers to open the run; the file
 * lives inside the project so a restart does not lose it.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { resolveProjectDir } from "../projectLayout.js";

const MAX_NETLIST_CHARS = 2_000_000;

function handoffPath(projectDir: string): string {
  return path.join(projectDir, "spice-runs", "latest.json");
}

export function createSpiceHandoffRouter(config: { dataRoot: string }) {
  const router = Router();

  router.post("/api/dies/:dieId/spice-handoff", async (request, response, next) => {
    try {
      const dieId = String(request.params.dieId);
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (typeof body.netlist !== "string" || body.netlist.length === 0) {
        response.status(400).json({ error: "netlist is required" });
        return;
      }
      if (body.netlist.length > MAX_NETLIST_CHARS) {
        response.status(413).json({ error: "netlist is too large for a handoff" });
        return;
      }
      const { dir } = await resolveProjectDir(config.dataRoot, dieId);
      const target = handoffPath(dir);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const at = typeof body.at === "number" && Number.isFinite(body.at) ? body.at : Date.now();
      const record = { ...body, dieId, at };
      await fs.writeFile(target, JSON.stringify(record, null, 2), "utf8");
      response.json({ ok: true, at });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/spice-handoff/latest", async (request, response, next) => {
    try {
      const dieId = String(request.params.dieId);
      const { dir } = await resolveProjectDir(config.dataRoot, dieId);
      try {
        const raw = await fs.readFile(handoffPath(dir), "utf8");
        const record = JSON.parse(raw) as Record<string, unknown>;
        response.json({ ...record, dieId });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          response.status(404).json({ error: "no SPICE handoff yet" });
          return;
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
}
