/**
 * capacitorDefaults.ts — Specific capacitance (capacitance density) helpers.
 *
 * The user edits ONE number in Settings → RE Cell Settings: the specific
 * capacitance per unit area [fF/μm²]. Every capacitor's capacitance is
 * then derived from its plate area:
 *
 *     C [fF] = area [μm²] × density [fF/μm²]
 *
 * This mirrors resistorDefaults.ts: the value lives in usePreferences (persisted
 * to localStorage) and reaches the netlist generator through SpiceConfig. Just
 * like the sheet resistance, the capacitance is resolved where the netlist is
 * written — the extracted geometry keeps the raw plate area.
 */

/** Default specific capacitance per unit area [fF/μm²]. */
export const DEFAULT_CAP_DENSITY = 1;

/**
 * Effective specific capacitance: the user's value → the default.
 * A missing, zero or negative value falls back to the default.
 */
export function effectiveCapDensity(user?: number | null): number {
  if (user != null && Number.isFinite(user) && user > 0) return user;
  return DEFAULT_CAP_DENSITY;
}

/**
 * Capacitance of a capacitor [fF].
 *
 * The plate area and the specific capacitance give the value. A capacitance
 * the user pinned by hand (an override in the Cell RE panel) wins over the
 * derived one.
 */
export function effectiveCapacitance(
  geom: { area_um2?: number; capacitance_fF?: number } | undefined,
  density?: number | null,
  overridden = false,
): number | undefined {
  if (overridden && geom?.capacitance_fF != null) return geom.capacitance_fF;
  const area = geom?.area_um2 ?? 0;
  if (area > 0) return area * effectiveCapDensity(density);
  return geom?.capacitance_fF;
}
