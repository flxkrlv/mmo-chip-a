import type { Cell } from "shared";
import { cellCropUrl } from "../../lib/mergeCells";
import { CellThumb } from "./CellThumb";

/**
 * Floating list over the merge canvas in multiple-overlay mode: one switch per
 * instance of the specimen type. Every switched-on instance is drawn at
 * 100/N % opacity, N = number switched on.
 */
export function MultiOverlayPanel({
  dieId,
  overlaySourceId,
  cells,
  excluded,
  referenceId,
  onSetIncluded
}: {
  dieId: string;
  overlaySourceId?: string;
  cells: Cell[];
  excluded: ReadonlySet<string>;
  /** The reference instance of the type (tagged "ref" in the list). */
  referenceId: string | null;
  onSetIncluded: (ids: string[], included: boolean) => void;
}) {
  const n = cells.filter((c) => !excluded.has(c.id)).length;
  const pct = n > 0 ? `${+(100 / n).toFixed(1)}% each` : "none shown";
  const allIds = cells.map((c) => c.id);
  return (
    <div
      className="popover"
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        width: 220,
        maxHeight: "calc(100% - 16px)",
        padding: 0,
        display: "flex",
        flexDirection: "column"
      }}
      // Keep canvas pan/zoom gestures from firing through the panel.
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className="row"
        style={{
          gap: 6,
          padding: "8px 10px",
          borderBottom: "1px solid var(--l2)",
          alignItems: "center"
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)" }}>
          {n}/{cells.length} cells
        </span>
        <span className="m" style={{ fontSize: 10, color: "var(--ink3)", flex: "1 1 auto" }}>
          {pct}
        </span>
        <button className="btn" style={{ fontSize: 10 }} onClick={() => onSetIncluded(allIds, true)}>
          all
        </button>
        <button className="btn" style={{ fontSize: 10 }} onClick={() => onSetIncluded(allIds, false)}>
          none
        </button>
      </div>
      <div style={{ overflowY: "auto", padding: "4px 0" }}>
        {cells.map((c) => {
          const on = !excluded.has(c.id);
          return (
            <label
              key={c.id}
              className="row"
              style={{
                gap: 8,
                padding: "3px 10px",
                alignItems: "center",
                cursor: "pointer",
                opacity: on ? 1 : 0.55
              }}
              title={`cell ${c.id.slice(0, 8)} · (${Math.round(c.x)}, ${Math.round(c.y)})`}
            >
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={on}
                onChange={(e) => onSetIncluded([c.id], e.target.checked)}
              />
              <CellThumb
                src={cellCropUrl(dieId, c, overlaySourceId)}
                style={{
                  width: 40,
                  height: 28,
                  flex: "0 0 auto",
                  borderRadius: 3,
                  border: "1px solid var(--l2)"
                }}
              />
              <span className="m" style={{ fontSize: 10.5, color: "var(--ink2)", flex: "1 1 auto" }}>
                {c.id.slice(0, 6)}
              </span>
              {c.id === referenceId && (
                <span className="m" style={{ fontSize: 9.5, color: "var(--ok)" }}>
                  ref
                </span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
