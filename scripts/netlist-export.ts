/**
 * netlist-export.ts — server-side analog netlist extraction (one-shot CLI).
 *
 * WHY THIS EXISTS
 * ---------------
 * The analog extraction pipeline (device detection + SPICE generation) lives in
 * `frontend/src` and depends on the Clipper2 WASM polygon engine. It is pure
 * data-in/data-out TypeScript (no React, no DOM), so it runs fine in Node —
 * `backend/src/analog-extraction.test.ts` already proves that. But the backend
 * tsconfig has `"rootDir": "src"`, so importing frontend modules from a backend
 * module would break `npm run build -w backend`. This script sidesteps that by
 * running as its own process from the repo root, where `../frontend/...`
 * resolves. The backend spawns it the same way it already spawns ngspice and
 * the vyges-lvs CLI.
 *
 * USAGE
 *   node --import tsx scripts/netlist-export.ts <dieId> <projectDir> <moduleName> <dialect>
 *
 * Reads from <projectDir>:
 *   annotations.json    (die annotations: nets, cells, cellTypes, pins)
 *   spice_config.json   (technology config, optional)
 *   analog-devices.json (saved device names R1/Q1/..., optional)
 *
 * Emits a single line to stdout prefixed with __RESULT__ followed by JSON:
 *   { ok, text, byKind, totalDevices, warnings, virtualConnects, namedNetCount }
 *
 * Anything else printed to stdout is ignored by the caller (the sentinel
 * prefix makes the result line unambiguous even if a dependency logs noise).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadClipperWithBinary } from "../frontend/src/lib/extraction/clipper.js";
import { collectDieWideAnalogDevices } from "../frontend/src/api/dieWideAnalog.js";
import { generateSpiceNetlist } from "../frontend/src/lib/export/spice.js";
import { setProjectDeviceName } from "../frontend/src/state/analogDeviceNames.js";

const SENTINEL = "__RESULT__";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface VirtualConnect {
  /** Net name shared by more than one physical annotation net. */
  name: string;
  /** SPICE node ids that collapse into this one node. */
  spiceNetIds: number[];
  /** Human labels of the physical nets involved (annotation names). */
  physicalNets: string[];
}

function readJsonIfPresent<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function emit(payload: unknown): void {
  process.stdout.write(`\n${SENTINEL}${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const [, , dieId, projectDir, moduleName, dialect] = process.argv;
  if (!dieId || !projectDir) {
    emit({ ok: false, error: "usage: netlist-export.ts <dieId> <projectDir> <moduleName> <dialect>" });
    process.exitCode = 2;
    return;
  }

  // Clipper2 WASM — same bootstrap the backend test file uses.
  const wasmPath = path.join(REPO_ROOT, "node_modules", "clipper2-wasm", "dist", "umd", "clipper2z.wasm");
  await loadClipperWithBinary(readFileSync(wasmPath));

  const annotations = readJsonIfPresent<any>(path.join(projectDir, "annotations.json"), null);
  if (!annotations) {
    emit({ ok: false, error: `no annotations.json in ${projectDir}` });
    process.exitCode = 2;
    return;
  }
  const spiceConfig = readJsonIfPresent<any>(path.join(projectDir, "spice_config.json"), {});
  const namesFile = readJsonIfPresent<{ devices: Record<string, string> }>(
    path.join(projectDir, "analog-devices.json"),
    { devices: {} },
  );

  // Restore the user's saved device names (R1/Q1/C1/...) so the emitted
  // netlist uses the same designators the app shows.
  for (const [instanceId, name] of Object.entries(namesFile.devices ?? {})) {
    setProjectDeviceName(instanceId, name);
  }

  const umPerPx: number = annotations.umPerPx ?? spiceConfig?.umPerPx ?? 1.0;
  const { devices, namedNets, netIdMap } = collectDieWideAnalogDevices(annotations, umPerPx, spiceConfig);

  // Reverse netIdMap (annotation net id -> spice id) so each virtual connect
  // can name the physical nets involved.
  const annIdBySpiceId = new Map<number, string[]>();
  for (const [annId, spiceId] of netIdMap) {
    const list = annIdBySpiceId.get(spiceId) ?? [];
    list.push(annId);
    annIdBySpiceId.set(spiceId, list);
  }
  const annNameById = new Map<string, string>();
  for (const n of (annotations.nets ?? []) as Array<{ id: string; name: string }>) {
    annNameById.set(n.id, n.name);
  }

  // A net name claimed by more than one physical annotation net is a VIRTUAL
  // CONNECT: distinct wires (e.g. a current-sensing ground pad and a potential
  // ground pad) that share one node name. SPICE merges them by name, so this
  // is intentional behaviour, not an error — but it is worth surfacing so the
  // reviewer can confirm each case is deliberate.
  const idsByName = new Map<string, number[]>();
  for (const [spiceId, name] of namedNets) {
    if (!name) continue;
    const list = idsByName.get(name) ?? [];
    list.push(spiceId);
    idsByName.set(name, list);
  }
  const virtualConnects: VirtualConnect[] = [];
  for (const [name, spiceNetIds] of idsByName) {
    if (spiceNetIds.length <= 1) continue;
    const physicalNets: string[] = [];
    for (const spiceId of spiceNetIds) {
      for (const annId of annIdBySpiceId.get(spiceId) ?? []) {
        const annName = annNameById.get(annId);
        physicalNets.push(annName && annName !== name ? `${annName} (${annId})` : annId);
      }
    }
    virtualConnects.push({ name, spiceNetIds, physicalNets });
  }

  const result = generateSpiceNetlist(
    devices,
    (moduleName || "netlist").replace(/[^A-Za-z0-9_-]/g, "_"),
    spiceConfig ?? {},
    (dialect as any) ?? "cdl",
    namedNets,
  );

  emit({
    ok: true,
    dieId,
    umPerPx,
    deviceCount: devices.length,
    namedNetCount: namedNets.size,
    byKind: result.byKind,
    totalDevices: result.totalDevices,
    warnings: [...(result.warnings ?? [])],
    virtualConnects,
    text: result.text,
  });
}

main().catch((error) => {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
