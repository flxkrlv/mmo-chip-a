/**
 * deviceRegistry.ts — Persistent per-device identity store.
 *
 * Problem: a device's _cellLevelKey (kind:bxc:byc:mosType) is position-based.
 * When the user moves internal layers inside a cell, the bbox shifts and the
 * key changes — the device is treated as new, loses its instance name and any
 * W/L override. The user sees constant renames on routine edits.
 *
 * Solution: assign a stable UUID to every device at first detection and keep
 * the {uuid → record} map in localStorage. On re-extraction we recover the
 * UUID via the position fingerprint (current cellLevelKey). If the position
 * moves we also store the gateAnchor and bbox-centre keys seen historically
 * so we can still find the device after a small shift. Beyond a small shift
 * tolerance the device is considered a new entity and gets a fresh UUID.
 *
 * Storage layout (single key in localStorage):
 *   mmo-chip-device-registry: {
 *     v: 1,                    // schema version
 *     byUUID: {                // uuid → record (canonical)
 *       "<uuid>": DeviceRecord,
 *     },
 *     byFingerprint: {         // position-based fingerprint → uuid (lookup)
 *       "<fingerprint>": "<uuid>",
 *     },
 *     legacyOverrides?: {      // old preferences.analogOverrides, copied once
 *       "<cellTypeId>": { "<legacyKey>": { "<param>": <value> } }
 *     },
 *   }
 */

import { create } from "zustand";
import { uuid } from "../lib/uuid";
import type { DeviceKind } from "shared";

const REG_KEY = "mmo-chip-device-registry";
const SCHEMA_VERSION = 1;

/** Position-based fingerprint used to recover a UUID across re-extractions. */
export type Fingerprint = string;

export interface DeviceRecord {
  uuid: string;
  kind: DeviceKind;
  /** mosType for mos, bjtType for bjt — null for kinds without subtypes. */
  subType: string | null;
  /** Position-based fingerprint seen at the most recent match. */
  fingerprint: Fingerprint;
  /** History of fingerprints this device has been seen under. Useful when the
   *  position shifts and we want to migrate the lookup. */
  previousFingerprints?: Fingerprint[];
  /** User-assigned instance name. null/undefined = auto-generated. */
  instanceName: string | null;
  /** Per-device param overrides (W, L, AE, fingers, multiplier, R, ...). */
  overrides: Record<string, number>;
  /** First time we saw this device (ms since epoch). */
  createdAt: number;
  /** Last time we matched it (ms since epoch). */
  lastSeenAt: number;
  /** Soft-delete: device removed from extraction but kept for rename/counter. */
  deletedAt: number | null;
}

export interface DeviceRegistryData {
  v: number;
  byUUID: Record<string, DeviceRecord>;
  byFingerprint: Record<Fingerprint, string>;
  legacyOverrides?: Record<string, Record<string, Record<string, number>>>;
}

function emptyRegistry(): DeviceRegistryData {
  return { v: SCHEMA_VERSION, byUUID: {}, byFingerprint: {} };
}

function loadRaw(): DeviceRegistryData {
  if (typeof localStorage === "undefined") return emptyRegistry();
  try {
    const s = localStorage.getItem(REG_KEY);
    if (!s) return emptyRegistry();
    const parsed = JSON.parse(s) as DeviceRegistryData;
    if (!parsed || typeof parsed !== "object") return emptyRegistry();
    if (parsed.v !== SCHEMA_VERSION) {
      // Future: schema migration. For now, preserve byUUID across version
      // bumps (the data shape is forward-compatible) but ignore unknown
      // top-level fields.
      return { v: SCHEMA_VERSION, byUUID: parsed.byUUID ?? {}, byFingerprint: parsed.byFingerprint ?? {}, legacyOverrides: parsed.legacyOverrides };
    }
    return {
      v: SCHEMA_VERSION,
      byUUID: parsed.byUUID ?? {},
      byFingerprint: parsed.byFingerprint ?? {},
      legacyOverrides: parsed.legacyOverrides,
    };
  } catch {
    return emptyRegistry();
  }
}

function saveRaw(data: DeviceRegistryData): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(REG_KEY, JSON.stringify(data));
  } catch {
    /* quota or disabled — best-effort */
  }
}

/** Tolerance for fingerprint match. The fingerprint encodes (kind, subType,
 *  position). Two fingerprints match if they have the same kind/subType and
 *  the position differs by less than this many pixels in EITHER x or y.
 *  This absorbs small shifts from internal layer edits (a couple of pixels
 *  of nudge when the user redraws a shape) without confusing two distinct
 *  devices. Bump up to make matching more permissive; set to 0 to require
 *  exact match. */
const FUZZY_TOLERANCE_PX = 10; // 10px — small enough to avoid matching different fingers

/** Parse a fingerprint — find two consecutive numeric parts (bxc, byc)
 *  and extract the subType as everything else after `kind` except those
 *  two numbers. Handles formats:
 *    kind:bxc:byc           (3 parts)
 *    kind:bxc:byc:subType   (4 parts)
 *    kind:prefixB:bxc:byc   (4 parts, prefix in subType)
 *    kind:bxc:byc:suffixA   (4 parts, suffix in subType)
 *    kind:prefix:bxc:byc:suffix  (5+ parts)
 *  Returns null for < 3 parts or if no two consecutive numbers found. */
function parseFingerprint(fp: Fingerprint): {
  kind: string;
  subType: string;
  bxc: number;
  byc: number;
} | null {
  const parts = fp.split(":");
  if (parts.length < 3) return null;
  const kind = parts[0];
  // Find the FIRST occurrence of two consecutive numeric parts.
  // Everything between kind and those numbers (prefix) plus everything
  // after them (suffix) becomes the subType.
  for (let i = 1; i <= parts.length - 2; i++) {
    const bxc = Number(parts[i]);
    const byc = Number(parts[i + 1]);
    if (Number.isFinite(bxc) && Number.isFinite(byc)) {
      const prefix = parts.slice(1, i);
      const suffix = parts.slice(i + 2);
      const subType = [...prefix, ...suffix].join(":");
      return { kind, subType, bxc, byc };
    }
  }
  return null;
}

function fingerprintsMatch(a: Fingerprint, b: Fingerprint): boolean {
  if (a === b) return true;
  if (FUZZY_TOLERANCE_PX <= 0) return false;
  const pa = parseFingerprint(a);
  const pb = parseFingerprint(b);
  if (!pa || !pb) return false;
  if (pa.kind !== pb.kind) return false;
  if (pa.subType !== pb.subType) return false;
  // bxc/byc are Math.round(coord * 100), so multiply tolerance by 100
  return Math.abs(pa.bxc - pb.bxc) <= FUZZY_TOLERANCE_PX * 100
      && Math.abs(pa.byc - pb.byc) <= FUZZY_TOLERANCE_PX * 100;
}

/** Handle fingerprints that can't be parsed (e.g. per-instance format
 *  `${templateUuid}:${instCellId}` with only 2 colon-separated parts).
 *  We still do exact match by the byFingerprint key so existing records
 *  are found and resurrected.  If no match we create a proper persisted
 *  record (not ephemeral). */
function matchOpaqueByFingerprint(
  fingerprint: Fingerprint,
  data: DeviceRegistryData,
  now: number,
): { uuid: string; record: DeviceRecord; isNew: boolean } {
  const existingUuid = data.byFingerprint[fingerprint];
  if (existingUuid) {
    const rec = data.byUUID[existingUuid];
    if (rec) {
      rec.lastSeenAt = now;
      rec.deletedAt = null;
      saveRaw(data);
      return { uuid: rec.uuid, record: rec, isNew: false };
    }
  }
  const newUuid = uuid();
  const rec: DeviceRecord = {
    uuid: newUuid,
    kind: "unknown" as DeviceKind,
    subType: null,
    fingerprint,
    instanceName: null,
    overrides: {},
    createdAt: now,
    lastSeenAt: now,
    deletedAt: null,
  };
  data.byUUID[newUuid] = rec;
  data.byFingerprint[fingerprint] = newUuid;
  saveRaw(data);
  return { uuid: newUuid, record: rec, isNew: true };
}

/** Look up or create a UUID for a freshly extracted device. */
export function matchOrCreateDevice(
  fingerprint: Fingerprint,
  legacyOverride?: Record<string, number>,
): { uuid: string; record: DeviceRecord; isNew: boolean } {
  const parsed = parseFingerprint(fingerprint);
  const data = loadRaw();
  const now = Date.now();

  if (!parsed) {
    // Malformed or non-standard fingerprint (e.g. per-instance format
    // `${templateUuid}:${instCellId}` which has only 2 colon-separated
    // parts and no numeric position).  Exact match by byFingerprint key
    // still works; we just can't do fuzzy matching, kind/subType checks
    // or legacy override merging without parsed components.
    return matchOpaqueByFingerprint(fingerprint, data, now);
  }
  const { kind, subType } = parsed;

  // 1. Exact fingerprint match — also resurrects soft-deleted records
  const existingUuid = data.byFingerprint[fingerprint];
  if (existingUuid) {
    const rec = data.byUUID[existingUuid];
    if (rec) {
      rec.lastSeenAt = now;
      rec.deletedAt = null;  // resurrect if it was soft-deleted
      // Auto-heal stale subType from old parseFingerprint
      if (parsed && rec.subType !== (parsed.subType || null)) {
        rec.subType = parsed.subType || null;
      }
      if (legacyOverride && Object.keys(legacyOverride).length > 0) {
        for (const [k, v] of Object.entries(legacyOverride)) {
          if (rec.overrides[k] == null) {
            rec.overrides[k] = v;
          }
        }
      }
      saveRaw(data);
      return { uuid: rec.uuid, record: rec, isNew: false };
    }
  }

  // 2. Fuzzy match against all known live records of the same kind.
  if (FUZZY_TOLERANCE_PX > 0) {
    for (const rec of Object.values(data.byUUID)) {
      if (rec.deletedAt) continue;
      if (rec.kind !== kind) continue;
      // Re-parse the record's fingerprint for subType — the stored `rec.subType`
      // may be stale (null) on records created before the parseFingerprint fix.
      const recParsed = parseFingerprint(rec.fingerprint);
      if (!recParsed || recParsed.subType !== subType) continue;
      if (fingerprintsMatch(rec.fingerprint, fingerprint)) {
        // Re-attach: old fingerprint may now point to a moved-away device.
        // Keep the old entry in byFingerprint for re-discovery if it comes back.
        rec.previousFingerprints = [...(rec.previousFingerprints ?? []), rec.fingerprint];
        rec.fingerprint = fingerprint;
        // Auto-heal stale subType from old parseFingerprint
        if (rec.subType !== (recParsed.subType || null)) {
          rec.subType = recParsed.subType || null;
        }
        data.byFingerprint[fingerprint] = rec.uuid;
        rec.lastSeenAt = now;
        if (legacyOverride && Object.keys(legacyOverride).length > 0) {
          for (const [k, v] of Object.entries(legacyOverride)) {
            if (rec.overrides[k] == null) {
              rec.overrides[k] = v;
            }
          }
        }
        saveRaw(data);
        return { uuid: rec.uuid, record: rec, isNew: false };
      }
    }
  }

  // 3. No match → brand-new device, generate UUID.
  const newUuid = uuid();
  const rec: DeviceRecord = {
    uuid: newUuid,
    kind: kind as DeviceKind,
    subType: subType || null,
    fingerprint,
    instanceName: null,
    overrides: legacyOverride ? { ...legacyOverride } : {},
    createdAt: now,
    lastSeenAt: now,
    deletedAt: null,
  };
  data.byUUID[newUuid] = rec;
  data.byFingerprint[fingerprint] = newUuid;
  saveRaw(data);
  return { uuid: newUuid, record: rec, isNew: true };
}

/** Mark a device as deleted (soft). Its record stays so that:
 *  - the auto-name counter doesn't re-use the name for another device
 *  - manual rename into a freed name still works
 *  - if the device re-appears (re-extract picks it up again) we can resurrect it */
export function markDeviceDeleted(uuid: string): void {
  const data = loadRaw();
  const rec = data.byUUID[uuid];
  if (!rec) return;
  rec.deletedAt = Date.now();
  saveRaw(data);
  bumpRegistryVersion();
}

/** Sweep: mark all devices not in `liveFingerprints` as deleted.
 *  `liveUuidsAdditional` is a set of UUIDs to explicitly keep alive,
 *  used for per-instance records whose fingerprint differs from the
 *  cell-level fingerprint (and is not available in the assign-scan). */
export function reconcileWithLiveDevices(
  liveFingerprints: Set<Fingerprint>,
  liveUuidsAdditional?: Set<string>,
): string[] {
  const data = loadRaw();
  const now = Date.now();
  const resurrected: string[] = [];
  // Build reverse map: live fingerprint → uuid
  const liveUuids = new Set<string>();
  for (const fp of liveFingerprints) {
    const u = data.byFingerprint[fp];
    if (u) liveUuids.add(u);
  }
  if (liveUuidsAdditional) {
    for (const u of liveUuidsAdditional) liveUuids.add(u);
  }
  // 1) Delete records not in liveUuids
  for (const rec of Object.values(data.byUUID)) {
    if (rec.deletedAt) continue;
    if (!liveUuids.has(rec.uuid)) {
      rec.deletedAt = now;
    }
  }
  // 2) Resurrect: a deleted record whose fingerprint is back in live set
  for (const fp of liveFingerprints) {
    const u = data.byFingerprint[fp];
    if (!u) continue;
    const rec = data.byUUID[u];
    if (rec?.deletedAt) {
      rec.deletedAt = null;
      rec.lastSeenAt = now;
      resurrected.push(rec.uuid);
    }
  }
  saveRaw(data);
  return resurrected;
}

export function getDeviceRecord(uuid: string): DeviceRecord | null {
  return loadRaw().byUUID[uuid] ?? null;
}

export function setDeviceInstanceName(uuid: string, name: string | null): void {
  const data = loadRaw();
  const rec = data.byUUID[uuid];
  if (!rec) return;
  rec.instanceName = name;
  saveRaw(data);
  bumpRegistryVersion();
}

export function setDeviceOverride(uuid: string, param: string, value: number): void {
  const data = loadRaw();
  const rec = data.byUUID[uuid];
  if (!rec) return;
  rec.overrides[param] = value;
  saveRaw(data);
  bumpRegistryVersion();
}

export function clearDeviceOverride(uuid: string, param: string): void {
  const data = loadRaw();
  const rec = data.byUUID[uuid];
  if (!rec) return;
  delete rec.overrides[param];
  saveRaw(data);
  bumpRegistryVersion();
}

/** Get all live (non-deleted) records. Used by stable-name counter. */
export function getLiveRecords(): DeviceRecord[] {
  return Object.values(loadRaw().byUUID).filter((r) => !r.deletedAt);
}

/** Zustand store — subscribe in React components for reactive re-renders
 *  on any registry write (override, rename, clear). */
export const useRegistryVersion = create<{ v: number }>(() => ({ v: 0 }));

/** Module-level version counter — bumped on any write. Hooks can depend
 *  on `getRegistryVersion()` to re-render when the registry changes. */
let _registryVersion = 0;
function bumpRegistryVersion(): void {
  _registryVersion++;
  useRegistryVersion.setState({ v: _registryVersion });
}
export function getRegistryVersion(): number { return _registryVersion; }

/** Drop all stale fingerprints (those that aren't live and don't belong to
 *  any record). Keeps the byFingerprint map from growing unbounded across
 *  many edits. */
export function compactFingerprints(): void {
  const data = loadRaw();
  const liveFps = new Set<string>();
  for (const rec of Object.values(data.byUUID)) {
    liveFps.add(rec.fingerprint);
    rec.previousFingerprints?.forEach((fp) => liveFps.add(fp));
  }
  for (const k of Object.keys(data.byFingerprint)) {
    if (!liveFps.has(k)) delete data.byFingerprint[k];
  }
  saveRaw(data);
}

/** Storage of legacy overrides from preferences.analogOverrides, migrated
 *  once on first pipeline run after the upgrade. */
export function setLegacyOverrides(
  overrides: Record<string, Record<string, Record<string, number>>>,
): void {
  const data = loadRaw();
  data.legacyOverrides = overrides;
  saveRaw(data);
}

export function getLegacyOverrides(): Record<string, Record<string, Record<string, number>>> | null {
  return loadRaw().legacyOverrides ?? null;
}

export function clearLegacyOverrides(): void {
  const data = loadRaw();
  delete data.legacyOverrides;
  saveRaw(data);
}

/** Migrate a device record from one fingerprint to another. Preserves UUID
 *  and all record data. Used for one-time migration of old opaque instance
 *  fingerprints (${templateUuid}:${instCell.id}) to the new parseable format.
 *  Returns true if the old fingerprint was found and migrated. */
export function migrateFingerprint(
  oldFingerprint: Fingerprint,
  newFingerprint: Fingerprint,
): boolean {
  const data = loadRaw();
  const uuid = data.byFingerprint[oldFingerprint];
  if (!uuid || !data.byUUID[uuid]) return false;
  const rec = data.byUUID[uuid];
  rec.previousFingerprints = [...(rec.previousFingerprints ?? []), rec.fingerprint];
  rec.fingerprint = newFingerprint;
  data.byFingerprint[newFingerprint] = uuid;
  delete data.byFingerprint[oldFingerprint];
  // Old per-instance records have kind="unknown" and subType=null
  // (created via matchOpaqueByFingerprint). Update them so the
  // fuzzy match in matchOrCreateDevice can find them.
  const parsed = parseFingerprint(newFingerprint);
  if (parsed) {
    rec.kind = parsed.kind as DeviceKind;
    rec.subType = parsed.subType || null;
  }
  saveRaw(data);
  bumpRegistryVersion();
  return true;
}

/** Get a device record by its fingerprint. Returns null if not found. */
export function getDeviceRecordByFingerprint(
  fingerprint: Fingerprint,
): DeviceRecord | null {
  const data = loadRaw();
  const uuid = data.byFingerprint[fingerprint];
  return uuid ? (data.byUUID[uuid] ?? null) : null;
}
