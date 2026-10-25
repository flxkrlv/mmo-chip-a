import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CommentImage } from "shared";
import { resolveProjectDir } from "../projectLayout.js";

/**
 * Images attached to comments / replies, stored as `<projectDir>/
 * comment-images/<id>.jpg`. Files are never deleted when a comment goes away:
 * undo / redo (MCP or Ctrl+Z) can bring the comment back with its reference.
 */

export const COMMENT_IMAGES_DIR = "comment-images";
const FILE_RE = /^([0-9a-f-]{36})\.jpg$/;

export async function saveCommentImage(
  dataRoot: string,
  dieId: string,
  jpeg: Buffer,
  meta: { width: number; height: number; caption?: string }
): Promise<CommentImage> {
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const id = randomUUID();
  const target = path.join(dir, COMMENT_IMAGES_DIR, `${id}.jpg`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, jpeg);
  return { id, width: meta.width, height: meta.height, ...(meta.caption ? { caption: meta.caption } : {}) };
}

/** Absolute path of an attached image, or null for a bad / missing name. */
export async function commentImagePath(dataRoot: string, dieId: string, file: string): Promise<string | null> {
  if (!FILE_RE.test(file)) return null;
  const { dir } = await resolveProjectDir(dataRoot, dieId);
  const target = path.join(dir, COMMENT_IMAGES_DIR, file);
  try {
    await fs.access(target);
    return target;
  } catch {
    return null;
  }
}
