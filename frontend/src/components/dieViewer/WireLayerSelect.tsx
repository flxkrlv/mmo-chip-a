import type { MetalLevel } from "shared";

export function wireLayerOptions(metals: MetalLevel[]): ReadonlyArray<{
  label: string;
  value: string | null;
}> {
  return metals.map(m => ({
    label: m.id.toLowerCase(),
    value: m.layer,
  }));
}

/** Chip row for picking a wire conductor layer. Renders chips from the
 *  provided metal stack. Used both as a wire-tool option (bound to the store)
 *  and in the inspector (bound to a selected segment's edge). */
export function WireLayerSelect({
  metals,
  value,
  onChange
}: {
  metals: MetalLevel[];
  value: string | null;
  onChange: (layer: string | null) => void;
}) {
  return (
    <span className="row" style={{ gap: 4 }}>
      {metals.map((m) => (
        <button
          key={m.id}
          type="button"
          className={"chip" + (m.layer === value ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => onChange(m.layer)}
        >
          {m.id.toLowerCase()}
        </button>
      ))}
    </span>
  );
}
