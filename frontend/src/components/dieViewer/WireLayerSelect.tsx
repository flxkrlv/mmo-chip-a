import type { WireLayer } from "shared";

/** Selectable layers for the wire tool — only metal layers.
 *  Poly and unknown are removed: device contacts connect to ME1 only;
 *  ME2+ requires a via.  Also used in the InspectorPanel for edge
 *  layer assignment. */
export const WIRE_LAYER_OPTIONS: ReadonlyArray<{
  label: string;
  value: WireLayer | null;
}> = [
  { label: "m1", value: "metal1" },
  { label: "m2", value: "metal2" }
];

/** Chip row for picking a wire conductor layer (matches the hifi/wireframe
 *  "layer" row). Used both as a wire-tool option (bound to the store) and in
 *  the inspector (bound to a selected segment's edge). */
export function WireLayerSelect({
  value,
  onChange
}: {
  value: WireLayer | null;
  onChange: (layer: WireLayer | null) => void;
}) {
  return (
    <span className="row" style={{ gap: 4 }}>
      {WIRE_LAYER_OPTIONS.map((o) => (
        <button
          key={o.label}
          type="button"
          className={"chip" + (o.value === value ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
