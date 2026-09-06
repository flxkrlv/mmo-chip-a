import { useOverlayLayers } from "../../state/overlayLayers";

interface OverlaySelectorProps {
  value: string | null;
  onChange: (id: string | null) => void;
}

/** Dropdown for "which background image to use under the package outline".
 *  Default value is null → original die photo. Selecting an overlay hides the
 *  base and renders that overlay instead (assuming same pixel space as the
 *  base die, which is the typical case for stacked die-layer photos). */
export function OverlaySelector({ value, onChange }: OverlaySelectorProps) {
  const layers = useOverlayLayers((s) => s.layers);
  const loaded = layers.filter((l) => l.loaded);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
      }}
    >
      <span className="u" style={{ color: "var(--ink3)" }}>
        layer
      </span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        style={{ minWidth: 110 }}
        title="Background image for the package alignment view"
      >
        <option value="">Base die image</option>
        {loaded.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </div>
  );
}
