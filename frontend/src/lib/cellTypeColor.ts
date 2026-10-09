import type { CellType } from "shared";

/** Preset per-cell-type colors: well-separated hues so neighbouring types stay
 *  distinguishable on the die. Deliberately avoids the amber selection accent. */
export const CELL_TYPE_PALETTE: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Red", value: "#ef4444" },
  { label: "Orange", value: "#f97316" },
  { label: "Lime", value: "#84cc16" },
  { label: "Green", value: "#22c55e" },
  { label: "Teal", value: "#14b8a6" },
  { label: "Cyan", value: "#06b6d4" },
  { label: "Blue", value: "#3b82f6" },
  { label: "Indigo", value: "#6366f1" },
  { label: "Violet", value: "#8b5cf6" },
  { label: "Fuchsia", value: "#d946ef" },
  { label: "Pink", value: "#ec4899" },
  { label: "Brown", value: "#a16207" }
];

/** Lower-cased #rrggbb, or null when `c` isn't a 6-digit hex color. */
export function normHex(c: string | null | undefined): string | null {
  if (!c) return null;
  const v = c.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

/** The other cell type already using `color`, if any (the uniqueness rule). */
export function colorOwner(
  cellTypes: readonly CellType[],
  color: string,
  exceptId: string
): CellType | null {
  const want = normHex(color);
  if (!want) return null;
  return cellTypes.find((ct) => ct.id !== exceptId && normHex(ct.color) === want) ?? null;
}

/** First palette color no other type uses, else null (palette exhausted). */
export function nextFreeColor(cellTypes: readonly CellType[], exceptId: string): string | null {
  return CELL_TYPE_PALETTE.find((p) => !colorOwner(cellTypes, p.value, exceptId))?.value ?? null;
}
