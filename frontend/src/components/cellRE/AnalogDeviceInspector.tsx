/**
 * AnalogDeviceInspector.tsx — Inspector panel for analog devices.
 *
 * Shows in the right panel when the user selects a detected analog device
 * (MOS, BJT, JFET, resistor, capacitor, diode). Displays:
 *   - Device kind icon + name
 *   - Extracted geometry parameters (W/L, AE, R, C, etc.)
 *   - Terminal connections (net ids)
 *   - Model name override input
 *   - Ability to mark as "confirmed" / "rejected"
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnalogDevice, DeviceKind, DeviceGeometry, SpiceConfig } from "shared";

// ── Device kind display names ────────────────────────────────────

const KIND_NAME: Record<DeviceKind, string> = {
  mos: "MOS Transistor",
  bjt_npn: "NPN Bipolar",
  bjt_pnp: "PNP Bipolar",
  jfet_n: "N-JFET",
  jfet_p: "P-JFET",
  resistor: "Resistor",
  capacitor: "Capacitor",
  diode: "Diode",
  zener: "Zener Diode",
  schottky: "Schottky Diode",
  inductor: "Inductor",
  unknown: "Unknown Device",
};

const KIND_EMOJI: Record<DeviceKind, string> = {
  mos: "🔼",
  bjt_npn: "🔺",
  bjt_pnp: "🔻",
  jfet_n: "▲",
  jfet_p: "▼",
  resistor: "〰️",
  capacitor: "‖‖",
  diode: "▶",
  zener: "⏸",
  schottky: "⏩",
  inductor: "◠◡",
  unknown: "❓",
};

// ── Parameter display helper ─────────────────────────────────────

interface ParamEntry {
  label: string;
  value: string;
  unit?: string;
}

function deviceParams(device: AnalogDevice): ParamEntry[] {
  const g = device.geometry as unknown as Record<string, unknown>;
  const entries: ParamEntry[] = [];

  switch (device.kind) {
    case "mos":
      entries.push({ label: "Type", value: g.mosType as string ?? "?" });
      entries.push({ label: "W", value: (g.W_um as number)?.toFixed(2), unit: "μm" });
      entries.push({ label: "L", value: (g.L_um as number)?.toFixed(3), unit: "μm" });
      entries.push({ label: "Fingers", value: String(g.fingers ?? 1) });
      entries.push({ label: "Multiplier", value: String(g.multiplier ?? 1) });
      entries.push({ label: "Total W", value: (g.totalW_um as number)?.toFixed(2), unit: "μm" });
      break;
    case "bjt_npn":
    case "bjt_pnp":
      entries.push({ label: "Type", value: g.bjtType as string ?? "?" });
      entries.push({ label: "AE", value: (g.AE_um2 as number)?.toFixed(2), unit: "μm²" });
      entries.push({ label: "PE", value: (g.PE_um as number)?.toFixed(2), unit: "μm" });
      entries.push({ label: "Fingers", value: String(g.emitterFingers ?? 1) });
      entries.push({ label: "Multiplier", value: String(g.multiplier ?? 1) });
      entries.push({ label: "Total AE", value: (g.totalAE_um2 as number)?.toExponential(2), unit: "μm²" });
      break;
    case "jfet_n":
    case "jfet_p":
      entries.push({ label: "Type", value: g.jfetType as string ?? "?" });
      entries.push({ label: "W", value: (g.W_um as number)?.toFixed(2), unit: "μm" });
      entries.push({ label: "L", value: (g.L_um as number)?.toFixed(3), unit: "μm" });
      entries.push({ label: "Fingers", value: String(g.fingers ?? 1) });
      break;
    case "resistor":
      entries.push({ label: "L", value: (g.L_um as number)?.toFixed(2), unit: "μm" });
      entries.push({ label: "W", value: (g.W_um as number)?.toFixed(2), unit: "μm" });
      entries.push({ label: "Squares", value: (g.squares as number)?.toFixed(1) });
      entries.push({ label: "Sheet R", value: g.sheetR_ohms != null ? String(g.sheetR_ohms) : "—", unit: "Ω/□" });
      entries.push({ label: "Resistance", value: g.resistance_ohms != null ? String((g.resistance_ohms as number).toFixed(1)) : "—", unit: "Ω" });
      entries.push({ label: "Shape", value: g.shape as string ?? "?" });
      entries.push({ label: "Fingers", value: String(g.fingers ?? 1) });
      break;
    case "capacitor":
      entries.push({ label: "Area", value: (g.area_um2 as number)?.toFixed(2), unit: "μm²" });
      entries.push({ label: "Perimeter", value: (g.perimeter_um as number)?.toFixed(2), unit: "μm" });
      entries.push({ label: "Type", value: g.capType as string ?? "?" });
      entries.push({ label: "Cap Density", value: g.capDensity_fF != null ? String(g.capDensity_fF) : "—", unit: "fF/μm²" });
      entries.push({ label: "Capacitance", value: g.capacitance_fF != null ? String((g.capacitance_fF as number).toFixed(2)) : "—", unit: "fF" });
      break;
    case "diode":
    case "zener":
    case "schottky":
      entries.push({ label: "Area", value: (g.area_um2 as number)?.toFixed(2), unit: "μm²" });
      entries.push({ label: "Perimeter", value: (g.perimeter_um as number)?.toFixed(2), unit: "μm" });
      entries.push({ label: "Multiplier", value: String(g.multiplier ?? 1) });
      break;
  }

  return entries;
}

// ═════════════════════════════════════════════════════════════════
// Component
// ═════════════════════════════════════════════════════════════════

const STYLE = {
  section: {
    padding: "8px 12px",
    borderBottom: "1px solid var(--border, #333)",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 6,
  } as React.CSSProperties,
  paramRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "2px 0",
    fontSize: 11,
    fontFamily: "monospace",
  } as React.CSSProperties,
  label: { color: "var(--ink3, #999)" } as React.CSSProperties,
  value: { color: "var(--ink0, #eee)" } as React.CSSProperties,
  terminal: {
    display: "flex",
    justifyContent: "space-between",
    padding: "2px 0",
    fontSize: 11,
  } as React.CSSProperties,
  chip: {
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: 3,
    fontSize: 10,
    fontWeight: 600,
  } as React.CSSProperties,
};

interface Props {
  device: AnalogDevice;
  /** Optional spice config for overriding model names */
  spiceConfig?: SpiceConfig;
  onModelChange?: (deviceId: string, modelName: string) => void;
  onClose?: () => void;
}

export function AnalogDeviceInspector({ device, spiceConfig, onModelChange, onClose }: Props): React.ReactElement | null {
  const [modelOverride, setModelOverride] = useState<string>(device.modelName ?? "");
  const params = useMemo(() => deviceParams(device), [device]);

  const handleModelChange = useCallback(() => {
    if (modelOverride.trim() && modelOverride !== (device.modelName ?? "")) {
      onModelChange?.(device.id, modelOverride.trim());
    }
  }, [modelOverride, device.id, device.modelName, onModelChange]);

  return (
    <div style={STYLE.section}>
      {/* Header */}
      <div style={STYLE.header}>
        <span style={{ fontSize: 16 }}>{KIND_EMOJI[device.kind]}</span>
        <span>{device.instanceName ?? device.id}</span>
        <span style={{ color: "var(--ink3, #999)", fontWeight: 400, fontSize: 11 }}>
          {KIND_NAME[device.kind]}
        </span>
      </div>

      {/* Parameters */}
      <div>
        {params.map((p: ParamEntry) => (
          <div key={p.label} style={STYLE.paramRow}>
            <span style={STYLE.label}>{p.label}</span>
            <span style={STYLE.value}>
              {p.value}{p.unit ? <span style={{ color: "var(--ink3, #999)", marginLeft: 2 }}>{p.unit}</span> : null}
            </span>
          </div>
        ))}
      </div>

      {/* Terminals */}
      {device.terminals.length > 0 && (
        <>
          <div style={{ ...STYLE.paramRow, marginTop: 8, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>
            <span style={{ color: "var(--ink3, #999)" }}>Terminals</span>
          </div>
          {device.terminals.map((t: { name: string; netId: number }) => (
            <div key={t.name} style={STYLE.terminal}>
              <span style={STYLE.label}>{t.name}</span>
              <span>
                <span style={{
                  ...STYLE.chip,
                  background: t.netId >= 0 ? "rgba(68,136,255,0.2)" : "rgba(255,0,0,0.15)",
                  color: t.netId >= 0 ? "#6af" : "#f66",
                }}>
                  {t.netId >= 0 ? `net${t.netId}` : "unconn"}
                </span>
              </span>
            </div>
          ))}
        </>
      )}

      {/* Model override */}
      {device.kind !== "resistor" && device.kind !== "capacitor" && (
        <div style={{ marginTop: 8 }}>
          <div style={{ ...STYLE.paramRow, marginBottom: 2 }}>
            <span style={STYLE.label}>Model</span>
            <input
              value={modelOverride || device.modelName || ""}
              onChange={(e) => setModelOverride(e.target.value)}
              onBlur={handleModelChange}
              onKeyDown={(e) => e.key === "Enter" && handleModelChange()}
              placeholder={device.modelName ?? "auto"}
              style={{
                background: "var(--bg1, #222)",
                border: "1px solid var(--border, #444)",
                borderRadius: 3,
                color: "var(--ink0, #eee)",
                fontSize: 11,
                padding: "2px 6px",
                width: 120,
                textAlign: "right",
                fontFamily: "monospace",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
