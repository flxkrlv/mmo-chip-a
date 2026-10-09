import { describe, expect, it } from "vitest";
import type { CommentAnnotation, CommentReply, DieAnnotations } from "shared";
import { applyAction, inverseOf, type AnnotationAction } from "./actions";

const reply = (id: string, createdAt: string, authorName = "bob"): CommentReply => ({
  id,
  text: `reply ${id}`,
  authorId: authorName,
  authorName,
  createdAt
});

const comment: CommentAnnotation = {
  id: "c1",
  x: 10,
  y: 20,
  text: "look here",
  authorId: "alice",
  authorName: "alice",
  createdAt: "2026-10-01T10:00:00.000Z",
  replies: [reply("r1", "2026-10-01T10:01:00.000Z")]
};

const die = (comments: CommentAnnotation[] | undefined): DieAnnotations =>
  ({ version: 2, comments } as unknown as DieAnnotations);

/** Apply `action`, then its inverse; returns [after, afterUndo]. */
function roundTrip(start: DieAnnotations, action: AnnotationAction) {
  const after = applyAction(start, action);
  return [after, applyAction(after, inverseOf(action))] as const;
}

describe("comment actions", () => {
  it("creating a comment undoes to no comment", () => {
    const [after, undone] = roundTrip(die(undefined), {
      kind: "upsertComment",
      comment,
      prevComment: null
    });
    expect(after.comments).toEqual([comment]);
    expect(undone.comments).toEqual([]);
  });

  it("deleting a comment undoes to the same comment, replies included", () => {
    const [after, undone] = roundTrip(die([comment]), { kind: "removeComment", comment });
    expect(after.comments).toEqual([]);
    expect(undone.comments).toEqual([comment]);
  });

  it("undoing a reply removes only that reply, keeping later ones from others", () => {
    const mine = reply("r2", "2026-10-01T10:02:00.000Z", "alice");
    const action: AnnotationAction = { kind: "addCommentReply", commentId: "c1", reply: mine };
    const after = applyAction(die([comment]), action);
    expect(after.comments![0].replies.map((r) => r.id)).toEqual(["r1", "r2"]);

    // Someone else replies before the undo.
    const theirs = reply("r3", "2026-10-01T10:03:00.000Z", "carol");
    const withTheirs = applyAction(after, { kind: "addCommentReply", commentId: "c1", reply: theirs });
    const undone = applyAction(withTheirs, inverseOf(action));
    expect(undone.comments![0].replies.map((r) => r.id)).toEqual(["r1", "r3"]);

    // Redo puts it back in its original (createdAt) place.
    const redone = applyAction(undone, action);
    expect(redone.comments![0].replies.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("adding the same reply twice is idempotent", () => {
    const r = reply("r2", "2026-10-01T10:02:00.000Z");
    const action: AnnotationAction = { kind: "addCommentReply", commentId: "c1", reply: r };
    const twice = applyAction(applyAction(die([comment]), action), action);
    expect(twice.comments![0].replies).toHaveLength(2);
  });

  it("editing a comment's text undoes to the previous text", () => {
    const edited = { ...comment, text: "changed" };
    const [after, undone] = roundTrip(die([comment]), {
      kind: "upsertComment",
      comment: edited,
      prevComment: comment
    });
    expect(after.comments![0].text).toBe("changed");
    expect(undone.comments![0]).toEqual(comment);
  });

  it("editing a reply undoes to its previous text, keeping others' new replies", () => {
    const prev = comment.replies[0];
    const action: AnnotationAction = {
      kind: "updateCommentReply",
      commentId: "c1",
      reply: { ...prev, text: "fixed typo" },
      prevReply: prev
    };
    const after = applyAction(die([comment]), action);
    expect(after.comments![0].replies.map((r) => r.text)).toEqual(["fixed typo"]);

    const theirs = reply("r3", "2026-10-01T10:03:00.000Z", "carol");
    const withTheirs = applyAction(after, { kind: "addCommentReply", commentId: "c1", reply: theirs });
    const undone = applyAction(withTheirs, inverseOf(action));
    expect(undone.comments![0].replies).toEqual([prev, theirs]);
  });

  it("editing a reply that was deleted meanwhile doesn't resurrect it", () => {
    const prev = comment.replies[0];
    const gone = applyAction(die([comment]), { kind: "removeCommentReply", commentId: "c1", reply: prev });
    const after = applyAction(gone, {
      kind: "updateCommentReply",
      commentId: "c1",
      reply: { ...prev, text: "late edit" },
      prevReply: prev
    });
    expect(after.comments![0].replies).toEqual([]);
  });
});
