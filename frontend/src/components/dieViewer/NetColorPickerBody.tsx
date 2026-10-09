/**
 * NetColorPickerBody.tsx — preset swatches + custom color input for per-net
 * color overrides (usePreferences.netColors). Shared by the outline tree's
 * per-net / bulk pickers and the net rename window.
 */

/** Per-net color override. Cycles through a small palette. */
export const NET_OVERRIDE_COLORS = [
  null,                     // reset to global
  "#ff3333",               // VDD red
  "#3388ff",               // GND blue
  "#22d366",               // VSS green
  "#ffaa00",               // IO yellow
  "#ff66aa",               // pink
  "#aa66ff",               // purple
  "#66ffaa",               // mint
];

/** Preset swatches + a custom hex color input, shared by the per-net and
 *  bulk (multi-select) color pickers. */
export function NetColorPickerBody({ currentColor, onPick }: {
  currentColor: string;
  onPick: (color: string | null) => void;
}) {
  const customColor = /^#[0-9a-f]{6}$/i.test(currentColor) ? currentColor : "#2e97ff";
  return (
    <>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 140 }}>
        {NET_OVERRIDE_COLORS.map((c, i) => {
          const label = c === null
            ? "default"
            : ["VDD red","GND blue","VSS green","IO yellow","pink","purple","mint"][i - 1] ?? "";
          return (
            <button
              key={i}
              type="button"
              title={label}
              style={{
                width: 24, height: 24, borderRadius: 3,
                border: currentColor === (c ?? "#2e97ff") ? "2px solid rgba(255,255,255,0.9)" : "1px solid rgba(255,255,255,0.2)",
                background: c ?? "#555",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 9,
                color: c ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.5)",
              }}
              onClick={() => onPick(c)}
            >
              {c === null ? "↺" : ""}
            </button>
          );
        })}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center" }}>
        <input
          type="color"
          value={customColor}
          onChange={(e) => onPick(e.target.value)}
          title="Pick a custom color"
          style={{
            width: 28, height: 22, padding: 0, cursor: "pointer",
            border: "1px solid var(--l2)", borderRadius: 3, background: "none"
          }}
        />
        <span style={{ fontSize: 10, color: "var(--ink3)" }}>Custom color</span>
      </div>
    </>
  );
}
