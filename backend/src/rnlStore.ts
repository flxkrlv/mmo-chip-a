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

export async function readRnl(
  dataRoot: string,
  dieId: string,
  moduleName: string,
): Promise<{ text: string; path: string } | null> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const file = rnlFile(dir, moduleName);
  try {
    return { text: await fs.readFile(file, "utf8"), path: file };
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
  await fs.writeFile(file, text, "utf8");
  return file;
}
