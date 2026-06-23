import type { CommentAnnotation } from "shared";
import { apiPut, apiDelete } from "./client";

export type { CommentAnnotation };

/** Upsert a comment. Full replacement (including replies). */
export function upsertComment(dieId: string, comment: CommentAnnotation): Promise<{ ok: boolean; rev: number }> {
  return apiPut(`/api/dies/${encodeURIComponent(dieId)}/comments/${encodeURIComponent(comment.id)}`, comment);
}

/** Delete a comment. */
export function deleteComment(dieId: string, commentId: string): Promise<{ ok: boolean; rev: number }> {
  return apiDelete(`/api/dies/${encodeURIComponent(dieId)}/comments/${encodeURIComponent(commentId)}`);
}
