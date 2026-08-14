import type { Cell } from "shared";
import { cellCropUrl, type Candidate } from "../../lib/mergeCells";
import { topVisibleOverlaySourceId, useOverlayLayers } from "../../state/overlayLayers";

interface Props {
  dieId: string;
  overlaySourceId?: string;
  candidates: Candidate[];
  selectedId: string | null;
  onPick: (cell: Cell) => void;
  onContextMenu: (cell: Cell, clientX: number, clientY: number) => void;
}

/** Horizontal, scrollable strip of the candidates still left to match
 *  (already-merged ones are dropped — they live in the left panel). */
export function Filmstrip({ dieId, candidates, selectedId, onPick, onContextMenu }: Props) {
  useOverlayLayers((s) => s.layers);
  const overlaySourceId = topVisibleOverlaySourceId();
  const visible = candidates.filter((c) => !c.done);
  return (
    <div
      style={{
        flex: "0 0 auto",
        height: 72,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        overflowX: "auto",
        overflowY: "hidden",
        background: "var(--card)",
        borderTop: "1px solid var(--l2)"
      }}
    >
      {visible.length === 0 && (
        <span className="m" style={{ fontSize: 10, color: "var(--ink3)", padding: "0 6px" }}>
          nothing left to match
        </span>
      )}
      {visible.map(({ cell }) => {
        const sel = selectedId === cell.id;
        return (
          <div
            key={cell.id}
            title={`cell ${cell.id.slice(0, 8)}`}
            onClick={() => onPick(cell)}
            onContextMenu={(e) => {
              e.preventDefault();
              onPick(cell);
              onContextMenu(cell, e.clientX, e.clientY);
            }}
            style={{
              position: "relative",
              flex: "0 0 auto",
              width: 84,
              height: 58,
              borderRadius: 3,
              overflow: "hidden",
              cursor: "pointer",
              background: "var(--canvas-bg)",
              border: `1px solid ${sel ? "var(--accent)" : "var(--l2)"}`,
              outline: sel ? "1px solid var(--accent)" : "none"
            }}
          >
            <img
              src={cellCropUrl(dieId, cell, overlaySourceId)}
              alt=""
              loading="lazy"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          </div>
        );
      })}
    </div>
  );
}
