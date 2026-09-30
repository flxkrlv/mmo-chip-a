import { useCallback, useState, type KeyboardEvent } from "react";
import type { CommentAnnotation } from "shared";
import { useAuth } from "../../state/auth";

interface Props {
  /** Live comment (re-rendered as annotations change), or the unsaved draft. */
  comment: CommentAnnotation;
  onClose: () => void;
  /** Persist the draft with its first text (undoable). */
  onCreate: (text: string) => Promise<void>;
  /** Append a reply by the current user (undoable). */
  onReply: (text: string) => Promise<void>;
  /** Delete the comment and its replies (undoable). */
  onDelete: () => Promise<void>;
  /** Die undo / redo, for ⌘Z / ⌘⇧Z typed into an empty input. */
  onUndo: () => void;
  onRedo: () => void;
}

export function CommentPopover({ comment, onClose, onCreate, onReply, onDelete, onUndo, onRedo }: Props) {
  const { userId, username } = useAuth();
  const [replyText, setReplyText] = useState("");
  // For a new (unsaved) comment, we show an initial text input.
  const [initialText, setInitialText] = useState(comment.text || "");
  const [saving, setSaving] = useState(false);
  // A comment with text is persisted — display + reply mode. Derived from the
  // live comment, so undo / redo of the creation flips it back and forth.
  const saved = !!comment.text;

  const handleSaveInitial = useCallback(async () => {
    if (!initialText.trim() || !userId || !username) return;
    setSaving(true);
    try {
      await onCreate(initialText.trim());
    } finally {
      setSaving(false);
    }
  }, [initialText, userId, username, onCreate]);

  const handleReply = useCallback(async () => {
    if (!replyText.trim() || !userId || !username) return;
    setSaving(true);
    try {
      await onReply(replyText.trim());
      setReplyText("");
    } finally {
      setSaving(false);
    }
  }, [replyText, userId, username, onReply]);

  const handleDelete = useCallback(async () => {
    if (!userId || userId !== comment.authorId) return;
    setSaving(true);
    try {
      await onDelete();
      onClose();
    } finally {
      setSaving(false);
    }
  }, [userId, comment.authorId, onDelete, onClose]);

  // Inputs keep native text undo; once empty (e.g. right after sending a
  // reply) ⌘Z / ⌘⇧Z go to the die's undo stack instead.
  const undoKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!(e.metaKey || e.ctrlKey) || (e.key !== "z" && e.key !== "Z")) return;
    if (e.currentTarget.value !== "") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) onRedo();
    else onUndo();
  };

  return (
    <>
      {/* Backdrop */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 999 }}
        onClick={onClose}
      />
      <div
        className="popover"
        style={{
          position: "absolute",
          zIndex: 1000,
          minWidth: 240,
          maxWidth: 360,
          fontSize: 11.5
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: "50%",
              background: "var(--accent)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              fontWeight: 700,
              flexShrink: 0
            }}
          >
            {comment.authorName[0].toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: "var(--ink)", marginBottom: 2 }}>
              {comment.authorName}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--ink3)", marginBottom: 4 }}>
              {new Date(comment.createdAt).toLocaleString()}
            </div>
            {saved ? (
              <div style={{ color: "var(--ink2)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                {comment.text}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <input
                  type="text"
                  value={initialText}
                  onChange={(e) => setInitialText(e.target.value)}
                  placeholder="Type your comment…"
                  className="input"
                  style={{ flex: 1, height: 28, fontSize: 11 }}
                  autoFocus
                  onKeyDown={(e) => {
                    undoKeys(e);
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSaveInitial();
                    }
                  }}
                />
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <button className="btn ghost" onClick={onClose} style={{ height: 24, fontSize: 10.5 }}>
                    Cancel
                  </button>
                  <button
                    className="btn"
                    onClick={handleSaveInitial}
                    disabled={saving || !initialText.trim()}
                    style={{ height: 24, fontSize: 10.5 }}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            )}
          </div>
          {saved && userId === comment.authorId && (
            <button
              className="btn ghost"
              onClick={handleDelete}
              style={{ color: "var(--err)", fontSize: 10.5, flexShrink: 0, height: 20 }}
              title="Delete comment"
            >
              ✕
            </button>
          )}
        </div>

        {/* Replies */}
        {(comment.replies ?? []).length > 0 && (
          <div style={{ borderTop: "1px solid var(--l1)", paddingTop: 8, marginBottom: 8 }}>
            {(comment.replies ?? []).map((reply) => (
              <div
                key={reply.id}
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "4px 0",
                  paddingLeft: 32
                }}
              >
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "var(--l3)",
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 8,
                    fontWeight: 700,
                    flexShrink: 0
                  }}
                >
                  {reply.authorName[0].toUpperCase()}
                </div>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 600, color: "var(--ink)" }}>
                    {reply.authorName}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--ink3)", marginLeft: 6 }}>
                    {new Date(reply.createdAt).toLocaleString()}
                  </span>
                  <div style={{ color: "var(--ink2)", marginTop: 1, whiteSpace: "pre-wrap" }}>
                    {reply.text}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Reply form (only after the initial text is saved) */}
        {saved && (
          <div style={{ borderTop: "1px solid var(--l1)", paddingTop: 8, display: "flex", gap: 6 }}>
            <input
              type="text"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Reply…"
              className="input"
              style={{ flex: 1, height: 26, fontSize: 11 }}
              onKeyDown={(e) => {
                undoKeys(e);
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleReply();
                }
              }}
            />
            <button
              className="btn"
              onClick={handleReply}
              disabled={saving || !replyText.trim()}
              style={{ height: 26 }}
            >
              {saving ? "…" : "Send"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
