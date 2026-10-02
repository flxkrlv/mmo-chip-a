import type { MetalLevel } from "shared";
import { withShortcut } from "../../lib/hotkeys";

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
  onChange,
  showHotkeys
}: {
  metals: MetalLevel[];
  value: string | null;
  onChange: (layer: string | null) => void;
  /** Tooltips name the bare-digit metal hotkeys. Only for the wire tool's
   *  own selector — the digits drive the active metal, not an inspector. */
  showHotkeys?: boolean;
}) {
  return (
    <span className="row" style={{ gap: 4 }}>
      {metals.map((m, i) => (
        <button
          key={m.id}
          type="button"
          className={"chip" + (m.layer === value ? " on" : "")}
          style={{ cursor: "pointer" }}
          title={showHotkeys ? withShortcut(m.id, i < 9 ? String(i + 1) : undefined) : undefined}
          onClick={() => onChange(m.layer)}
        >
          {m.id.toLowerCase()}
        </button>
      ))}
    </span>
  );
}
