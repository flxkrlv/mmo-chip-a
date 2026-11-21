import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveProjectDir } from "./projectLayout.js";

/** RNL drawings live beside the project, one file per module. */
export const RNL_DIR = "rnl";

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

export async function readRnl(
  dataRoot: string,
  dieId: string,
  moduleName: string,
): Promise<{ text: string; path: string } | null> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const file = rnlFile(dir, moduleName);
  try {
    return { text: normalizeRnlText(await fs.readFile(file, "utf8")), path: file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeRnl(
  dataRoot: string,
  dieId: string,
  moduleName: string,
  text: string,
): Promise<string> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const file = rnlFile(dir, moduleName);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, normalizeRnlText(text), "utf8");
  return file;
}
