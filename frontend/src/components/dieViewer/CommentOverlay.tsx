import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CommentAnnotation, DieAnnotations } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import { useLiveValue } from "../../lib/liveValue";
import { useAuth } from "../../state/auth";
import { uuid } from "../../lib/uuid";
import { upsertComment } from "../../api/comments";
import { CommentPopover } from "./CommentPopover";
import type { Viewport } from "../../renderer/types";

interface Props {
  annotations: DieAnnotations | undefined;
  viewportStore: LiveValue<Viewport | null>;
  dieId: string;
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

/**
 * Renders comment pin markers on the canvas + popover on click.
 * Handles adding new comments via a simple prompt when comment tool is active.
 */
export function CommentOverlay({ annotations, viewportStore, dieId, onAnnotationChange, pendingNewComment, onConsumePendingComment }: Props) {
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

  const handlePopoverSaved = useCallback(() => {
    onAnnotationChange?.();
  }, [onAnnotationChange]);

  const handlePopoverClose = useCallback(() => {
    setSelectedComment(null);
  }, []);

  return (
    <>
      {/* Pin markers */}
      {markers.map((m) => {
        const replyCount = m.comment.replies?.length ?? 0;
        return (
          <div
            key={m.comment.id}
            onClick={(e) => {
              e.stopPropagation();
              handlePinClick(m.comment, m.comment.x, m.comment.y);
            }}
            title={`${m.comment.authorName}: ${m.comment.text.slice(0, 60)}${m.comment.text.length > 60 ? "…" : ""}`}
            style={{
              position: "absolute",
              left: m.cssX - COMMENT_SIZE / 2,
              top: m.cssY - COMMENT_SIZE / 2,
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
              cursor: "pointer",
              zIndex: 10,
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

      {/* Popover — positioned near the comment pin, clamped to viewport. */}
      {selectedComment && viewport && (() => {
        const cssX = (selectedComment.x - viewport.originX) * viewport.zoom;
        const cssY = (selectedComment.y - viewport.originY) * viewport.zoom;
        const popW = 360;
        const popH = 200;
        const margin = 12;
        // Default: below and to the right of the pin.
        let left = cssX + margin;
        let top = cssY + margin;
        // Clamp right edge
        if (left + popW > window.innerWidth - margin) {
          left = cssX - popW - margin;
        }
        // Clamp bottom edge
        if (top + popH > window.innerHeight - margin) {
          top = window.innerHeight - popH - margin;
        }
        // Clamp left/top
        left = Math.max(margin, left);
        top = Math.max(margin, top);
        return (
          <div style={{ position: "fixed", left, top, zIndex: 1000 }}>
            <CommentPopover
              comment={selectedComment.comment}
              dieId={dieId}
              onClose={handlePopoverClose}
              onSaved={handlePopoverSaved}
            />
          </div>
        );
      })()}
    </>
  );
}
