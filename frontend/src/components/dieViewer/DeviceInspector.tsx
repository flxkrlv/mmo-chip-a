/**
 * DeviceInspector.tsx — Shows analog device properties when clicked on the die.
 *
 * Appears in the die viewer when a device (Q1, M1, R1…) is selected.
 * Displays:
 *   - Device kind & instance name
 *   - Geometry parameters (W/L, AE, squares, etc.)
 *   - Terminal connection info
 *   - SPICE model name
 */

import type { AnalogDevice } from "shared";

interface Props {
  device: AnalogDevice;
  onClose: () => void;
}

/** Render a labelled property row. */
function Prop({ label, val }: { label: string; val: React.ReactNode }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      padding: "3px 0",
      fontSize: 11,
      borderBottom: "1px solid var(--l1, #333)",
    }}>
      <span style={{ color: "var(--ink3, #888)", minWidth: 70 }}>{label}</span>
      <span style={{ color: "var(--ink0, #eee)", fontFamily: "monospace", textAlign: "right" }}>
        {val}
      </span>
    </div>
  );
}

/** Section header. */
function Section({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: "6px 0 3px",
      fontSize: 9,
      fontWeight: 600,
      textTransform: "uppercase",
      letterSpacing: 0.8,
      color: "var(--ink3, #888)",
    }}>
      {children}
    </div>
  );
}

export function DeviceInspector({ device, onClose }: Props) {
  const g = device.geometry;

  const instanceLabel = device.instanceName ?? device.id;
  const kindLabel = device.kind.replace("_", " ").toUpperCase();

  return (
    <div style={{
      background: "var(--card, #1a1a1a)",
      borderLeft: "1px solid var(--l2, #333)",
      width: 280,
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        padding: "8px 12px",
        borderBottom: "1px solid var(--l2, #333)",
        gap: 8,
      }}>
        <div
          style={{
            width: 8, height: 8, borderRadius: "50%",
            background: DEV_KIND_COLOR(device.kind),
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>
          {instanceLabel}
        </span>
        <span style={{ fontSize: 10, color: "var(--ink3, #666)" }}>
          {kindLabel}
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "none", border: "none", color: "var(--ink3, #888)",
            cursor: "pointer", fontSize: 14, padding: "0 2px",
          }}
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: "8px 12px", overflow: "auto", flex: 1 }}>
        {/* Common properties */}
        <Section>Device</Section>
        <Prop label="Model" val={device.modelName ?? "—"} />
        <Prop label="Instance ID" val={device.id} />
        {device.cellTypeId && device.cellTypeId !== "die" && (
          <Prop label="Cell Type" val={device.cellTypeId} />
        )}

        {/* Geometry parameters by kind */}
        <Section>Geometry</Section>
        {renderGeometry(device)}

        {/* Terminals */}
        {device.terminals.length > 0 && (
          <>
            <Section>Terminals</Section>
            {device.terminals.map((t, i) => (
              <Prop
                key={t.name ?? i}
                label={t.name}
                val={t.netId >= 0 ? `net ${t.netId}` : "— (unconnected)"}
              />
            ))}
          </>
        )}

        {/* Comment */}
        {device.comment && (
          <>
            <Section>Comment</Section>
            <div style={{ fontSize: 11, color: "var(--ink2, #aaa)", padding: "3px 0" }}>
              {device.comment}
            </div>
          </>
        )}

        {/* BBox */}
        {device.bbox && (
          <>
            <Section>Position</Section>
            <Prop label="X" val={Math.round(device.bbox.x)} />
            <Prop label="Y" val={Math.round(device.bbox.y)} />
            <Prop label="W" val={Math.round(device.bbox.width)} />
            <Prop label="H" val={Math.round(device.bbox.height)} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Geometry rendering ───────────────────────────────────────────

function renderGeometry(dev: AnalogDevice): React.ReactNode {
  const g = dev.geometry;

  if ("mosType" in g) {
    // MOS
    const mg = g as {
      L_um: number; W_um: number; fingers?: number;
      multiplier?: number; totalW_um?: number; mosType?: string;
    };
    return (
      <>
        <Prop label="Type" val={mg.mosType ?? "unknown"} />
        <Prop label="W" val={`${mg.W_um.toFixed(2)} μm`} />
        <Prop label="L" val={`${mg.L_um.toFixed(3)} μm`} />
        {mg.fingers && mg.fingers > 1 && (
          <Prop label="Fingers" val={mg.fingers} />
        )}
        {mg.multiplier && mg.multiplier > 1 && (
          <Prop label="Multiplier" val={mg.multiplier} />
        )}
        {mg.totalW_um != null && (
          <Prop label="Total W" val={`${mg.totalW_um.toFixed(2)} μm`} />
        )}
      </>
    );
  }

  if ("bjtType" in g) {
    // BJT
    const bg = g as {
      AE_um2: number; PE_um?: number; multiplier?: number;
      totalAE_um2?: number; emitterFingers?: number; bjtType?: string;
    };
    return (
      <>
        <Prop label="Type" val={bg.bjtType ?? "unknown"} />
        <Prop label="Aₑ" val={`${bg.AE_um2.toFixed(4)} μm²`} />
        {bg.PE_um ? <Prop label="Pₑ" val={`${bg.PE_um.toFixed(3)} μm`} /> : null}
        {bg.emitterFingers && bg.emitterFingers > 1 && (
          <Prop label="Emitters" val={bg.emitterFingers} />
        )}
        {bg.multiplier && bg.multiplier > 1 && (
          <Prop label="Multiplier" val={bg.multiplier} />
        )}
        {bg.totalAE_um2 != null ? (
          <Prop label="Total Aₑ" val={`${bg.totalAE_um2.toFixed(4)} μm²`} />
        ) : null}
      </>
    );
  }

  if ("jfetType" in g) {
    // JFET
    const jg = g as {
      W_um: number; L_um: number; fingers?: number;
      multiplier?: number; jfetType?: string;
    };
    return (
      <>
        <Prop label="Type" val={jg.jfetType ?? "unknown"} />
        <Prop label="W" val={`${jg.W_um.toFixed(2)} μm`} />
        <Prop label="L" val={`${jg.L_um.toFixed(3)} μm`} />
        {jg.fingers && jg.fingers > 1 && <Prop label="Fingers" val={jg.fingers} />}
        {jg.multiplier && jg.multiplier > 1 && (
          <Prop label="Multiplier" val={jg.multiplier} />
        )}
      </>
    );
  }

  if ("squares" in g) {
    // Resistor
    const rg = g as {
      L_um: number; W_um: number; squares: number;
      resistance_ohms?: number; shape?: string;
      fingers?: number; multiplier?: number;
      resistorType?: string;
    };
    return (
      <>
        <Prop label="Type" val={rg.resistorType?.toUpperCase() ?? "POLY"} />
        <Prop label="L" val={`${rg.L_um.toFixed(2)} μm`} />
        <Prop label="W" val={`${rg.W_um.toFixed(2)} μm`} />
        <Prop label="Squares" val={rg.squares.toFixed(2)} />
        {rg.resistance_ohms ? (
          <Prop label="Resistance" val={`${rg.resistance_ohms.toFixed(0)} Ω`} />
        ) : null}
        {rg.shape && <Prop label="Shape" val={rg.shape} />}
        {rg.fingers && rg.fingers > 1 && <Prop label="Fingers" val={rg.fingers} />}
      </>
    );
  }

  if ("area_um2" in g && "capType" in g) {
    // Capacitor
    const cg = g as {
      area_um2: number; perimeter_um?: number;
      capacitance_fF?: number; multiplier?: number; capType?: string;
    };
    return (
      <>
        <Prop label="Area" val={`${cg.area_um2.toFixed(2)} μm²`} />
        {cg.perimeter_um ? <Prop label="Perimeter" val={`${cg.perimeter_um.toFixed(2)} μm`} /> : null}
        {cg.capacitance_fF ? <Prop label="Capacitance" val={`${cg.capacitance_fF.toFixed(3)} fF`} /> : null}
        {cg.capType && <Prop label="Type" val={cg.capType} />}
        {cg.multiplier && cg.multiplier > 1 && (
          <Prop label="Multiplier" val={cg.multiplier} />
        )}
      </>
    );
  }

  if ("diodeType" in g) {
    const dg = g as {
      area_um2: number; perimeter_um?: number;
      multiplier?: number; diodeType?: string;
    };
    return (
      <>
        <Prop label="Area" val={`${dg.area_um2.toFixed(2)} μm²`} />
        {dg.diodeType && <Prop label="Type" val={dg.diodeType} />}
        {dg.multiplier && dg.multiplier > 1 && (
          <Prop label="Multiplier" val={dg.multiplier} />
        )}
      </>
    );
  }

  return <div style={{ fontSize: 10, color: "var(--ink3, #666)" }}>Unknown geometry</div>;
}

// ── Colour helper ────────────────────────────────────────────────

const KIND_COLORS: Record<string, string> = {
  mos: "#4488ff",
  bjt_npn: "#44ff66",
  bjt_pnp: "#66ff88",
  resistor: "#ffaa44",
  capacitor: "#44ddff",
  diode: "#ff6666",
  jfet_n: "#88ffaa",
  jfet_p: "#44ffaa",
  unknown: "#888888",
};

function DEV_KIND_COLOR(kind: string): string {
  return KIND_COLORS[kind] ?? "#888";
}
