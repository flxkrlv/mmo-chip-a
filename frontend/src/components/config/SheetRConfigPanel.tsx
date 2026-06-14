/**
 * SheetRConfigPanel.tsx — Configuration panel for per-type sheet resistance.
 *
 * Lets the user set Ω/□ for each resistor material type (poly, hsr, pb, npl, film).
 * Values are persisted in usePreferences and passed to SPICE export via SpiceConfig.
 */

import { useMemo } from "react";
import type { ResistorType } from "shared";
import {
  DEFAULT_SHEET_R,
  RESISTOR_TYPE_LABELS,
} from "../../lib/export/resistorDefaults";
import { usePreferences } from "../../state/preferences";

/** Ordered list of resistor types for the form. */
const RESISTOR_TYPES: ResistorType[] = ["poly", "hsr", "pb", "npl", "film"];

/**
 * Read current sheetR overrides from preferences.
 * Returns the full Record<string,number> (may be partial).
 */
const _EMPTY_SR: Record<string, number> = {};
function useSheetR(): Record<string, number> {
  const val = usePreferences((s) => (s as any).sheetR);
  return val ?? _EMPTY_SR;
}

/**
 * Write a single sheetR value.
 */
function setSheetR(type: string, value: number) {
  usePreferences.setState((s: any) => ({
    sheetR: { ...(s.sheetR ?? {}), [type]: value },
  }));
}

interface Props {
  /** Compact mode — inline in the side panel. */
  compact?: boolean;
}

export function SheetRConfigPanel({ compact }: Props) {
  const sheetR = useSheetR();

  // Compute resistance from squares × sheetR for a preview
  const totalDescription = useMemo(() => {
    const parts: string[] = [];
    for (const t of RESISTOR_TYPES) {
      const val = sheetR[t] ?? DEFAULT_SHEET_R[t];
      parts.push(`${t}=${val}Ω/□`);
    }
    return parts.join(" · ");
  }, [sheetR]);

  if (compact) {
    return (
      <div style={{ fontSize: 10, color: "var(--ink2)", lineHeight: 1.6 }}>
        <div
          style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}
        >
          <span style={{ fontWeight: 600, color: "var(--ink)", fontSize: 9.5 }}>
            SHEET RESISTANCE (Ω/□)
          </span>
        </div>
        {RESISTOR_TYPES.map((t) => {
          const val = sheetR[t] ?? DEFAULT_SHEET_R[t];
          const label = RESISTOR_TYPE_LABELS[t];
          return (
            <div
              key={t}
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
                title={label}
              >
                {t}
              </span>
              <input
                type="number"
                min={1}
                max={100000}
                value={val}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v > 0) setSheetR(t, v);
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
              <span style={{ fontSize: 9, color: "var(--ink3)" }}>Ω/□</span>
              {sheetR[t] != null && sheetR[t] !== DEFAULT_SHEET_R[t] && (
                <button
                  type="button"
                  title="Reset to default"
                  onClick={() => setSheetR(t, DEFAULT_SHEET_R[t])}
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
          );
        })}
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
          {totalDescription}
        </div>
      </div>
    );
  }

  // Full mode (not used yet, but extensible)
  return (
    <div style={{ padding: "8px 12px", fontSize: 11 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Sheet Resistance</div>
      {RESISTOR_TYPES.map((t) => {
        const val = sheetR[t] ?? DEFAULT_SHEET_R[t];
        return (
          <div key={t} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <label style={{ width: 80 }}>{t}</label>
            <input
              type="number"
              value={val}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v > 0) setSheetR(t, v);
              }}
              style={{ width: 80 }}
            />
            <span>Ω/□</span>
          </div>
        );
      })}
    </div>
  );
}

/** Build a SpiceConfig-compatible sheetR_ohms from preferences + defaults. */
export function buildSheetRConfig(): Record<string, number> {
  const prefs = usePreferences.getState() as any;
  const overrides: Record<string, number> = prefs.sheetR ?? {};
  const result: Record<string, number> = {};
  for (const t of RESISTOR_TYPES) {
    result[t] = overrides[t] ?? DEFAULT_SHEET_R[t];
  }
  return result;
}
