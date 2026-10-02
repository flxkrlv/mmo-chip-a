import { useCallback, useState, type KeyboardEvent } from "react";
import type { CommentAnnotation, CommentReply } from "shared";
import { Ic } from "../../icons";
import { useAuth } from "../../state/auth";

interface Props {
  /** Live comment (re-rendered as annotations change), or the unsaved draft. */
  comment: CommentAnnotation;
  onClose: () => void;
  /** Persist the draft with its first text (undoable). */
  onCreate: (text: string) => Promise<void>;
  /** Append a reply by the current user (undoable). */
  onReply: (text: string) => Promise<void>;
  /** Replace the comment's text (undoable). */
  onEdit: (text: string) => Promise<void>;
  /** Replace one reply's text (undoable). */
  onEditReply: (reply: CommentReply, text: string) => Promise<void>;
  /** Delete one reply (undoable). */
  onDeleteReply: (reply: CommentReply) => Promise<void>;
  /** Delete the comment and its replies (undoable). */
  onDelete: () => Promise<void>;
  /** Die undo / redo, for ⌘Z / ⌘⇧Z typed into an empty input. */
  onUndo: () => void;
  onRedo: () => void;
}

export function CommentPopover({ comment, onClose, onCreate, onReply, onEdit, onEditReply, onDeleteReply, onDelete, onUndo, onRedo }: Props) {
  const { userId, username } = useAuth();
  const [replyText, setReplyText] = useState("");
  // For a new (unsaved) comment, we show an initial text input.
  const [initialText, setInitialText] = useState(comment.text || "");
  const [saving, setSaving] = useState(false);
  // A comment with text is persisted — display + reply mode. Derived from the
  // live comment, so undo / redo of the creation flips it back and forth.
  const saved = !!comment.text;
  const isAuthor = !!userId && userId === comment.authorId;
  // Editing the saved text (author only); null when not editing.
  const [editText, setEditText] = useState<string | null>(null);
  // The reply being edited (own replies only) and its draft text.
  const [replyEdit, setReplyEdit] = useState<{ id: string; text: string } | null>(null);

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

  const handleSaveEdit = useCallback(async () => {
    const text = editText?.trim();
    if (!text || !isAuthor) return;
    if (text === comment.text) {
      setEditText(null);
      return;
    }
    setSaving(true);
    try {
      await onEdit(text);
      setEditText(null);
    } finally {
      setSaving(false);
    }
  }, [editText, isAuthor, comment.text, onEdit]);

  const handleSaveReplyEdit = useCallback(async () => {
    if (!replyEdit) return;
    const reply = (comment.replies ?? []).find((r) => r.id === replyEdit.id);
    const text = replyEdit.text.trim();
    if (!reply || !text || reply.authorId !== userId) return;
    if (text === reply.text) {
      setReplyEdit(null);
      return;
    }
    setSaving(true);
    try {
      await onEditReply(reply, text);
      setReplyEdit(null);
    } finally {
      setSaving(false);
    }
  }, [replyEdit, comment.replies, userId, onEditReply]);

  const handleDeleteReply = useCallback(async (reply: CommentReply) => {
    if (!userId || reply.authorId !== userId) return;
    setSaving(true);
    try {
      await onDeleteReply(reply);
      setReplyEdit((e) => (e?.id === reply.id ? null : e));
    } finally {
      setSaving(false);
    }
  }, [userId, onDeleteReply]);

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
            {saved && editText !== null ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <input
                  type="text"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="input"
                  style={{ flex: 1, height: 28, fontSize: 11 }}
                  autoFocus
                  onKeyDown={(e) => {
                    undoKeys(e);
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSaveEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setEditText(null);
                    }
                  }}
                />
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <button className="btn ghost" onClick={() => setEditText(null)} style={{ height: 24, fontSize: 10.5 }}>
                    Cancel
                  </button>
                  <button
                    className="btn"
                    onClick={handleSaveEdit}
                    disabled={saving || !editText.trim()}
                    style={{ height: 24, fontSize: 10.5 }}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            ) : saved ? (
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
          {saved && isAuthor && editText === null && (
            <button
              className="btn ghost"
              onClick={() => setEditText(comment.text)}
              style={{ color: "var(--ink3)", fontSize: 11, flexShrink: 0, height: 20, padding: "0 4px" }}
              title="Edit comment"
              aria-label="Edit comment"
            >
              ✎
            </button>
          )}
          {saved && isAuthor && (
            <button
              className="btn ghost"
              onClick={handleDelete}
              disabled={saving}
              style={{ color: "var(--err)", flexShrink: 0, height: 20, padding: "0 4px" }}
              title="Delete comment and its replies"
              aria-label="Delete comment"
            >
              {Ic.trash}
            </button>
          )}
          <button
            className="btn ghost"
            onClick={onClose}
            style={{ color: "var(--ink3)", fontSize: 10.5, flexShrink: 0, height: 20 }}
            title="Close"
            aria-label="Close"
          >
            ✕
          </button>
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
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, color: "var(--ink)" }}>
                    {reply.authorName}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--ink3)", marginLeft: 6 }}>
                    {new Date(reply.createdAt).toLocaleString()}
                  </span>
                  {replyEdit?.id === reply.id ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
                      <input
                        type="text"
                        value={replyEdit.text}
                        onChange={(e) => setReplyEdit({ id: reply.id, text: e.target.value })}
                        className="input"
                        style={{ flex: 1, height: 26, fontSize: 11 }}
                        autoFocus
                        onKeyDown={(e) => {
                          undoKeys(e);
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSaveReplyEdit();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            e.stopPropagation();
                            setReplyEdit(null);
                          }
                        }}
                      />
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button className="btn ghost" onClick={() => setReplyEdit(null)} style={{ height: 22, fontSize: 10.5 }}>
                          Cancel
                        </button>
                        <button
                          className="btn"
                          onClick={handleSaveReplyEdit}
                          disabled={saving || !replyEdit.text.trim()}
                          style={{ height: 22, fontSize: 10.5 }}
                        >
                          {saving ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: "var(--ink2)", marginTop: 1, whiteSpace: "pre-wrap" }}>
                      {reply.text}
                    </div>
                  )}
                </div>
                {userId === reply.authorId && replyEdit?.id !== reply.id && (
                  <button
                    className="btn ghost"
                    onClick={() => setReplyEdit({ id: reply.id, text: reply.text })}
                    style={{ color: "var(--ink3)", fontSize: 11, flexShrink: 0, height: 18, padding: "0 4px" }}
                    title="Edit reply"
                    aria-label="Edit reply"
                  >
                    ✎
                  </button>
                )}
                {userId === reply.authorId && (
                  <button
                    className="btn ghost"
                    onClick={() => handleDeleteReply(reply)}
                    disabled={saving}
                    style={{ color: "var(--err)", flexShrink: 0, height: 18, padding: "0 4px" }}
                    title="Delete reply"
                    aria-label="Delete reply"
                  >
                    {Ic.trash}
                  </button>
                )}
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
