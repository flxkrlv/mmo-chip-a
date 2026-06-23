import { useMemo, type ReactNode } from "react";
import type { CommentAnnotation, DieAnnotations } from "shared";
import type { Viewport } from "../../renderer/types";

interface Props {
  annotations: DieAnnotations | undefined;
  viewport: Viewport | null;
  onCommentClick: (comment: CommentAnnotation, worldX: number, worldY: number) => void;
}

const COMMENT_COLOR = "#fcc419";
const COMMENT_SIZE = 22;

export function CommentMarkers({ annotations, viewport, onCommentClick }: Props): ReactNode {
  const comments = annotations?.comments ?? [];

  const markers = useMemo(() => {
    if (!viewport) return [];
    return comments.map((c) => {
      const cssX = (c.x - viewport.originX) * viewport.zoom;
      const cssY = (c.y - viewport.originY) * viewport.zoom;
      return { comment: c, cssX, cssY };
    });
  }, [comments, viewport]);

  if (markers.length === 0) return null;

  return (
    <>
      {markers.map((m) => (
        <div
          key={m.comment.id}
          onClick={(e) => {
            e.stopPropagation();
            onCommentClick(m.comment, m.comment.x, m.comment.y);
          }}
          title={`${m.comment.authorName}: ${m.comment.text.slice(0, 50)}${m.comment.text.length > 50 ? "…" : ""}`}
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
            fontSize: 10,
            fontWeight: 700,
            cursor: "pointer",
            zIndex: 10,
            boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
            transition: "transform 0.1s",
            pointerEvents: "auto"
          }}
          onMouseEnter={(e) => {
            (e.target as HTMLElement).style.transform = "scale(1.2)";
          }}
          onMouseLeave={(e) => {
            (e.target as HTMLElement).style.transform = "scale(1)";
          }}
        >
          {m.comment.replies.length > 0 ? "💬" : "💭"}
        </div>
      ))}
    </>
  );
}
