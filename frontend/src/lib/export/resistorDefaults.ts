/**
 * resistorDefaults.ts — Default sheet resistance values per resistor type.
 * Can be overridden in SpiceConfig by the user via SheetR GUI.
 */

import type { ResistorType } from "shared";

/** Default sheet resistance Ω/□ per resistor material type. */
export const DEFAULT_SHEET_R: Record<ResistorType, number> = {
  poly: 25,    // polysilicon
  hsr:  1500,  // high sheet R (ion implanted)
  pb:   200,   // p base (base diffusion)
  npl:  5,     // n+ diffusion
  film: 500,   // thin film
};

/** SPICE parameter name for each resistor type (used in sqRs format). */
export const RESISTOR_PARAM_NAMES: Record<ResistorType, string> = {
  poly: "Rp",
  hsr:  "Rhsr",
  pb:   "Rbase",
  npl:  "Rnpl",
  film: "Rfilm",
};

/** Human-readable labels for each type. */
export const RESISTOR_TYPE_LABELS: Record<ResistorType, string> = {
  poly: "Poly Si",
  hsr:  "HSR (ion implanted)",
  pb:   "P Base",
  npl:  "N Plus",
  film: "Thin Film",
};

/** Get effective sheetR for a resistor: user override → type default → 0. */
export function effectiveSheetR(
  type: ResistorType | undefined,
  userOverrides?: Record<string, number>,
): number {
  if (!type) type = "poly";
  if (userOverrides?.[type] != null) return userOverrides[type];
  return DEFAULT_SHEET_R[type] ?? 0;
}
