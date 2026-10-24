/**
 * CapDensityConfigPanel.tsx → Configuration panel for the specific capacitance.
 *
 * Lets the user set the capacitance density [fF/μm²] used for every
 * capacitor: C = area × density. The value is persisted in usePreferences
 * and passed to the SPICE export via SpiceConfig → the same way the sheet
 * resistance works for resistors.
 */

import { usePreferences } from "../../state/preferences";
import {
  DEFAULT_CAP_DENSITY,
  effectiveCapDensity,
} from "../../lib/export/capacitorDefaults";

interface Props {
  /** Compact mode → inline in the settings modal. */
  compact?: boolean;
}

export function CapDensityConfigPanel({ compact }: Props) {
  const capDensity = usePreferences((s) => s.capDensity);
  const setCapDensity = usePreferences((s) => s.setCapDensity);

  const value = effectiveCapDensity(capDensity);

  return (
    <div style={{ fontSize: 10, color: "var(--ink2)", lineHeight: 1.6 }}>
      <div
        style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}
      >
        <span style={{ fontWeight: 600, color: "var(--ink)", fontSize: 9.5 }}>
          SPECIFIC CAPACITANCE (fF/μm²)
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "1px 0",
        }}
      >
        <span
          style={{
            width: compact ? 50 : 70,
            flex: "0 0 auto",
            fontSize: 9.5,
            fontFamily: "var(--mono)",
          }}
          title="Capacitance per unit area"
        >
          density
        </span>
        <input
          type="number"
          min={0.001}
          max={1000}
          step={0.1}
          value={value}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v) && v > 0) setCapDensity(v);
          }}
          style={{
            width: 70,
            height: 20,
            fontSize: 10,
            fontFamily: "var(--mono)",
            textAlign: "right",
            background: "var(--l1)",
            border: "1px solid var(--l2)",
            borderRadius: 3,
            color: "var(--ink)",
            padding: "0 4px",
          }}
        />
        <span style={{ fontSize: 9, color: "var(--ink3)" }}>fF/μm²</span>
        {capDensity !== DEFAULT_CAP_DENSITY && (
          <button
            type="button"
            title="Reset to default"
            onClick={() => setCapDensity(DEFAULT_CAP_DENSITY)}
            style={{
              background: "transparent",
              border: 0,
              cursor: "pointer",
              color: "var(--ink3)",
              fontSize: 9,
              padding: 0,
              marginLeft: "auto",
            }}
          >
            ↺
          </button>
        )}
      </div>
      <div
        className="m"
        style={{
          marginTop: 4,
          fontSize: 8.5,
          color: "var(--ink3)",
          borderTop: "1px solid var(--l1)",
          paddingTop: 4,
        }}
      >
        C = area × {value} fF/μm²
      </div>
    </div>
  );
}

/** Build a SpiceConfig-compatible specific capacitance from the preferences. */
export function buildCapDensityConfig(): number {
  return effectiveCapDensity(usePreferences.getState().capDensity);
}
