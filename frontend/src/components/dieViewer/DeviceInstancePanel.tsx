/**
 * DeviceInstancePanel.tsx — Device list for the die viewer right panel.
 *
 * Shows all analog devices grouped by kind, with color swatches and
 * geometry parameters. Click selects + frames the device; double-click
 * opens RE Cell.
 *
 * Reuses the visual pattern from the netlist page's InstanceOutline.
 */

import { useCallback, useMemo, useState } from "react";
import type { AnalogDevice, DeviceGeometry, DeviceKind } from "shared";
import { TreeRow, TreeSep } from "../tree/TreeRow";

// ── Color swatches per device kind ─────────────────────────────

const KIND_SWATCH: Record<string, string> = {
  mos: "#6dd679",
  bjt_npn: "#82d6a6",
  bjt_pnp: "#f5d68a",
  jfet_n: "#68c4d4",
  jfet_p: "#68c4d4",
  resistor: "#e36854",
  capacitor: "#d4a06a",
  diode: "#c87dc8",
  unknown: "#999",
};

const KIND_TITLES: Record<string, string> = {
  mos: "MOS transistors",
  bjt_npn: "NPN BJTs",
  bjt_pnp: "PNP BJTs",
  jfet_n: "N-JFETs",
  jfet_p: "P-JFETs",
  resistor: "Resistors",
  capacitor: "Capacitors",
  diode: "Diodes",
  unknown: "Other devices",
};

// ── Helpers ────────────────────────────────────────────────────

function deviceMeta(dev: AnalogDevice): string {
  const g = dev.geometry as any;
  switch (dev.kind) {
    case "mos": {
      const type = g.mosType === "pmos" ? "PMOS" : "NMOS";
      const W = g.W_um?.toFixed(1);
      const L = g.L_um?.toFixed(2);
      return `${type} W=${W} L=${L}`;
    }
    case "bjt_npn":
    case "bjt_pnp": {
      const type = dev.kind === "bjt_npn" ? "NPN" : "PNP";
      if (g.PE_um && dev.kind === "bjt_pnp") {
        return `${type} PE=${g.PE_um.toFixed(1)}µm`;
      }
      if (g.AE_um2) {
        const ae = g.AE_um2.toFixed(2);
        const m = g.multiplier && g.multiplier > 1 ? ` ×${g.multiplier}` : "";
        return `${type} AE=${ae}µm²${m}`;
      }
      return type;
    }
    case "resistor": {
      const type = (g.resistorType ?? "poly").toUpperCase();
      if (g.squares) return `${type} □${g.squares.toFixed(1)}`;
      if (g.resistance_ohms) return `${type} ${g.resistance_ohms.toFixed(0)}Ω`;
      return type;
    }
    case "capacitor": {
      if (g.capacitance_fF) return `${g.capacitance_fF.toFixed(2)}fF`;
      return "cap";
    }
    case "diode": return "diode";
    default: return dev.kind;
  }
}

// ── Component ──────────────────────────────────────────────────

interface Props {
  devices: AnalogDevice[];
  selectedDevice: AnalogDevice | null;
  onSelectDevice: (dev: AnalogDevice) => void;
  onDoubleClickDevice: (dev: AnalogDevice) => void;
}

export function DeviceInstancePanel({
  devices,
  selectedDevice,
  onSelectDevice,
  onDoubleClickDevice,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = useCallback((kind: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  // Group devices by kind
  const groups = useMemo(() => {
    const byKind = new Map<string, AnalogDevice[]>();
    for (const dev of devices) {
      const list = byKind.get(dev.kind) ?? [];
      list.push(dev);
      byKind.set(dev.kind, list);
    }
    // Sort: MOS first, then BJT, then R, C, D, rest
    const order: DeviceKind[] = ["mos", "bjt_npn", "bjt_pnp", "resistor", "capacitor", "diode"];
    const entries = Array.from(byKind.entries());
    entries.sort((a, b) => {
      const ia = order.indexOf(a[0] as DeviceKind);
      const ib = order.indexOf(b[0] as DeviceKind);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    return entries;
  }, [devices]);

  const totalDevices = devices.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ph" style={{ padding: "2px 10px", flexShrink: 0 }}>
        <span
          className="m"
          style={{
            fontSize: 10, fontWeight: 600,
            color: "var(--ink2)", letterSpacing: 0.6,
          }}
        >
          INSTANCES · {totalDevices}
        </span>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {groups.length === 0 ? (
          <div style={{ padding: "12px", fontSize: 11, color: "var(--ink3)", textAlign: "center" }}>
            no analog devices
          </div>
        ) : (
          groups.map(([kind, list], gi) => {
            const isCollapsed = collapsed.has(kind);
            const title = KIND_TITLES[kind] ?? kind;
            return (
              <div key={kind}>
                {gi > 0 && <TreeSep />}
                <TreeRow
                  expand={isCollapsed ? "closed" : "open"}
                  label={title}
                  meta={String(list.length)}
                  onToggleExpand={() => toggle(kind)}
                  onSelect={() => toggle(kind)}
                />
                {!isCollapsed &&
                  list.map((dev) => {
                    const name = dev.instanceName ?? dev.id;
                    const meta = deviceMeta(dev);
                    const selected = selectedDevice === dev;
                    return (
                      <TreeRow
                        key={name}
                        depth={1}
                        swatch={KIND_SWATCH[kind] ?? "#666"}
                        label={name}
                        meta={meta}
                        monoLabel
                        selected={selected}
                        onSelect={() => onSelectDevice(dev)}
                        onDoubleClick={() => onDoubleClickDevice(dev)}
                      />
                    );
                  })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
