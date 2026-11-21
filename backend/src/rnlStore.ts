import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { resolveProjectDir } from "./projectLayout.js";

/** RNL drawings live beside the project, one file per module. */
export const RNL_DIR = "rnl";
/** How many versions one module keeps; the schematic baseline is never dropped. */
export const RNL_HISTORY_LIMIT = 100;

export type RnlFormat = "spice" | "spectre";
export type RnlAuthor = "schematic" | "agent" | "user" | "saved" | "system";

/** One saved version of a module's drawing. The text is a separate file. */
export interface RnlRevisionMeta {
  id: string;
  at: string;
  author: RnlAuthor;
  note: string;
  format: RnlFormat;
  bytes: number;
  lines: number;
  /** Lines this version added / removed against the version it was based on. */
  added: number;
  removed: number;
  baseRevisionId: string | null;
  /** Set when the user rolled a version back; the new version names the old one. */
  restores: string | null;
  sourceHash: string | null;
  /** True when the text is byte-identical to the version it was based on. */
  unchanged: boolean;
}

/**
 * What the RNL tab needs to say about the saved file. Persisted as
 * `<project>/rnl/<module>.state.json`; when an old drawing predates the
 * history, a synthetic state is returned instead (edited=true: the file may
 * have been changed by hand or an agent, so a schematic export must confirm).
 */
export interface RnlState {
  version: 1;
  moduleName: string;
  format: RnlFormat;
  /** The drawing is a fixed snapshot: schematic re-exports are refused. */
  frozen: boolean;
  /** Fingerprint of the analog netlist at the last schematic export. */
  sourceHash: string | null;
  exportedAt: string | null;
  baselineRevisionId: string | null;
  latestRevisionId: string | null;
  latestAuthor: RnlAuthor | null;
  latestAt: string | null;
  updatedAt: string;
  revisionCount: number;
  /** The latest version is not the schematic baseline. */
  edited: boolean;
}

export interface RnlStatus {
  exists: boolean;
  state: RnlState;
  /** Newest first. */
  revisions: RnlRevisionMeta[];
}

export interface RnlDiffLine {
  type: "context" | "add" | "remove";
  text: string;
}

export interface RnlDiff {
  added: number;
  removed: number;
  lines: RnlDiffLine[];
}

export interface RnlRevisionDetail {
  revision: RnlRevisionMeta;
  text: string;
  diff: RnlDiff;
}

export interface RnlWriteOptions {
  author?: RnlAuthor;
  note?: string;
  format?: RnlFormat;
  sourceHash?: string | null;
  /** Record a version even when the text did not change (a schematic export). */
  forceRevision?: boolean;
  /** The version this text came from, for a rollback. */
  restores?: string | null;
}

export interface RnlWriteResult {
  file: string;
  text: string;
  /** Null when the write was a no-op (identical text, no forced version). */
  revision: RnlRevisionMeta | null;
  state: RnlState;
}

/** A module name safe as one file name: no separators, no traversal. */
export function rnlModuleName(raw: unknown, fallback = "schematic"): string {
  const cleaned = String(raw ?? "")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function rnlFile(dir: string, moduleName: string): string {
  return path.join(dir, RNL_DIR, `${rnlModuleName(moduleName)}.rnl`);
}

function stateFile(dir: string, moduleName: string): string {
  return path.join(dir, RNL_DIR, `${rnlModuleName(moduleName)}.state.json`);
}

function historyDir(dir: string, moduleName: string): string {
  return path.join(dir, RNL_DIR, "history", rnlModuleName(moduleName));
}

function historyIndex(dir: string, moduleName: string): string {
  return path.join(historyDir(dir, moduleName), "index.json");
}

function revisionFile(dir: string, moduleName: string, revisionId: string): string {
  return path.join(historyDir(dir, moduleName), `${revisionId}.rnl`);
}

/** A revision id is a file name: no separators, no traversal. */
function safeRevisionId(raw: unknown): string | null {
  const id = String(raw ?? "");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(id) ? id : null;
}

function newRevisionId(): string {
  return `rev-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/** Split text the way every diff and line count in this file does. */
function linesOf(text: string): string[] {
  return text.split(/\r\n?|\n/);
}

export function rnlFormatOf(text: string): RnlFormat {
  return /^\s*simulator\s+lang\s*=\s*spectre/m.test(text) ? "spectre" : "spice";
}

function defaultNote(author: RnlAuthor, format: RnlFormat): string {
  switch (author) {
    case "schematic":
      return `exported from the schematic (${format})`;
    case "agent":
      return "edited through MCP";
    case "user":
      return "saved in the RNL tab";
    case "saved":
      return "existing RNL drawing";
    default:
      return "updated";
  }
}

/**
 * Line diff for the history: a longest-common-subsequence walk after the
 * common prefix and suffix are removed, so an edit in a long netlist stays
 * cheap. Only the viewer reads `lines`; the counts go into the index.
 */
export function diffRnlLines(before: string, after: string): RnlDiff {
  const a = linesOf(before);
  const b = linesOf(after);
  const empty: RnlDiff = { added: 0, removed: 0, lines: [] };
  if (!before && !after) return empty;

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const lines: RnlDiffLine[] = [];
  for (let index = 0; index < start; index += 1)
    lines.push({ type: "context", text: a[index] });

  if (midA.length === 0) {
    for (const text of midB) lines.push({ type: "add", text });
  } else if (midB.length === 0) {
    for (const text of midA) lines.push({ type: "remove", text });
  } else if (midA.length * midB.length > 4_000_000) {
    // Pathological input: do not allocate a huge table for the history.
    for (const text of midA) lines.push({ type: "remove", text });
    for (const text of midB) lines.push({ type: "add", text });
  } else {
    const width = midB.length + 1;
    const table = new Uint32Array((midA.length + 1) * width);
    for (let i = 1; i <= midA.length; i += 1) {
      for (let j = 1; j <= midB.length; j += 1) {
        table[i * width + j] =
          midA[i - 1] === midB[j - 1]
            ? table[(i - 1) * width + (j - 1)] + 1
            : Math.max(table[(i - 1) * width + j], table[i * width + (j - 1)]);
      }
    }
    const reversed: RnlDiffLine[] = [];
    let i = midA.length;
    let j = midB.length;
    while (i > 0 && j > 0) {
      if (midA[i - 1] === midB[j - 1]) {
        reversed.push({ type: "context", text: midA[i - 1] });
        i -= 1;
        j -= 1;
      } else if (table[(i - 1) * width + j] > table[i * width + (j - 1)]) {
        reversed.push({ type: "remove", text: midA[i - 1] });
        i -= 1;
      } else {
        reversed.push({ type: "add", text: midB[j - 1] });
        j -= 1;
      }
    }
    while (i > 0) reversed.push({ type: "remove", text: midA[(i -= 1)] });
    while (j > 0) reversed.push({ type: "add", text: midB[(j -= 1)] });
    lines.push(...reversed.reverse());
  }

  for (let index = endA; index < a.length; index += 1)
    lines.push({ type: "context", text: a[index] });

  return {
    added: lines.reduce((sum, line) => sum + (line.type === "add" ? 1 : 0), 0),
    removed: lines.reduce((sum, line) => sum + (line.type === "remove" ? 1 : 0), 0),
    lines,
  };
}

/** Whether every `(` of a record has its `)`. */
function balanced(record: string): boolean {
  let depth = 0;
  for (const char of record) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
  }
  return depth === 0;
}

/** A line that begins a new record rather than continuing the one before. */
const RECORD_START = /^[#&$%]|^@[A-Z][A-Z0-9-]*(?=[(\s;])/;

/** `#R1` alone: the exporter puts the record's keywords on the next line. */
const NAME_ONLY = /^#[^\s;]+$/;

function terminate(out: string[]): void {
  const last = out.length - 1;
  if (last < 0) return;
  const body = out[last].replace(/^\s*\*/, "").trimEnd();
  if (body && !/[;{}]$/.test(body)) out[last] = `${out[last].trimEnd()};`;
}

/**
 * analog-canvas wraps long RNL records (a `@TEXT` note, for one) onto the
 * next comment line. The RNL parser reads one record per line, so the saved
 * file would not build in the viewer. Join those continuations and close a
 * record the exporter left without its `;`. Everything outside an `@RNL`
 * comment block is left byte for byte as it was.
 */
export function normalizeRnlText(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split(/\r\n?|\n/)) {
    const comment = line.match(/^(\s*)\*(.*)$/);
    if (!comment) {
      inBlock = false;
      out.push(line);
      continue;
    }
    const trimmed = comment[2].trim();
    if (!inBlock) {
      out.push(line);
      if (/^@RNL\b/.test(trimmed) && trimmed.endsWith("{")) inBlock = true;
      continue;
    }
    if (trimmed === "}") {
      terminate(out);
      inBlock = false;
      out.push(line);
      continue;
    }
    const last = out.length - 1;
    const prev = last >= 0 ? out[last].replace(/^\s*\*/, "").trim() : "";
    if (last >= 0 && prev && !/[;{}]$/.test(prev)) {
      const continues =
        NAME_ONLY.test(prev) || !balanced(prev) || !RECORD_START.test(trimmed);
      if (continues) {
        const joiner = out[last].trimEnd().endsWith("(") ? "" : " ";
        out[last] = `${out[last].trimEnd()}${joiner}${trimmed}`;
        continue;
      }
      out[last] = `${out[last].trimEnd()};`;
    }
    out.push(line);
  }
  return out.join(eol);
}

// ── Storage primitives ───────────────────────────────────────────

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeText(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, text, "utf8");
  await fs.rename(temp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Read-modify-write of one module's history is serialised. */
const queues = new Map<string, Promise<unknown>>();

function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(key, next.catch(() => undefined));
  return next;
}

async function readIndex(dir: string, moduleName: string): Promise<RnlRevisionMeta[]> {
  const parsed = await readJson<RnlRevisionMeta[]>(historyIndex(dir, moduleName));
  return Array.isArray(parsed)
    ? parsed.filter(
        (entry) =>
          entry &&
          typeof entry.id === "string" &&
          typeof entry.at === "string" &&
          typeof entry.author === "string",
      )
    : [];
}

function baseState(moduleName: string, format: RnlFormat): RnlState {
  return {
    version: 1,
    moduleName,
    format,
    frozen: false,
    sourceHash: null,
    exportedAt: null,
    baselineRevisionId: null,
    latestRevisionId: null,
    latestAuthor: null,
    latestAt: null,
    updatedAt: "",
    revisionCount: 0,
    edited: false,
  };
}

function stateFromIndex(
  moduleName: string,
  revisions: RnlRevisionMeta[],
  frozen: boolean,
  format?: RnlFormat,
): RnlState {
  const latest = revisions[revisions.length - 1] ?? null;
  // Only a schematic export is a baseline. An agent-created drawing has none,
  // so a later export still asks before replacing it.
  const baseline =
    [...revisions].reverse().find((entry) => entry.author === "schematic") ?? null;
  return {
    version: 1,
    moduleName,
    format: format ?? latest?.format ?? "spice",
    frozen,
    sourceHash: latest?.sourceHash ?? null,
    exportedAt:
      [...revisions].reverse().find((entry) => entry.author === "schematic")?.at ?? null,
    baselineRevisionId: baseline?.id ?? null,
    latestRevisionId: latest?.id ?? null,
    latestAuthor: latest?.author ?? null,
    latestAt: latest?.at ?? null,
    updatedAt: latest?.at ?? "",
    revisionCount: revisions.length,
    edited: latest ? latest.id !== (baseline?.id ?? null) : false,
  };
}

// ── Public reads ─────────────────────────────────────────────────

export async function readRnl(
  dataRoot: string,
  dieId: string,
  moduleName: string,
): Promise<{ text: string; path: string } | null> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const file = rnlFile(dir, moduleName);
  const raw = await readText(file);
  if (raw === null) return null;
  return { text: normalizeRnlText(raw), path: file };
}

export async function readRnlStatus(
  dataRoot: string,
  dieId: string,
  moduleName: string,
): Promise<RnlStatus> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const name = rnlModuleName(moduleName);
  const raw = await readText(rnlFile(dir, name));
  const text = raw === null ? null : normalizeRnlText(raw);
  const saved = await readJson<RnlState>(stateFile(dir, name));
  const revisions = await readIndex(dir, name);

  if (text === null) {
    return {
      exists: false,
      state: saved ?? stateFromIndex(name, revisions, false),
      revisions: [...revisions].reverse(),
    };
  }
  if (revisions.length === 0) {
    // An old file with no history: it may have been edited by hand or an
    // agent, so the tab says so and a schematic export asks first.
    return {
      exists: true,
      state: {
        ...baseState(name, rnlFormatOf(text)),
        edited: true,
        frozen: saved?.frozen ?? false,
      },
      revisions: [],
    };
  }
  let state = saved
    ? {
        ...saved,
        format: saved.format ?? rnlFormatOf(text),
        revisionCount: revisions.length,
        edited: saved.latestRevisionId !== saved.baselineRevisionId,
      }
    : stateFromIndex(name, revisions, false);
  // "edited" means the drawing differs from the schematic export, not just
  // "a later version exists": restoring the baseline text is not an edit.
  if (state.baselineRevisionId) {
    const baseline = await readText(
      revisionFile(dir, name, state.baselineRevisionId),
    );
    if (baseline !== null) state = { ...state, edited: baseline !== text };
  }
  return { exists: true, state, revisions: [...revisions].reverse() };
}

export async function readRnlRevision(
  dataRoot: string,
  dieId: string,
  moduleName: string,
  revisionId: string,
): Promise<RnlRevisionDetail | null> {
  const id = safeRevisionId(revisionId);
  if (!id) return null;
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const name = rnlModuleName(moduleName);
  const revisions = await readIndex(dir, name);
  const revision = revisions.find((entry) => entry.id === id);
  if (!revision) return null;
  const text = await readText(revisionFile(dir, name, id));
  if (text === null) return null;
  const base = revision.baseRevisionId
    ? (await readText(revisionFile(dir, name, revision.baseRevisionId))) ?? ""
    : "";
  return { revision, text, diff: diffRnlLines(base, text) };
}

// ── Write path ───────────────────────────────────────────────────

async function prune(
  dir: string,
  moduleName: string,
  revisions: RnlRevisionMeta[],
  baselineRevisionId: string | null,
): Promise<RnlRevisionMeta[]> {
  while (revisions.length > RNL_HISTORY_LIMIT) {
    const index = revisions.findIndex((entry) => entry.id !== baselineRevisionId);
    if (index < 0) break;
    const [removed] = revisions.splice(index, 1);
    await fs.rm(revisionFile(dir, moduleName, removed.id), { force: true });
  }
  return revisions;
}

function noteFor(options: RnlWriteOptions, author: RnlAuthor, format: RnlFormat): string {
  const note = options.note?.trim();
  return note && note.length > 0 ? note : defaultNote(author, format);
}

async function writeLocked(
  dir: string,
  moduleName: string,
  rawText: string,
  options: RnlWriteOptions,
): Promise<RnlWriteResult> {
  const text = normalizeRnlText(rawText);
  const file = rnlFile(dir, moduleName);
  const currentRaw = await readText(file);
  const current = currentRaw === null ? null : normalizeRnlText(currentRaw);
  let revisions = await readIndex(dir, moduleName);
  let state = await readJson<RnlState>(stateFile(dir, moduleName));
  const author = options.author ?? "user";

  // Adopt a drawing that predates the history, so an overwrite can be undone.
  if (!state && revisions.length === 0 && current !== null) {
    const at = new Date().toISOString();
    const format = rnlFormatOf(current);
    const diff = diffRnlLines("", current);
    const adopted: RnlRevisionMeta = {
      id: newRevisionId(),
      at,
      author: "saved",
      note: "existing RNL drawing (adopted into history)",
      format,
      bytes: Buffer.byteLength(current, "utf8"),
      lines: linesOf(current).length,
      added: diff.added,
      removed: diff.removed,
      baseRevisionId: null,
      restores: null,
      sourceHash: null,
      unchanged: false,
    };
    revisions.push(adopted);
    await writeText(revisionFile(dir, moduleName, adopted.id), current);
    state = {
      ...baseState(moduleName, format),
      baselineRevisionId: adopted.id,
      latestRevisionId: adopted.id,
      latestAuthor: adopted.author,
      latestAt: adopted.at,
      updatedAt: adopted.at,
      revisionCount: 1,
    };
  }
  if (!state) state = stateFromIndex(moduleName, revisions, false);

  const format =
    options.format ?? (text.trim() ? rnlFormatOf(text) : state.format);
  const changed = current === null || current !== text;

  if (!changed && !options.forceRevision && !options.restores) {
    // Persist an adoption if this is the first write, but add no version.
    if (revisions.length > 0 && (await readText(stateFile(dir, moduleName))) === null) {
      await writeJson(historyIndex(dir, moduleName), revisions);
      await writeJson(stateFile(dir, moduleName), state);
    }
    return { file, text, revision: null, state };
  }

  const at = new Date().toISOString();
  const baseRevisionId =
    state.latestRevisionId ?? revisions[revisions.length - 1]?.id ?? null;
  // The file may have been changed outside the app; the version it is based
  // on is still the newest recorded one, so diff against that text.
  const baseText = baseRevisionId
    ? await readText(revisionFile(dir, moduleName, baseRevisionId))
    : null;
  const diff = diffRnlLines(baseText ?? current ?? "", text);
  const revision: RnlRevisionMeta = {
    id: newRevisionId(),
    at,
    author,
    note: noteFor(options, author, format),
    format,
    bytes: Buffer.byteLength(text, "utf8"),
    lines: linesOf(text).length,
    added: diff.added,
    removed: diff.removed,
    baseRevisionId,
    restores: options.restores ?? null,
    sourceHash:
      options.sourceHash !== undefined ? options.sourceHash : state.sourceHash,
    unchanged: !changed,
  };
  revisions.push(revision);

  // History first: a crash must not leave a version listed without its text.
  await writeText(revisionFile(dir, moduleName, revision.id), text);
  revisions = await prune(dir, moduleName, revisions, state.baselineRevisionId);
  await writeJson(historyIndex(dir, moduleName), revisions);
  await writeText(file, text);

  state = {
    ...state,
    format,
    sourceHash:
      options.sourceHash !== undefined ? options.sourceHash : state.sourceHash,
    baselineRevisionId:
      author === "schematic" ? revision.id : state.baselineRevisionId,
    latestRevisionId: revision.id,
    latestAuthor: author,
    latestAt: revision.at,
    updatedAt: revision.at,
    revisionCount: revisions.length,
    ...(author === "schematic" ? { exportedAt: revision.at } : {}),
  };
  const baselineId = state.baselineRevisionId;
  const baseline =
    baselineId === revision.id
      ? text
      : baselineId
        ? await readText(revisionFile(dir, moduleName, baselineId))
        : null;
  state.edited =
    baseline !== null
      ? baseline !== text
      : state.latestRevisionId !== state.baselineRevisionId;
  await writeJson(stateFile(dir, moduleName), state);
  return { file, text, revision, state };
}

export async function writeRnl(
  dataRoot: string,
  dieId: string,
  moduleName: string,
  text: string,
  options: RnlWriteOptions = {},
): Promise<RnlWriteResult> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const name = rnlModuleName(moduleName);
  return locked(stateFile(dir, name), () => writeLocked(dir, name, text, options));
}

export async function setRnlFrozen(
  dataRoot: string,
  dieId: string,
  moduleName: string,
  frozen: boolean,
): Promise<RnlState> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const name = rnlModuleName(moduleName);
  return locked(stateFile(dir, name), async () => {
    const revisions = await readIndex(dir, name);
    const saved = await readJson<RnlState>(stateFile(dir, name));
    const text = await readText(rnlFile(dir, name));
    const state =
      saved ??
      (text !== null
        ? {
            ...stateFromIndex(
              name,
              revisions,
              frozen,
              rnlFormatOf(normalizeRnlText(text)),
            ),
            // A file without history may contain agent/hand edits.
            ...(revisions.length === 0 ? { edited: true } : {}),
          }
        : baseState(name, "spice"));
    state.frozen = frozen;
    state.updatedAt = new Date().toISOString();
    await writeJson(stateFile(dir, name), state);
    return state;
  });
}

export async function restoreRnlRevision(
  dataRoot: string,
  dieId: string,
  moduleName: string,
  revisionId: string,
): Promise<RnlWriteResult | null> {
  const id = safeRevisionId(revisionId);
  if (!id) return null;
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const name = rnlModuleName(moduleName);
  return locked(stateFile(dir, name), async () => {
    const revisions = await readIndex(dir, name);
    const revision = revisions.find((entry) => entry.id === id);
    if (!revision) return null;
    const text = await readText(revisionFile(dir, name, id));
    if (text === null) return null;
    return writeLocked(dir, name, text, {
      author: "user",
      note: `restored ${revision.author} version from ${revision.at}${
        revision.note ? ` (${revision.note})` : ""
      }`,
      format: revision.format,
      restores: id,
    });
  });
}
