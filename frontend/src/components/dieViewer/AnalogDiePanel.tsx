/**
 * AnalogDiePanel.tsx — Analog device summary + SheetR config.
 *
 * Stripped down: no die-level layers, no "Scan all cells" (replaced by
 * Netlist tab), no CDL preview (duplicated). Keeps SheetR config and
 * a quick device count readout.
 */

import { useMemo, useState } from "react";
import type { AnalogDevice, DieAnnotations } from "shared";
import { collectDieWideAnalogDevices } from "../../api/dieWideAnalog";
import { SheetRConfigPanel } from "../config/SheetRConfigPanel";
import { usePreferences } from "../../state/preferences";

interface Props {
  annotations?: DieAnnotations | null | undefined;
  devices?: AnalogDevice[];
}

export function AnalogDiePanel({ annotations, devices: devicesProp }: Props) {
  const [sheetROpen, setSheetROpen] = useState(false);

  // Reactive sheetR from preferences (NOT getState — subscribes properly)
  const sheetR = usePreferences((s) => (s as any).sheetR ?? {});

  // Compute device stats from prop (preferred) or fallback to sync extraction.
  const stats = useMemo(() => {
    if (devicesProp) {
      const byKind: Record<string, number> = {};
      for (const d of devicesProp) {
        byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
      }
      return { total: devicesProp.length, byKind };
    }
    if (!annotations) return null;
    try {
      const { devices } = collectDieWideAnalogDevices(annotations, annotations.umPerPx ?? 1);
      const byKind: Record<string, number> = {};
      for (const d of devices) {
        byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
      }
      return { total: devices.length, byKind };
    } catch {
      return null;
    }
  }, [annotations, devicesProp]);

  if (!annotations || !stats || stats.total === 0) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--ink3)", fontStyle: "italic" }}>
        Open the <b>Netlist (Analog)</b> tab to view detected devices.
      </div>
    );
  }

  const umPerPx = annotations.umPerPx ?? 1.0;

  return (
    <div style={{ padding: "8px 12px", fontSize: 11 }}>
      {/* um/px read-only */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: "var(--ink3)" }}>Scale</span>
        <span className="m" style={{ fontSize: 10 }}>{umPerPx.toFixed(4)} µm/px</span>
      </div>

      {/* SheetR config — reactive */}
      <div
        style={{
          fontSize: 10, fontWeight: 600, color: "var(--ink3)",
          cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
        }}
        onClick={() => setSheetROpen((v) => !v)}
      >
        {sheetROpen ? "▼" : "▶"} SHEET RESISTANCE
      </div>
      {sheetROpen && (
        <div style={{ marginTop: 4 }}>
          <SheetRConfigPanel compact />
        </div>
      )}
    </div>
  );
}
