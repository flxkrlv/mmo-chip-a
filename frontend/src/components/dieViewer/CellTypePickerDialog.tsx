import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Cell, CellType, DieAnnotations } from "shared";

/**
 * Popup opened by double-clicking a placed cell on the die: reassigns that
 * cell to another existing cell type, or splits it off into a fresh type
 * (a clone of its current one, so the RE'd layers carry over).
 */
export function CellTypePickerDialog({
  cell,
  annotations,
  onPick,
  onSplit,
  onClose
}: {
  cell: Cell;
  annotations: DieAnnotations;
  onPick: (cellType: CellType) => void;
  onSplit: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

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

  return createPortal(
    <div
      className="dark dialog-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="popover dialog-box" onPointerDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">Change cell type</div>
        <div className="dialog-message">
          Current: {current?.name || "—"}
          {currentCount > 1 ? ` (shared by ${currentCount} instances)` : ""}
        </div>
        <input
          className="dialog-input"
          type="text"
          placeholder="Filter types / name for new type…"
          value={query}
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <div className="cell-type-picker-list">
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
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
