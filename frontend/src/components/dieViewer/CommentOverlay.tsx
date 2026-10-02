import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CommentAnnotation, CommentReply, DieAnnotations } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import { useLiveValue } from "../../lib/liveValue";
import { useAuth } from "../../state/auth";
import { uuid } from "../../lib/uuid";
import type { ActionDispatcher } from "../../api/actions";
import { CommentPopover } from "./CommentPopover";
import type { Viewport } from "../../renderer/types";
import { commentAnchorPoints, windowAnchorKey } from "../../lib/windowAnchor";
import { useElementWindow } from "./useElementWindow";

interface Props {
  annotations: DieAnnotations | undefined;
  viewportStore: LiveValue<Viewport | null>;
  dieId: string;
  /** Comment create / reply / edit / move / delete go through it, so they are undoable. */
  dispatcher: ActionDispatcher;
  /** Called when annotations have changed (to trigger a refetch). */
  onAnnotationChange?: () => void;
  /**
   * When set to a world coordinate, a new comment will be created at that
   * position and the popover opened. The overlay resets this to null after
   * consuming it.
   */
  pendingNewComment?: { x: number; y: number } | null;
  /** Called when the overlay has consumed the pending new comment. */
  onConsumePendingComment?: () => void;
}

const COMMENT_COLOR = "#fcc419";
const COMMENT_SIZE = 24;
/** Screen pixels a pin must travel before a press counts as a drag (move)
 *  rather than a click (open). */
const DRAG_THRESHOLD_PX = 4;

/**
 * Renders comment pin markers on the canvas + popover on click.
 * Handles adding new comments via a simple prompt when comment tool is active.
 */
export function CommentOverlay({ annotations, viewportStore, dieId, dispatcher, onAnnotationChange, pendingNewComment, onConsumePendingComment }: Props) {
  const viewport = useLiveValue(viewportStore);
  const { userId, username } = useAuth();
  const [selectedComment, setSelectedComment] = useState<{
    comment: CommentAnnotation;
    x: number;
    y: number;
  } | null>(null);

  // When the page signals a pending new comment (user clicked canvas in
  // comment-tool mode), create the unsaved comment and open the popover.
  useEffect(() => {
    if (!pendingNewComment || !userId || !username) return;
    const pos = pendingNewComment;
    const newComment: CommentAnnotation = {
      id: uuid(),
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      text: "",
      authorId: userId,
      authorName: username,
      createdAt: new Date().toISOString(),
      replies: []
    };
    setSelectedComment({ comment: newComment, x: newComment.x, y: newComment.y });
    onConsumePendingComment?.();
  }, [pendingNewComment, userId, username, onConsumePendingComment]);

  const comments = annotations?.comments ?? [];

  const markers = useMemo(() => {
    if (!viewport) return [];
    return comments.map((c) => {
      const cssX = (c.x - viewport.originX) * viewport.zoom;
      const cssY = (c.y - viewport.originY) * viewport.zoom;
      return { comment: c, cssX, cssY };
    });
  }, [comments, viewport]);

  const handlePinClick = useCallback((comment: CommentAnnotation, worldX: number, worldY: number) => {
    setSelectedComment({ comment, x: worldX, y: worldY });
  }, []);

  // Dragging a pin moves the comment. The ref tracks the press; `dragOffset`
  // (screen px) only drives the live marker position while dragging.
  const dragRef = useRef<{ id: string; sx: number; sy: number; moved: boolean } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ id: string; dx: number; dy: number } | null>(null);
  // Dropped position (world), shown until the move dispatch settles so the
  // pin doesn't flash back to its old spot before the optimistic update.
  const [dropped, setDropped] = useState<{ id: string; x: number; y: number } | null>(null);
  // The click that follows a drag's pointerup must not open the popover.
  const suppressClickRef = useRef(false);

  const handleCanvasClick = useCallback((worldX: number, worldY: number) => {
    if (!userId || !username) return;

    // Check if clicked on existing comment pin (within tolerance)
    const tol = 20;
    for (const c of comments) {
      if (Math.abs(c.x - worldX) < tol && Math.abs(c.y - worldY) < tol) {
        setSelectedComment({ comment: c, x: c.x, y: c.y });
        return;
      }
    }

    // Create new comment at the clicked location
    const newComment: CommentAnnotation = {
      id: uuid(),
      x: Math.round(worldX),
      y: Math.round(worldY),
      text: "",
      authorId: userId,
      authorName: username,
      createdAt: new Date().toISOString(),
      replies: []
    };
    // Open the popover immediately with the new (unsaved) comment
    setSelectedComment({ comment: newComment, x: newComment.x, y: newComment.y });
  }, [comments, userId, username]);

  const handlePopoverClose = useCallback(() => {
    setSelectedComment(null);
  }, []);

  // The popover shows the LIVE comment (so replies, undo and redo — local or
  // from other users — show up at once); `selectedComment.comment` is only
  // the snapshot / unsaved draft to fall back on.
  const liveComment = selectedComment
    ? comments.find((c) => c.id === selectedComment.comment.id) ?? null
    : null;
  const shownComment = liveComment ?? selectedComment?.comment ?? null;
  // Close once a comment that existed goes away (deleted, or its creation
  // undone). A brand-new draft that was never saved stays open.
  const seenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedComment) {
      seenRef.current = null;
      return;
    }
    const id = selectedComment.comment.id;
    if (liveComment) seenRef.current = id;
    else if (seenRef.current === id || selectedComment.comment.text) setSelectedComment(null);
  }, [selectedComment, liveComment]);

  const dispatchThen = useCallback(
    async (action: Parameters<ActionDispatcher["dispatch"]>[0]) => {
      await dispatcher.dispatch(action);
      onAnnotationChange?.();
    },
    [dispatcher, onAnnotationChange]
  );

  const handleCreate = useCallback(
    (text: string) => {
      if (!selectedComment) return Promise.resolve();
      return dispatchThen({
        kind: "upsertComment",
        comment: { ...selectedComment.comment, text },
        prevComment: null
      });
    },
    [selectedComment, dispatchThen]
  );

  const handleReply = useCallback(
    (text: string) => {
      if (!shownComment || !userId || !username) return Promise.resolve();
      const reply: CommentReply = {
        id: uuid(),
        text,
        authorId: userId,
        authorName: username,
        createdAt: new Date().toISOString()
      };
      return dispatchThen({ kind: "addCommentReply", commentId: shownComment.id, reply });
    },
    [shownComment, userId, username, dispatchThen]
  );

  const handleEdit = useCallback(
    (text: string) => {
      if (!shownComment) return Promise.resolve();
      return dispatchThen({
        kind: "upsertComment",
        comment: { ...shownComment, text },
        prevComment: shownComment
      });
    },
    [shownComment, dispatchThen]
  );

  const handleEditReply = useCallback(
    (reply: CommentReply, text: string) => {
      if (!shownComment) return Promise.resolve();
      return dispatchThen({
        kind: "updateCommentReply",
        commentId: shownComment.id,
        reply: { ...reply, text },
        prevReply: reply
      });
    },
    [shownComment, dispatchThen]
  );

  const handleDeleteReply = useCallback(
    (reply: CommentReply) => {
      if (!shownComment) return Promise.resolve();
      return dispatchThen({ kind: "removeCommentReply", commentId: shownComment.id, reply });
    },
    [shownComment, dispatchThen]
  );

  const handleDelete = useCallback(() => {
    if (!shownComment) return Promise.resolve();
    return dispatchThen({ kind: "removeComment", comment: shownComment });
  }, [shownComment, dispatchThen]);

  const handleMove = useCallback(
    (comment: CommentAnnotation, x: number, y: number) => {
      if (x === comment.x && y === comment.y) return;
      setDropped({ id: comment.id, x, y });
      void dispatchThen({ kind: "upsertComment", comment: { ...comment, x, y }, prevComment: comment })
        .finally(() => setDropped((d) => (d?.id === comment.id ? null : d)));
    },
    [dispatchThen]
  );

  const handleUndo = useCallback(() => {
    void dispatcher.undo().then(() => onAnnotationChange?.());
  }, [dispatcher, onAnnotationChange]);
  const handleRedo = useCallback(() => {
    void dispatcher.redo().then(() => onAnnotationChange?.());
  }, [dispatcher, onAnnotationChange]);

  return (
    <>
      {/* Pin markers */}
      {markers.map((m) => {
        const replyCount = m.comment.replies?.length ?? 0;
        const offset = dragOffset?.id === m.comment.id ? dragOffset : null;
        const drop = dropped?.id === m.comment.id && viewport ? dropped : null;
        const baseX = drop ? (drop.x - viewport!.originX) * viewport!.zoom : m.cssX;
        const baseY = drop ? (drop.y - viewport!.originY) * viewport!.zoom : m.cssY;
        return (
          <div
            key={m.comment.id}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              dragRef.current = { id: m.comment.id, sx: e.clientX, sy: e.clientY, moved: false };
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d || d.id !== m.comment.id) return;
              const dx = e.clientX - d.sx;
              const dy = e.clientY - d.sy;
              if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
              d.moved = true;
              setDragOffset({ id: d.id, dx, dy });
            }}
            onPointerUp={(e) => {
              const d = dragRef.current;
              dragRef.current = null;
              setDragOffset(null);
              if (!d || d.id !== m.comment.id || !d.moved || !viewport) return;
              suppressClickRef.current = true;
              handleMove(
                m.comment,
                Math.round(m.comment.x + (e.clientX - d.sx) / viewport.zoom),
                Math.round(m.comment.y + (e.clientY - d.sy) / viewport.zoom)
              );
            }}
            onPointerCancel={() => {
              dragRef.current = null;
              setDragOffset(null);
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              handlePinClick(m.comment, m.comment.x, m.comment.y);
            }}
            title={`${m.comment.authorName}: ${m.comment.text.slice(0, 60)}${m.comment.text.length > 60 ? "…" : ""}\n(drag to move)`}
            style={{
              position: "absolute",
              left: baseX + (offset?.dx ?? 0) - COMMENT_SIZE / 2,
              top: baseY + (offset?.dy ?? 0) - COMMENT_SIZE / 2,
              touchAction: "none",
              width: COMMENT_SIZE,
              height: COMMENT_SIZE,
              borderRadius: "50%",
              background: COMMENT_COLOR,
              color: "#1c1c1a",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 700,
              cursor: offset ? "grabbing" : "grab",
              zIndex: offset ? 11 : 10,
              boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
              transition: "transform 0.1s",
              pointerEvents: "auto",
              border: replyCount > 0 ? "2px solid #e67700" : "none"
            }}
          >
            {replyCount > 0 ? "💬" : "💭"}
          </div>
        );
      })}

      {/* Popover — beside the pin, or where it was last dragged to. */}
      {selectedComment && shownComment && (
        <CommentWindow dieId={dieId} comment={shownComment} viewportStore={viewportStore}>
          <CommentPopover
            key={shownComment.id}
            comment={shownComment}
            onClose={handlePopoverClose}
            onCreate={handleCreate}
            onReply={handleReply}
            onEdit={handleEdit}
            onEditReply={handleEditReply}
            onDeleteReply={handleDeleteReply}
            onDelete={handleDelete}
            onUndo={handleUndo}
            onRedo={handleRedo}
          />
        </CommentWindow>
      )}
    </>
  );
}

/** Draggable frame of the comment popover: anchored to the comment position
 *  (it has no other geometry), reopening where it was last dropped. */
function CommentWindow({
  dieId,
  comment,
  viewportStore,
  children
}: {
  dieId: string;
  comment: CommentAnnotation;
  viewportStore: LiveValue<Viewport | null>;
  children: ReactNode;
}) {
  const { windowProps } = useElementWindow({
    anchorKey: windowAnchorKey(dieId, "comment", comment.id),
    points: commentAnchorPoints(comment),
    fallback: { x: comment.x, y: comment.y, dx: 12, dy: 12 },
    viewportStore
  });
  return (
    <div {...windowProps} style={{ ...windowProps.style, zIndex: 1000 }}>
      {children}
    </div>
  );
}
