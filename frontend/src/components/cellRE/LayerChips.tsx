import type { LayerType } from "shared";
import { COLOR_LAYER } from "../../renderer/annotations/style";
import { LAYER_LABEL } from "../../state/cellRE";

interface Props {
  /** Layers available for selection (one chip each). */
  options: LayerType[];
  /** Currently-active layer; rendered with the `on` chip style. */
  value: LayerType;
  onChange: (next: LayerType) => void;
}

/** Layer chip row used as the inline option for the rect/polygon/point tools.
 *  Each chip shows a small color swatch (matching `COLOR_LAYER`) so it's the
 *  same legend you see on the canvas. */
export function LayerChips({ options, value, onChange }: Props) {
  return (
    <span className="row" style={{ gap: 4, alignItems: "center" }}>
      <span
        className="u"
        style={{ fontSize: 10, color: "var(--ink3)", marginRight: 4 }}
      >
        Layer
      </span>
      {options.map((layer) => (
        <button
          key={layer}
          type="button"
          className={"chip" + (value === layer ? " on" : "")}
          style={{
            cursor: "pointer",
            gap: 4,
            display: "inline-flex",
            alignItems: "center"
          }}
          onClick={() => onChange(layer)}
          title={layer}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 1,
              background: COLOR_LAYER[layer],
              border: "1px solid rgba(0,0,0,0.4)",
              flex: "0 0 auto"
            }}
          />
          {LAYER_LABEL[layer]}
        </button>
      ))}
    </span>
  );
}
