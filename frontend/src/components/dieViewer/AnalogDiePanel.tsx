/**
 * AnalogDiePanel.tsx — Analog device summary.
 *
 * Quick device count readout. SheetR config moved to SettingsPanel (Ctrl+,).
 */

import { useMemo } from "react";
import type { AnalogDevice, DieAnnotations } from "shared";
import { collectDieWideAnalogDevices } from "../../api/dieWideAnalog";

interface Props {
  annotations?: DieAnnotations | null | undefined;
  devices?: AnalogDevice[];
}

export function AnalogDiePanel({ annotations, devices: devicesProp }: Props) {
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

  const KIND_LABELS: Record<string, string> = {
    mos: "MOS", bjt_npn: "NPN", bjt_pnp: "PNP", jfet_n: "N-JFET", jfet_p: "P-JFET",
    resistor: "R", capacitor: "C", diode: "D",
  };

  return (
    <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--ink2)" }}>
      <span style={{ fontSize: 10, color: "var(--ink3)" }}>ANALOG DEVICES · {stats.total}</span>
      <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: "2px 8px" }}>
        {Object.entries(stats.byKind).map(([kind, count]) => (
          <span key={kind} style={{ fontSize: 10 }}>
            {KIND_LABELS[kind] ?? kind}: {count}
          </span>
        ))}
      </div>
    </div>
  );
}
