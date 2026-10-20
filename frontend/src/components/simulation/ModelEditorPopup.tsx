/**
 * ModelEditorPopup.tsx — choose one model per device type, or write your own.
 *
 * The extracted netlist carries no process models, so the simulation needs
 * model cards. The library offers a choice *per device type* (MOS Level 1 /
 * EKV / BSIM4 for NMOS and PMOS, Gummel–Poon and Ebers–Moll for NPN and PNP,
 * a junction / zener / schottky diode) — picking one never selects anything
 * for the other types. A card you write yourself always wins over the
 * library, and the library wins over the card the netlist already defines.
 */

import { useState } from "react";
import {
  DEVICE_TYPE_LABELS,
  SPICE_DEVICE_TYPES,
  optionsFor,
  type SpiceDeviceType,
} from "shared/spiceModels";
import type { SpiceModelSelection } from "shared/spiceModels";

type Props = {
  /** Chosen library option id per device type. */
  selection: SpiceModelSelection;
  onSelect: (deviceType: SpiceDeviceType, optionId: string | null) => void;
  /** The user's own `.MODEL` lines. */
  customModels: string;
  onCustomModelsChange: (value: string) => void;
  onClose: () => void;
};

const KEEP_OWN = "__keep__";

export function ModelEditorPopup({ selection, onSelect, customModels, onCustomModelsChange, onClose }: Props) {
  const [tab, setTab] = useState<"standard" | "custom">("standard");

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--card)", border: "1px solid var(--l2)", borderRadius: 8,
          width: "min(720px, 100%)", maxHeight: "min(84vh, 760px)", display: "flex", flexDirection: "column",
          boxShadow: "0 18px 60px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--l2)" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>Device models</span>
          <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
            <button className={`btn ghost${tab === "standard" ? " on" : ""}`} style={{ fontSize: 10 }} onClick={() => setTab("standard")}>Standard library</button>
            <button className={`btn ghost${tab === "custom" ? " on" : ""}`} style={{ fontSize: 10 }} onClick={() => setTab("custom")}>Custom cards</button>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" style={{ fontSize: 10 }} onClick={onClose}>close</button>
        </div>

        {tab === "standard" ? (
          <div style={{ overflow: "auto", padding: 10, display: "grid", gap: 6 }}>
            <div style={{ fontSize: 10, color: "var(--ink3)", lineHeight: 1.5 }}>
              One model per device type. The card the netlist already defines is kept
              until you choose another one; your own card (below) always wins.
            </div>
            {SPICE_DEVICE_TYPES.map((deviceType) => {
              const options = optionsFor(deviceType);
              const current = selection[deviceType];
              const chosen = current == null ? KEEP_OWN : current;
              return (
                <div
                  key={deviceType}
                  style={{
                    display: "grid", gridTemplateColumns: "92px 1fr", gap: 8, alignItems: "start",
                    border: `1px solid ${current ? "var(--accent, #60a5fa)" : "var(--l2)"}`,
                    borderRadius: 5, padding: "6px 8px", background: current ? "rgba(96,165,250,0.07)" : "var(--l1)",
                  }}
                >
                  <div style={{ fontSize: 11, color: "var(--ink)", fontWeight: 600, paddingTop: 3 }}>
                    {DEVICE_TYPE_LABELS[deviceType]}
                  </div>
                  <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
                    <select
                      value={chosen}
                      onChange={(e) => onSelect(deviceType, e.target.value === KEEP_OWN ? null : e.target.value)}
                      style={{
                        fontSize: 10, padding: "3px 6px", borderRadius: 3, background: "var(--bg)",
                        color: "var(--ink2)", border: "1px solid var(--l2)", fontFamily: "var(--mono)", maxWidth: "100%",
                      }}
                    >
                      <option value={KEEP_OWN}>keep the netlist&apos;s card</option>
                      {options.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                    {current && (
                      <div style={{ fontSize: 9, color: "var(--ink3)", lineHeight: 1.45 }}>
                        {options.find((o) => o.id === current)?.note}
                      </div>
                    )}
                    {current && (
                      <pre style={{ margin: 0, fontSize: 9, color: "var(--ink2)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--mono)" }}>
                        {options.find((o) => o.id === current)?.card}
                      </pre>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6, minHeight: 0 }}>
            <div style={{ fontSize: 10, color: "var(--ink3)", lineHeight: 1.5 }}>
              Your own model cards — they win over both the library and the netlist.
              One <code>.MODEL</code> line per model, e.g. <code>.MODEL npn NPN (BF=250 IS=2e-16)</code>.
            </div>
            <textarea
              value={customModels}
              onChange={(e) => onCustomModelsChange(e.target.value)}
              spellCheck={false}
              style={{
                flex: 1, minHeight: 280, resize: "vertical", fontFamily: "var(--mono)", fontSize: 11,
                background: "var(--bg)", color: "var(--ink2)", border: "1px solid var(--l2)", borderRadius: 4, padding: 8, lineHeight: 1.5,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
