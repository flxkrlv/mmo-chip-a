/**
 * analogExport.ts — Backend API: netlist file store ONLY.
 *
 * The frontend runs all detection + SPICE generation via:
 *   collectDieWideAnalogDevices() → generateSpiceNetlist()
 * and sends the final netlist text here for persisting to disk.
 *
 * Endpoints:
 *   POST /api/dies/:dieId/analog-export  — write netlist file to disk
 *   POST /api/dies/:dieId/spice-config   — save SPICE technology config
 *   GET  /api/dies/:dieId/spice-config   — load SPICE technology config
 *   PUT  /api/dies/:dieId/analog-layers  — save die-level analog layers
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { AnalogDevicesFile, SpiceConfig } from "shared";
import { readDieRecord } from "../store.js";
import { resolveProjectDir } from "../projectLayout.js";

const ANALOG_DEVICES_FILE = "analog-devices.json";

// ── SpiceConfig I/O ────────────────────────────────────────────────

async function loadSpiceConfig(dataRoot: string, dieId: string): Promise<SpiceConfig | null> {
  try {
    const { dir } = await resolveProjectDir(dataRoot, dieId);
    const p = path.join(dir, "spice_config.json");
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as SpiceConfig;
  } catch {
    return null;
  }
}

async function saveSpiceConfig(
  dataRoot: string,
  dieId: string,
  config: SpiceConfig,
): Promise<void> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "spice_config.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
}

// ── Analog device name store I/O ────────────────────────────────────
// The names of detected analog devices are stored per-project in
// `analog-devices.json` (inside the project folder / die dir) so they stay
// bound to the project across ZIP round-trips and folder moves.

async function loadAnalogDevices(
  dataRoot: string,
  dieId: string,
): Promise<AnalogDevicesFile | null> {
  try {
    const { dir } = await resolveProjectDir(dataRoot, dieId);
    const raw = await fs.readFile(path.join(dir, ANALOG_DEVICES_FILE), "utf8");
    const parsed = JSON.parse(raw) as AnalogDevicesFile;
    if (!parsed || typeof parsed !== "object" || typeof parsed.devices !== "object") {
      return null;
    }
    return { version: 1, devices: parsed.devices };
  } catch {
    return null;
  }
}

async function saveAnalogDevices(
  dataRoot: string,
  dieId: string,
  data: AnalogDevicesFile,
): Promise<void> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, ANALOG_DEVICES_FILE),
    `${JSON.stringify({ version: 1, devices: data.devices ?? {} }, null, 2)}\n`,
    "utf8",
  );
}

// ═════════════════════════════════════════════════════════════════
// Express router
// ═════════════════════════════════════════════════════════════════

export function createAnalogExportRouter(config: { dataRoot: string }) {
  const router = Router();

  /**
   * POST /api/dies/:dieId/analog-export
   *
   * Accepts a pre-generated netlist text from the frontend and writes
   * it to disk. The frontend owns all detection + SPICE generation
   * (collectDieWideAnalogDevices → generateSpiceNetlist).
   *
   * Body: {
   *   netlist: string,          // full netlist text
   *   moduleName: string,       // file name (without extension)
   *   dialect: "cdl"|"spectre"|"hspice",
   * }
   *
   * Response: { netlistPath, ok: true }
   */
  router.post("/api/dies/:dieId/analog-export", async (request, response, next) => {
    const { dieId } = request.params;
    try {
      await readDieRecord(config.dataRoot, dieId);

      const body = request.body ?? {};
      const netlist: string = body.netlist ?? "";
      const moduleName: string = (body.moduleName ?? "netlist").replace(/[^A-Za-z0-9_-]/g, "_");
      const dialect: string = body.dialect ?? "cdl";

      if (!netlist) {
        response.status(400).json({ error: "No netlist text provided" });
        return;
      }

      // Write output file
      const { dir: projectDir } = await resolveProjectDir(config.dataRoot, dieId);
      const exportDir = path.join(projectDir, "export");
      await fs.mkdir(exportDir, { recursive: true });
      const ext = dialect === "spectre" ? "scs" : "cdl";
      const netlistPath = path.join(exportDir, `${moduleName}.${ext}`);
      await fs.writeFile(netlistPath, netlist, "utf8");

      response.status(200).json({ netlistPath, ok: true });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/dies/:dieId/spice-config
   *
   * Save SPICE technology configuration for a die.
   */
  router.post("/api/dies/:dieId/spice-config", async (request, response, next) => {
    const { dieId } = request.params;
    try {
      await readDieRecord(config.dataRoot, dieId);
      const sc = request.body as SpiceConfig;
      await saveSpiceConfig(config.dataRoot, dieId, sc);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/dies/:dieId/spice-config
   *
   * Load saved SPICE technology configuration.
   */
  router.get("/api/dies/:dieId/spice-config", async (request, response, next) => {
    const { dieId } = request.params;
    try {
      await readDieRecord(config.dataRoot, dieId);
      const sc = await loadSpiceConfig(config.dataRoot, dieId);
      response.json(sc ?? {});
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/dies/:dieId/analog-devices
   *
   * Load the per-project analog device name store.
   */
  router.get("/api/dies/:dieId/analog-devices", async (request, response, next) => {
    const { dieId } = request.params;
    try {
      await readDieRecord(config.dataRoot, dieId);
      const data = await loadAnalogDevices(config.dataRoot, dieId);
      response.json(data ?? { version: 1, devices: {} });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/dies/:dieId/analog-devices
   *
   * Save the per-project analog device name store.
   */
  router.post("/api/dies/:dieId/analog-devices", async (request, response, next) => {
    const { dieId } = request.params;
    try {
      await readDieRecord(config.dataRoot, dieId);
      const body = (request.body ?? {}) as Partial<AnalogDevicesFile>;
      const devices =
        body.devices && typeof body.devices === "object" ? body.devices : {};
      await saveAnalogDevices(config.dataRoot, dieId, { version: 1, devices });
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/dies/:dieId/analog-layers
   *
   * Save die-level analog layer annotations (CellLayers).
   */
  router.put("/api/dies/:dieId/analog-layers", async (request, response, next) => {
    const { dieId } = request.params;
    try {
      await readDieRecord(config.dataRoot, dieId);
      const { readAnnotations, writeAnnotations } = await import("../store.js");
      const annotations = await readAnnotations(config.dataRoot, dieId);
      annotations.analogLayers = request.body ?? {};
      const rev = await writeAnnotations(config.dataRoot, dieId, annotations);
      response.json({ ok: true, rev });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
