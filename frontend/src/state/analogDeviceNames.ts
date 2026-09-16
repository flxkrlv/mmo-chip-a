/**
 * analogDeviceNames.ts — Per-project analog device name store.
 *
 * Names of detected analog devices are scoped to the current project and
 * persisted in the project's `analog-devices.json` (external folder for a
 * folder project, `<dataRoot>/dies/<dieId>/` for a managed one). This replaces
 * the old browser-global `mmo-chip-device-registry` / `mmo-chip-analog-names`
 * for NAMES, so a name stays bound to its device across ZIP round-trips,
 * folder moves and re-opens.
 *
 * Keys are deterministic device-instance ids (`<cellAnchor>@<cellInstanceId>`)
 * derived from the cell type's layer shape ids, produced by the extraction
 * pipeline (`_instanceId` in `dieWideAnalog.ts`).
 *
 * Lifecycle:
 *   - The die page calls `setActiveProject(dieId)` on open, which async-loads
 *     the project's names. The extraction pipeline reads names synchronously
 *     via `getProjectDeviceNames()`; until the load completes,
 *     `isProjectNamesLoaded()` is false and no names are persisted, so a slow
 *     load can never clobber stored names.
 */

import { create } from "zustand";
import { apiGet, apiPost } from "../api/client";

interface AnalogDevicesPayload {
  version: number;
  devices: Record<string, string>;
}

let activeDieId: string | null = null;
let names: Record<string, string> = {};
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave = false;

// ── Reactivity ────────────────────────────────────────────────────

export const useAnalogNamesVersion = create<{ v: number }>(() => ({ v: 0 }));
let _version = 0;
function bump(): void {
  _version += 1;
  useAnalogNamesVersion.setState({ v: _version });
}
export function getAnalogNamesVersion(): number {
  return _version;
}

// ── Accessors (synchronous, for the extraction pipeline) ──────────

export function getActiveProjectDieId(): string | null {
  return activeDieId;
}

export function getProjectDeviceNames(): Readonly<Record<string, string>> {
  return names;
}

export function isProjectNamesLoaded(): boolean {
  return loaded;
}

// ── Active project lifecycle ──────────────────────────────────────

export function setActiveProject(dieId: string | null): void {
  if (dieId === activeDieId) return;
  activeDieId = dieId;
  names = {};
  loaded = false;
  flushSave();
  bump();
  if (dieId) void loadFromBackend(dieId);
}

async function loadFromBackend(dieId: string): Promise<void> {
  try {
    const data = await apiGet<AnalogDevicesPayload>(
      `/api/dies/${encodeURIComponent(dieId)}/analog-devices`,
    );
    if (activeDieId !== dieId) return; // a newer project was opened meanwhile
    names = data?.devices ?? {};
    loaded = true;
    bump();
  } catch {
    if (activeDieId !== dieId) return;
    loaded = true;
  }
}

// ── Mutations ─────────────────────────────────────────────────────

/** Assign (or overwrite) a device name and persist it to the project. */
export function setProjectDeviceName(instanceId: string, name: string): void {
  if (!instanceId) return;
  if (names[instanceId] === name) return;
  names[instanceId] = name;
  bump();
  scheduleSave();
}

/** Name → other-device collision check within the current project. */
export function validateProjectDeviceName(
  instanceId: string,
  newName: string,
): string | null {
  const s = newName.trim();
  if (!s) return "Name is empty";
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(s)) {
    return "Must start with letter, only letters/digits/underscores";
  }
  if (s.length > 48) return "Too long (max 48 chars)";
  for (const [id, name] of Object.entries(names)) {
    if (id === instanceId) continue;
    if (name === s) return `"${s}" is already assigned to another device`;
  }
  return null;
}

function scheduleSave(): void {
  pendingSave = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), 250);
}

async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!activeDieId || !loaded || !pendingSave) return;
  pendingSave = false;
  const dieId = activeDieId;
  try {
    await apiPost(`/api/dies/${encodeURIComponent(dieId)}/analog-devices`, {
      version: 1,
      devices: names,
    });
  } catch {
    // best-effort: names remain in memory and are retried on the next change
    pendingSave = true;
  }
}

/** Persist any pending name changes immediately (page unload etc.). */
export function flushProjectDeviceNames(): void {
  void flushSave();
}
