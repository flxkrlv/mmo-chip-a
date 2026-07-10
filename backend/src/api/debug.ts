import { promises as fsp } from "node:fs";
import path from "node:path";
import { Router } from "express";

export function createDebugRouter(config: { dataRoot: string }) {
  const router = Router();

  router.post("/api/lvs/debug/snapshot", async (request, response, next) => {
    try {
      const logsDir = path.join(config.dataRoot, "logs", "lvs_debug");
      await fsp.mkdir(logsDir, { recursive: true });

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = path.join(logsDir, `lvs_${ts}.json`);

      const body = request.body ?? {};
      const snapshot = {
        time: new Date().toISOString(),
        layoutNetlist: body.layoutNetlist ?? "",
        schematicNetlist: body.schematicNetlist ?? "",
        matched: body.matched,
        json: body.json,
        report: body.report,
        devices: body.devices,
        stderr: body.stderr ?? "",
      };

      await fsp.writeFile(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
      console.log(`[debug] LVS snapshot saved: ${filePath}`);
      response.json({ ok: true, path: filePath });
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}
