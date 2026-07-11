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

import { useState, useCallback, type ChangeEvent } from "react";
import type { AnalogDevice, ResistorType } from "shared";
import { effectiveSheetR } from "../../lib/export/resistorDefaults";
import { usePreferences } from "../../state/preferences";
import { renameDeviceInstance, validateDeviceName } from "../../api/dieWideAnalog";

interface Props {
  device: AnalogDevice;
  onClose: () => void;
  cellTypeCounts?: Map<string, number>;
  cellTypeByCellId?: Map<string, string>;
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

export function DeviceInspector({ device, onClose, cellTypeCounts, cellTypeByCellId }: Props) {
  const g = device.geometry;
  const uuid = (device as any)._uuid as string | undefined;

  const instanceLabel = device.instanceName ?? device.id;
  const kindLabel = device.kind.replace("_", " ").toUpperCase();

  // ── Rename state ──────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(instanceLabel);
  const [err, setErr] = useState("");

  const handleRename = useCallback(() => {
    if (!uuid) return;
    const s = draft.trim();
    if (!s || s === instanceLabel) { setEditing(false); setErr(""); return; }

    const validationErr = validateDeviceName(uuid, s);
    if (validationErr) { setErr(validationErr); return; }

    renameDeviceInstance(uuid, s);
    // Immediate visual feedback — mutate the device object directly
    (device as any).instanceName = s;
    setEditing(false);
    setErr("");
  }, [uuid, draft, instanceLabel, device]);

  const handleCancel = useCallback(() => {
    setEditing(false);
    setDraft(instanceLabel);
    setErr("");
  }, [instanceLabel]);

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
        {editing ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="text"
                value={draft}
                onChange={(e: ChangeEvent<HTMLInputElement>) => { setDraft(e.target.value); setErr(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") handleCancel(); }}
                autoFocus
                style={{
                  flex: 1, height: 22, fontSize: 12, fontFamily: "var(--mono)",
                  background: "var(--bg1)", border: "1px solid var(--accent)",
                  borderRadius: 3, color: "var(--ink0)", padding: "0 4px",
                }}
              />
              <span onClick={handleRename} style={{ cursor: "pointer", fontSize: 12, color: "var(--accent)" }}>✓</span>
              <span onClick={handleCancel} style={{ cursor: "pointer", fontSize: 12, color: "var(--ink3)" }}>✕</span>
            </div>
            {err && <div style={{ fontSize: 9, color: "var(--err)" }}>{err}</div>}
          </div>
        ) : (
          <>
            <span
              style={{ fontWeight: 600, fontSize: 13, flex: 1, cursor: "pointer" }}
              onDoubleClick={() => { setDraft(instanceLabel); setEditing(true); setErr(""); }}
              title="Double-click to rename"
            >
              {instanceLabel}
            </span>
            {uuid && (
              <span
                onClick={() => { setDraft(instanceLabel); setEditing(true); setErr(""); }}
                style={{ cursor: "pointer", fontSize: 10, color: "var(--ink3, #666)", padding: "0 2px" }}
                title="Rename"
              >
                ✎
              </span>
            )}
          </>
        )}
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
        {cellTypeCounts && cellTypeByCellId && (() => {
          const cellId = (device as any)._cellId as string | undefined;
          if (!cellId) return null;
          const ctId = cellTypeByCellId.get(cellId);
          if (!ctId) return null;
          const count = cellTypeCounts.get(ctId) ?? 1;
          const label = count > 1 ? `Linked (×${count})` : "Unique";
          return <Prop label="Relationship" val={label} />;
        })()}

        {/* Geometry parameters by kind */}
        <Section>Geometry</Section>
        {renderGeometry(device)}

        {/* Terminal section removed — was duplicating net info not useful here */}

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
    // Resistor — compute resistance from current sheetR config
    const rg = g as {
      L_um: number; W_um: number; squares: number;
      resistance_ohms?: number; shape?: string;
      fingers?: number; multiplier?: number;
      resistorType?: string;
    };
    const sheetROverrides = usePreferences.getState().sheetR ?? {};
    const sr = effectiveSheetR(rg.resistorType as ResistorType, sheetROverrides);
    const resistance = sr * rg.squares;
    return (
      <>
        <Prop label="Type" val={rg.resistorType?.toUpperCase() ?? "POLY"} />
        <Prop label="L" val={`${rg.L_um.toFixed(2)} μm`} />
        <Prop label="W" val={`${rg.W_um.toFixed(2)} μm`} />
        <Prop label="Squares" val={rg.squares.toFixed(2)} />
        <Prop label="Resistance" val={`${Math.round(resistance)} Ω`} />
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
