/**
 * FloorplanPolyDraft.tsx — live preview of a floorplan polygon being drawn.
 *
 * Shown from the first click: placed vertices (the first one larger, it is
 * where the outline closes), the edges between them, a rubber-band segment
 * from the last vertex to the cursor and a fainter closing segment back to the
 * first vertex. Subscribes to the cursor on its own so mouse moves only
 * re-render this preview, not every floorplan region.
 */

import type { LiveValue } from "../../lib/liveValue";
import { useLiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";
import type { FloorplanDraft } from "../../state/floorplan";

const STROKE = "#aaa";

export function FloorplanPolyDraft({
  draft,
  viewport,
  cursorStore
}: {
  draft: FloorplanDraft;
  viewport: Viewport;
  cursorStore: LiveValue<{ x: number; y: number } | null>;
}) {
  const cursor = useLiveValue(cursorStore);
  const toCss = (p: { x: number; y: number }) => ({
    x: (p.x - viewport.originX) * viewport.zoom,
    y: (p.y - viewport.originY) * viewport.zoom
  });
  const pts = draft.points.map(toCss);
  if (pts.length === 0) return null;
  const tip = cursor ? toCss(cursor) : null;
  const path = [...pts, ...(tip ? [tip] : [])];
  const last = path[path.length - 1];
  const first = pts[0];

  return (
    <svg
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 8
      }}
    >
      {/* Closing edge preview (would-be polygon has >= 3 vertices). */}
      {path.length >= 3 && (
        <line
          x1={last.x}
          y1={last.y}
          x2={first.x}
          y2={first.y}
          stroke={STROKE}
          strokeWidth={1.5}
          strokeDasharray="3 5"
          opacity={0.45}
        />
      )}
      {path.length >= 2 && (
        <polyline
          points={path.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke={STROKE}
          strokeWidth={2.2}
          strokeDasharray="5 4"
          opacity={0.8}
        />
      )}
      {pts.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={i === 0 ? 4.5 : 3}
          fill="#fff"
          stroke={i === 0 ? "#4dabf7" : "#888"}
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}
