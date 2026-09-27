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
/** Manual edits made before the backend load finished — never clobbered by it. */
let pendingEdits: Record<string, string> = {};

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

/**
 * Reconcile the store with the set of device instances that currently exist
 * on the die.
 *
 * Names of devices that are gone are dropped, so a deleted device's name is
 * freed and can be re-assigned (automatically or manually) to another device.
 * Names of devices that still exist are never touched. No-op until the
 * backend load has finished, so a slow load can never erase stored names.
 */
export function syncLiveProjectDevices(
  liveInstanceIds: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  if (!loaded) return names;
  let changed = false;
  for (const id of Object.keys(names)) {
    if (!liveInstanceIds.has(id)) {
      delete names[id];
      changed = true;
    }
  }
  if (changed) {
    bump();
    scheduleSave();
  }
  return names;
}

/** Collect the numbers already used per name prefix (M1, R2, ...). */
export function collectUsedNameNumbers(
  source: Readonly<Record<string, string>>,
): Record<string, Set<number>> {
  const used: Record<string, Set<number>> = {};
  for (const name of Object.values(source)) {
    const m = name.match(/^([A-Za-z]+)(\d+)$/);
    if (m) (used[m[1]] ??= new Set<number>()).add(parseInt(m[2], 10));
  }
  return used;
}

/** Smallest unused `<prefix><n>` (n >= 1) for the given used-number set. */
export function nextFreeInstanceName(prefix: string, used: Set<number>): string {
  let n = 1;
  while (used.has(n)) n += 1;
  return `${prefix}${n}`;
}

// ── Active project lifecycle ──────────────────────────────────────

export function setActiveProject(dieId: string | null): void {
  if (dieId === activeDieId) return;
  activeDieId = dieId;
  names = {};
  pendingEdits = {};
  loaded = false;
  flushSave();
  bump();
  if (dieId) void loadFromBackend(dieId);
}

const LOAD_MAX_ATTEMPTS = 4;
const LOAD_RETRY_BASE_MS = 1000;

async function loadFromBackend(dieId: string, attempt = 0): Promise<void> {
  try {
    const data = await apiGet<AnalogDevicesPayload>(
      `/api/dies/${encodeURIComponent(dieId)}/analog-devices`,
    );
    if (activeDieId !== dieId) return; // a newer project was opened meanwhile
    // Merge over anything renamed while the request was in flight, so a slow
    // load can never overwrite a user's manual rename.
    names = { ...(data?.devices ?? {}), ...pendingEdits };
    const hadEdits = Object.keys(pendingEdits).length > 0;
    pendingEdits = {};
    loaded = true;
    bump();
    if (hadEdits || pendingSave) scheduleSave();
  } catch {
    if (activeDieId !== dieId) return;
    // A failed read must NEVER be treated as "loaded with no names": that
    // would let the pipeline auto-name every device and persist it, wiping
    // the names already stored for the project. Keep `loaded` false (which
    // also disables saving) and retry the read a few times.
    if (attempt < LOAD_MAX_ATTEMPTS - 1) {
      const delay = LOAD_RETRY_BASE_MS * (attempt + 1);
      setTimeout(() => {
        if (activeDieId === dieId) void loadFromBackend(dieId, attempt + 1);
      }, delay);
    }
  }
}

// ── Mutations ─────────────────────────────────────────────────────

/** Assign (or overwrite) a device name and persist it to the project. */
export function setProjectDeviceName(instanceId: string, name: string): void {
  if (!instanceId) return;
  if (names[instanceId] === name) return;
  names[instanceId] = name;
  if (!loaded) pendingEdits[instanceId] = name;
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
