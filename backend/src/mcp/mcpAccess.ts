import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { McpAccessState, McpDieAccess } from "shared";
import { resolveProjectDir } from "../projectLayout.js";
import { listDieRecords } from "../store.js";

/**
 * Which dies MCP clients may use, stored as `<dataRoot>/mcp-access.json`.
 * The MCP endpoint serves every die, but the first call on a die without an
 * entry records it as "pending" and the call is held until a user approves
 * or denies it in the GUI (or the wait times out). Decisions stick until a
 * user changes them.
 */

interface AccessFile {
  version: 1;
  dies: Record<string, McpDieAccess>;
}

const FILE_NAME = "mcp-access.json";

/** Serialises read-modify-write per data root. */
const queues = new Map<string, Promise<unknown>>();
/** "change" (dataRoot, dieId, access) after every write. */
const changes = new EventEmitter();
changes.setMaxListeners(0);

function locked<T>(dataRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(dataRoot) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(dataRoot, next.catch(() => undefined));
  return next;
}

async function readFile(dataRoot: string): Promise<AccessFile> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dataRoot, FILE_NAME), "utf8")) as Partial<AccessFile>;
    return { version: 1, dies: raw.dies ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 1, dies: await legacyApprovals(dataRoot) };
  }
}

/**
 * Before the global endpoint, each die had its own `/mcp/<dieId>` URL. Dies
 * whose MCP settings were touched or that MCP wrote to (they have an
 * `mcp.json`) count as already accessed, so they stay usable without a prompt.
 */
async function legacyApprovals(dataRoot: string): Promise<Record<string, McpDieAccess>> {
  const dies: Record<string, McpDieAccess> = {};
  const at = new Date().toISOString();
  for (const record of await listDieRecords(dataRoot).catch(() => [])) {
    try {
      const { dir } = await resolveProjectDir(dataRoot, record.id);
      await fs.access(path.join(dir, "mcp.json"));
      dies[record.id] = { state: "approved", at, clientName: null };
    } catch {
      // never used over MCP
    }
  }
  return dies;
}

async function writeFile(dataRoot: string, file: AccessFile): Promise<void> {
  const target = path.join(dataRoot, FILE_NAME);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await fs.rename(temp, target);
}

export async function listDieAccess(dataRoot: string): Promise<Record<string, McpDieAccess>> {
  return (await locked(dataRoot, () => readFile(dataRoot))).dies;
}

export async function getDieAccess(dataRoot: string, dieId: string): Promise<McpDieAccess | null> {
  return (await listDieAccess(dataRoot))[dieId] ?? null;
}

/**
 * The access entry an MCP call on `dieId` runs under. A die without one
 * becomes "pending" (`created` = true, so the GUI can be told).
 */
export function requestDieAccess(
  dataRoot: string,
  dieId: string,
  clientName: string | null
): Promise<{ access: McpDieAccess; created: boolean }> {
  return locked(dataRoot, async () => {
    const file = await readFile(dataRoot);
    const existing = file.dies[dieId];
    if (existing) return { access: existing, created: false };
    const access: McpDieAccess = { state: "pending", at: new Date().toISOString(), clientName };
    file.dies[dieId] = access;
    await writeFile(dataRoot, file);
    changes.emit("change", dataRoot, dieId, access);
    return { access, created: true };
  });
}

/** A user's decision (GUI). Keeps the name of the client that asked. */
export function setDieAccess(
  dataRoot: string,
  dieId: string,
  state: Exclude<McpAccessState, "pending">
): Promise<McpDieAccess> {
  return locked(dataRoot, async () => {
    const file = await readFile(dataRoot);
    const access: McpDieAccess = {
      state,
      at: new Date().toISOString(),
      clientName: file.dies[dieId]?.clientName ?? null
    };
    file.dies[dieId] = access;
    await writeFile(dataRoot, file);
    changes.emit("change", dataRoot, dieId, access);
    return access;
  });
}

/** Resolves with the die's access once it is no longer pending, or after `ms`. */
export function waitForDecision(dataRoot: string, dieId: string, ms: number): Promise<McpDieAccess | null> {
  return new Promise((resolve) => {
    const onChange = (root: string, id: string, access: McpDieAccess) => {
      if (root !== dataRoot || id !== dieId || access.state === "pending") return;
      finish(access);
    };
    const timer = setTimeout(() => finish(null), ms);
    const finish = (access: McpDieAccess | null) => {
      clearTimeout(timer);
      changes.off("change", onChange);
      resolve(access);
    };
    changes.on("change", onChange);
    // A decision made between the caller's last read and subscribing.
    void getDieAccess(dataRoot, dieId).then((access) => {
      if (access && access.state !== "pending") finish(access);
    }, () => undefined);
  });
}
