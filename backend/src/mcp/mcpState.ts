import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MCP_AUTHOR_ID,
  type DieAnnotations,
  type McpCollection,
  type McpHistoryItem,
  type McpValueSection,
  type McpWriteMode
} from "shared";
import { readAnnotations, readDieRecord, withDieLock, writeAnnotations } from "../store.js";
import { resolveProjectDir } from "../projectLayout.js";

/**
 * Per-die MCP state, stored next to annotations.json as `mcp.json`:
 * the write mode chosen in the GUI, the ids of the markup the MCP client
 * created (what "edit" mode may touch), and the MCP-only undo / redo stacks.
 *
 * Every MCP write goes through `applyMcpEdit`, which records whole-item
 * before/after snapshots. Undo / redo replay them, but only while each item
 * still matches the state the MCP change left it in — if a human edited it
 * in between, the step is refused rather than clobbering their edit.
 */

export { MCP_AUTHOR_ID };
const MAX_HISTORY = 200;

/** A list section, or a whole-value section (then `id` is the section name). */
export type McpTarget = McpCollection | McpValueSection;

export const MCP_VALUE_SECTIONS: McpValueSection[] = ["analogLayers", "umPerPx", "mlConfig", "icPackage"];

export function isValueSection(section: string): section is McpValueSection {
  return (MCP_VALUE_SECTIONS as string[]).includes(section);
}

export interface McpChange {
  collection: McpTarget;
  id: string;
  /** Item before the change; null = did not exist. */
  before: unknown | null;
  /** Item after the change; null = removed. */
  after: unknown | null;
}

export interface McpHistoryEntry extends McpHistoryItem {
  changes: McpChange[];
}

export interface McpOwned {
  comments: string[];
  floorplanRegions: string[];
  rulers: string[];
  /** Nets the MCP client created (may be renamed / deleted whole). */
  nets: string[];
  /** Vias (point_via annotations) the MCP client placed. */
  annotations: string[];
  /** Comment reply ids (replies live inside their comment). */
  replies: string[];
  /** Net node / edge ids the MCP client added — also inside human nets. */
  netNodes: string[];
  netEdges: string[];
}

export interface McpDieState {
  version: 1;
  mode: McpWriteMode;
  wires: boolean;
  full: boolean;
  owned: McpOwned;
  undo: McpHistoryEntry[];
  redo: McpHistoryEntry[];
}

export class McpEditError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function emptyState(): McpDieState {
  return {
    version: 1,
    mode: "off",
    wires: false,
    full: false,
    owned: {
      comments: [],
      floorplanRegions: [],
      rulers: [],
      nets: [],
      annotations: [],
      replies: [],
      netNodes: [],
      netEdges: []
    },
    undo: [],
    redo: []
  };
}

async function statePath(dataRoot: string, dieId: string): Promise<string> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  return path.join(dir, "mcp.json");
}

export async function readMcpState(dataRoot: string, dieId: string): Promise<McpDieState> {
  try {
    const raw = JSON.parse(await fs.readFile(await statePath(dataRoot, dieId), "utf8")) as Partial<McpDieState>;
    const base = emptyState();
    return {
      ...base,
      ...raw,
      owned: { ...base.owned, ...raw.owned }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

async function writeMcpState(dataRoot: string, dieId: string, state: McpDieState): Promise<void> {
  const file = await statePath(dataRoot, dieId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function setMcpSettings(
  dataRoot: string,
  dieId: string,
  settings: { mode?: McpWriteMode; wires?: boolean; full?: boolean }
): Promise<void> {
  await readDieRecord(dataRoot, dieId);
  await withDieLock(dieId, async () => {
    const state = await readMcpState(dataRoot, dieId);
    if (settings.mode !== undefined) state.mode = settings.mode;
    if (settings.wires !== undefined) state.wires = settings.wires;
    if (settings.full !== undefined) state.full = settings.full;
    await writeMcpState(dataRoot, dieId, state);
  });
}

export function historyItem(entry: McpHistoryEntry): McpHistoryItem {
  const { changes: _changes, ...item } = entry;
  return item;
}

// ─── Applying changes ──────────────────────────────────────────────

function collectionOf(annotations: DieAnnotations, collection: McpCollection): { id: string }[] {
  return (annotations[collection] ?? []) as { id: string }[];
}

export function findItem<T>(annotations: DieAnnotations, collection: McpCollection, id: string): T | null {
  return (collectionOf(annotations, collection).find((item) => item.id === id) as T | undefined) ?? null;
}

/** Current value of a change target: a list item by id, or a whole section. */
function getTarget(annotations: DieAnnotations, collection: McpTarget, id: string): unknown | null {
  if (isValueSection(collection)) return annotations[collection] ?? null;
  return findItem(annotations, collection, id);
}

function setTarget(annotations: DieAnnotations, collection: McpTarget, id: string, value: unknown | null): void {
  if (isValueSection(collection)) {
    const record = annotations as unknown as Record<string, unknown>;
    if (value === null) delete record[collection];
    else record[collection] = value;
    return;
  }
  setItem(annotations, collection, id, value);
}

function setItem(annotations: DieAnnotations, collection: McpCollection, id: string, item: unknown | null): void {
  const list = collectionOf(annotations, collection);
  const index = list.findIndex((existing) => existing.id === id);
  let next: { id: string }[];
  if (item === null) next = list.filter((existing) => existing.id !== id);
  else if (index === -1) next = [...list, item as { id: string }];
  else next = list.map((existing, i) => (i === index ? (item as { id: string }) : existing));
  (annotations as unknown as Record<string, unknown>)[collection] = next;
}

/** Key-order-insensitive JSON equality (a GUI re-save may reorder keys). */
export function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export interface McpEdit {
  tool: string;
  summary: string;
  /** New state of each touched item (null = delete). `before` is filled in. */
  items: { collection: McpTarget; id: string; after: unknown | null }[];
  /** Ids to add to the owned set. */
  own?: Partial<Record<keyof McpOwned, string[]>>;
  /** Value returned to the MCP client alongside the new revision. */
  result?: Record<string, unknown>;
}

/**
 * Run an MCP write: `build` sees the current annotations + MCP state (under
 * the die lock) and returns the items to change, or throws McpEditError.
 * The change is applied, recorded on the MCP undo stack and the redo stack
 * is cleared.
 */
export async function applyMcpEdit(
  dataRoot: string,
  dieId: string,
  clientName: string | null,
  build: (annotations: DieAnnotations, state: McpDieState) => McpEdit
): Promise<{ rev: number; result?: Record<string, unknown> }> {
  await readDieRecord(dataRoot, dieId);
  return withDieLock(dieId, async () => {
    const annotations = await readAnnotations(dataRoot, dieId);
    const state = await readMcpState(dataRoot, dieId);
    const edit = build(annotations, state);
    // An item touched twice in one edit (a batch) is one change: its final state.
    const latest = new Map<string, McpEdit["items"][number]>();
    for (const item of edit.items) latest.set(`${item.collection}\u0000${item.id}`, item);
    const changes: McpChange[] = [...latest.values()].map((item) => ({
      collection: item.collection,
      id: item.id,
      before: getTarget(annotations, item.collection, item.id),
      after: item.after
    }));
    for (const change of changes) setTarget(annotations, change.collection, change.id, change.after);
    const rev = await writeAnnotations(dataRoot, dieId, annotations);

    for (const [key, ids] of Object.entries(edit.own ?? {}) as [keyof McpOwned, string[]][]) {
      state.owned[key] = [...new Set([...state.owned[key], ...ids])];
    }
    state.undo = [
      ...state.undo,
      {
        id: randomUUID(),
        at: new Date().toISOString(),
        tool: edit.tool,
        summary: edit.summary,
        clientName,
        changes
      }
    ].slice(-MAX_HISTORY);
    state.redo = [];
    await writeMcpState(dataRoot, dieId, state);
    return { rev, result: edit.result };
  });
}

/**
 * Undo (direction "undo") or redo the newest entry of the respective stack.
 * Refused with 409 when an item no longer matches what the step expects.
 */
export async function stepMcpHistory(
  dataRoot: string,
  dieId: string,
  direction: "undo" | "redo"
): Promise<{ rev: number; entry: McpHistoryItem }> {
  await readDieRecord(dataRoot, dieId);
  return withDieLock(dieId, async () => {
    const annotations = await readAnnotations(dataRoot, dieId);
    const state = await readMcpState(dataRoot, dieId);
    const from = direction === "undo" ? state.undo : state.redo;
    const entry = from[from.length - 1];
    if (!entry) throw new McpEditError(`Nothing to ${direction}`, 409);

    // Undo walks the changes backwards and restores `before`; redo forwards.
    const steps =
      direction === "undo"
        ? [...entry.changes].reverse().map((c) => ({ ...c, expect: c.after, target: c.before }))
        : entry.changes.map((c) => ({ ...c, expect: c.before, target: c.after }));
    for (const step of steps) {
      const current = getTarget(annotations, step.collection, step.id);
      if (!sameJson(current, step.expect)) {
        throw new McpEditError(
          `Cannot ${direction} "${entry.summary}": ${describe(step.collection)} ${step.id} was changed outside MCP since.`,
          409
        );
      }
    }
    for (const step of steps) setTarget(annotations, step.collection, step.id, step.target);
    const rev = await writeAnnotations(dataRoot, dieId, annotations);

    if (direction === "undo") {
      state.undo = state.undo.slice(0, -1);
      state.redo = [...state.redo, entry];
    } else {
      state.redo = state.redo.slice(0, -1);
      state.undo = [...state.undo, entry];
    }
    await writeMcpState(dataRoot, dieId, state);
    return { rev, entry: historyItem(entry) };
  });
}

export function describe(collection: McpTarget): string {
  return {
    comments: "comment",
    floorplanRegions: "floorplan region",
    rulers: "ruler",
    nets: "net",
    annotations: "via / ML annotation",
    cellTypes: "cell type",
    cells: "cell",
    grids: "grid",
    pins: "I/O pin",
    rois: "ROI",
    ignores: "ignore region",
    guides: "guide",
    analogLayers: "analog layers section",
    umPerPx: "scale (umPerPx)",
    mlConfig: "ML config",
    icPackage: "IC package section"
  }[collection];
}
