import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Cell, CellType, DieAnnotations } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import { useLiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";
import { CellTypeColorBody } from "./CellTypeColorPicker";

/**
 * Non-modal window opened by double-clicking a placed cell on the die (styled
 * like FloorplanRegionPopover, anchored at the double-click so it follows pan
 * / zoom). Reassigns that cell to another existing cell type, splits it off
 * into a fresh type (a clone of its current one, so the RE'd layers carry
 * over), or recolors its current type. Rendered inside the canvas container.
 *
 * Enter picks the highlighted row, ↑/↓ move, Escape / Close / clicking
 * outside closes. A color pick applies at once (undoable) and keeps the
 * window open; picking a type or splitting closes it.
 */
export function CellTypePopover({
  cell,
  annotations,
  anchor,
  viewportStore,
  onPick,
  onSplit,
  onSetColor,
  onClose
}: {
  cell: Cell;
  annotations: DieAnnotations;
  /** World point the window is anchored to. */
  anchor: { x: number; y: number };
  viewportStore: LiveValue<Viewport | null>;
  onPick: (cellType: CellType) => void;
  onSplit: (name: string) => void;
  /** Recolor the cell's current type; `undefined` = back to the default. */
  onSetColor: (cellType: CellType, color: string | undefined) => void;
  onClose: () => void;
}) {
  const viewport = useLiveValue(viewportStore);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // Size of the positioned canvas container (our absolute coords' frame).
  const [bounds, setBounds] = useState({ w: window.innerWidth, h: window.innerHeight });
  useLayoutEffect(() => {
    const parent = popoverRef.current?.offsetParent as HTMLElement | null;
    if (parent) setBounds({ w: parent.clientWidth, h: parent.clientHeight });
  }, [viewport]);

  // Another cell opened in the same window → start over.
  useEffect(() => {
    setQuery("");
    setActive(0);
  }, [cell.id]);

  // Click outside → close (same as the floorplan popover).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of annotations.cells) m.set(c.cellTypeId, (m.get(c.cellTypeId) ?? 0) + 1);
    return m;
  }, [annotations.cells]);

  const current = annotations.cellTypes.find((t) => t.id === cell.cellTypeId);
  const currentCount = counts.get(cell.cellTypeId) ?? 0;
  const q = query.trim().toLowerCase();

  const types = useMemo(
    () =>
      annotations.cellTypes
        .filter((t) => !q || (t.name ?? "").toLowerCase().includes(q))
        .sort(
          (a, b) =>
            Number(b.id === cell.cellTypeId) - Number(a.id === cell.cellTypeId) ||
            (a.name ?? "").localeCompare(b.name ?? "", undefined, { numeric: true })
        ),
    [annotations.cellTypes, q, cell.cellTypeId]
  );

  // Splitting a singleton would just be a rename, so only offer it when the
  // current type is shared.
  const canSplit = currentCount > 1;
  const splitName = query.trim() || `${current?.name ?? "Cell"} (split)`;
  const rowCount = types.length + (canSplit ? 1 : 0);
  const activeIdx = Math.min(active, Math.max(0, rowCount - 1));

  const choose = (idx: number) => {
    if (idx < types.length) {
      const t = types[idx];
      if (t.id === cell.cellTypeId) onClose();
      else onPick(t);
    } else if (canSplit) {
      onSplit(splitName);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(activeIdx + 1, rowCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rowCount > 0) choose(activeIdx);
    }
  };

  const cssX = viewport ? (anchor.x - viewport.originX) * viewport.zoom : 0;
  const cssY = viewport ? (anchor.y - viewport.originY) * viewport.zoom : 0;
  const popW = 300;
  const margin = 12;
  let left = cssX + margin;
  let top = cssY + margin;
  if (left + popW + 24 > bounds.w - margin) left = cssX - popW - 24 - margin;
  left = Math.max(margin, left);
  top = Math.max(margin, Math.min(top, bounds.h - 420));

  const label = { fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 4, display: "block" } as const;

  return (
    <div
      ref={popoverRef}
      className="dark"
      onKeyDown={onKeyDown}
      style={{
        position: "absolute",
        visibility: viewport ? "visible" : "hidden",
        left,
        top,
        zIndex: 1000,
        background: "#2a2a2e",
        border: "1px solid #444",
        borderRadius: 8,
        padding: 12,
        width: popW,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        color: "#ddd",
        fontSize: 13,
      }}
    >
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Cell type</span>
        <div style={{ fontSize: 11.5, color: "#bbb" }}>
          Current: {current?.name || "—"}
          {currentCount > 1 ? ` (shared by ${currentCount} instances)` : ""}
        </div>
      </div>

      <input
        className="input"
        type="text"
        placeholder="Filter types / name for new type…"
        value={query}
        autoFocus
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        style={{ width: "100%", boxSizing: "border-box", marginBottom: 8 }}
      />
      <div className="cell-type-picker-list" style={{ maxHeight: 200, marginBottom: 12 }}>
        {types.map((t, i) => (
          <div
            key={t.id}
            className={`cell-type-picker-row${i === activeIdx ? " active" : ""}`}
            onPointerEnter={() => setActive(i)}
            onClick={() => choose(i)}
          >
            <span className="cell-type-picker-name">
              {t.name || t.id.slice(0, 8)}
              {t.id === cell.cellTypeId ? " (current)" : ""}
            </span>
            <span className="cell-type-picker-meta">
              {t.cropRect.width}×{t.cropRect.height} · ×{counts.get(t.id) ?? 0}
            </span>
          </div>
        ))}
        {canSplit && (
          <div
            className={`cell-type-picker-row new${activeIdx === types.length ? " active" : ""}`}
            onPointerEnter={() => setActive(types.length)}
            onClick={() => choose(types.length)}
          >
            <span className="cell-type-picker-name">+ New type “{splitName}”</span>
            <span className="cell-type-picker-meta">split this instance</span>
          </div>
        )}
        {rowCount === 0 && <div className="cell-type-picker-empty">No matching types</div>}
      </div>

      {current && (
        <div style={{ marginBottom: 12 }}>
          <span style={label}>
            Color{currentCount > 1 ? ` (all ${currentCount} instances)` : ""}
          </span>
          <CellTypeColorBody
            cellType={current}
            cellTypes={annotations.cellTypes}
            onPick={(color) => onSetColor(current, color)}
          />
        </div>
      )}

      <span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button className="btn sm plain" onClick={onClose}>
          Close
        </button>
      </span>
    </div>
  );
}
