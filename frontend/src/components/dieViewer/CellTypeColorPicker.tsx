import { useEffect, useRef, useState } from "react";
import type { CellType } from "shared";
import { CELL_TYPE_PALETTE, colorOwner, nextFreeColor, normHex } from "../../lib/cellTypeColor";
import { SettingsPopover } from "./SettingsPopover";

/**
 * Swatch trigger (for a TreeRow's controls slot) that opens a per-cell-type
 * color picker. Colors are unique per die: palette swatches another type
 * already uses are disabled, and a custom color that clashes is refused.
 */
export function CellTypeColorPicker({
  cellType,
  cellTypes,
  fallbackColor,
  onPick
}: {
  cellType: CellType;
  /** Every cell type on the die — the uniqueness scope. */
  cellTypes: readonly CellType[];
  /** Shown on the trigger while the type has no color of its own. */
  fallbackColor: string;
  /** `undefined` clears the type's color (back to the global cell color). */
  onPick: (color: string | undefined) => void;
}) {
  const current = normHex(cellType.color);
  const trigger = (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: 2,
        display: "block",
        flex: "0 0 auto",
        background: current ?? fallbackColor,
        border: current ? "1px solid rgba(0,0,0,0.25)" : "1px dashed var(--ink3)"
      }}
    />
  );

  return (
    <SettingsPopover label={`Color of ${cellType.name || cellType.id}`} triggerContent={trigger}>
      <div className="u" style={{ marginBottom: 6, fontSize: 10 }}>
        Cell type color · {cellType.name || cellType.id}
      </div>
      <CellTypeColorBody cellType={cellType} cellTypes={cellTypes} onPick={onPick} />
    </SettingsPopover>
  );
}

/** Palette swatches (ones another type uses are disabled) + custom color +
 *  reset. Shared by the outline swatch popover and the cell-type window. */
export function CellTypeColorBody({
  cellType,
  cellTypes,
  onPick
}: {
  cellType: CellType;
  cellTypes: readonly CellType[];
  onPick: (color: string | undefined) => void;
}) {
  const current = normHex(cellType.color);
  const suggestion = nextFreeColor(cellTypes, cellType.id);
  const [draft, setDraft] = useState(current ?? suggestion ?? "#ffffff");
  useEffect(() => setDraft(current ?? suggestion ?? "#ffffff"), [current, suggestion]);
  const draftOwner = colorOwner(cellTypes, draft, cellType.id);

  // The native color input fires `input` continuously while dragging but
  // `change` only once on commit; React's onChange maps to `input`, so bind
  // `change` natively to avoid dispatching (and undo-stacking) every tick.
  const inputRef = useRef<HTMLInputElement>(null);
  const commitRef = useRef<(v: string) => void>(() => {});
  commitRef.current = (v: string) => {
    if (!colorOwner(cellTypes, v, cellType.id)) onPick(normHex(v) ?? undefined);
  };
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onChange = () => commitRef.current(el.value);
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  });

  return (
    <>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {CELL_TYPE_PALETTE.map((p) => {
          const owner = colorOwner(cellTypes, p.value, cellType.id);
          const active = current === p.value;
          return (
            <button
              key={p.value}
              type="button"
              disabled={!!owner}
              title={owner ? `${p.label} — used by ${owner.name || owner.id}` : p.label}
              aria-label={p.label}
              aria-pressed={active}
              onClick={() => onPick(p.value)}
              style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                padding: 0,
                cursor: owner ? "not-allowed" : "pointer",
                background: p.value,
                opacity: owner ? 0.25 : 1,
                border: active ? "2px solid var(--ink)" : "2px solid transparent",
                boxShadow: active ? "0 0 0 1px var(--l2)" : "none"
              }}
            />
          );
        })}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center" }}>
        <input
          ref={inputRef}
          type="color"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          title="Pick a custom color"
          style={{
            width: 28,
            height: 22,
            padding: 0,
            cursor: "pointer",
            border: "1px solid var(--l2)",
            borderRadius: 3,
            background: "none"
          }}
        />
        <span style={{ fontSize: 10, color: draftOwner ? "var(--err)" : "var(--ink3)", flex: "1 1 auto" }}>
          {draftOwner ? `Already used by ${draftOwner.name || draftOwner.id}` : "Custom color"}
        </span>
        {current && (
          <button className="btn" style={{ fontSize: 10 }} onClick={() => onPick(undefined)}>
            ↺ default
          </button>
        )}
      </div>
    </>
  );
}
