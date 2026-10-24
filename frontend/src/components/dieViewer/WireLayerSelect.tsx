import { PROCESS_LAYERS, isProcessLayer, type MetalLevel } from "shared";
import { withShortcut } from "../../lib/hotkeys";
import { usePreferences } from "../../state/preferences";

export function wireLayerOptions(metals: MetalLevel[]): ReadonlyArray<{
  label: string;
  value: string | null;
}> {
  return metals.map(m => ({
    label: m.id.toLowerCase(),
    value: m.layer,
  }));
}

/** Chip label: N+ / P+ / NW / PO… for silicon layers, me1… for metals. */
function chipLabel(m: MetalLevel): string {
  return isProcessLayer(m.layer) && m.z < 1 ? PROCESS_LAYERS[m.layer].short : m.id.toLowerCase();
}

/** Chip row for picking a wire conductor layer. Renders chips from the
 *  provided layer stack: the die's silicon layers (wells, diffusions, poly…,
 *  when it has a process) and metal 1 — metal 2+ are tucked behind a "+"
 *  chip on process dies, as they're the less common case. Used both as a
 *  wire-tool option (bound to the store) and in the inspector (bound to a
 *  selected segment's edge). */
export function WireLayerSelect({
  metals,
  value,
  onChange,
  showHotkeys,
  wrap
}: {
  metals: MetalLevel[];
  value: string | null;
  onChange: (layer: string | null) => void;
  /** Tooltips name the bare-digit metal hotkeys. Only for the wire tool's
   *  own selector — the digits drive the active metal, not an inspector. */
  showHotkeys?: boolean;
  /** Wrap onto several lines (inspector); the toolbar keeps one line. */
  wrap?: boolean;
}) {
  const showUpper = usePreferences((s) => s.showUpperMetals);
  const setShowUpper = usePreferences((s) => s.setShowUpperMetals);
  const silicon = metals.filter((m) => m.z < 1).sort((a, b) => a.z - b.z);
  const metalLevels = metals.filter((m) => m.z >= 1);
  const collapsible = silicon.length > 0 && metalLevels.length > 1;
  const shownMetals =
    collapsible && !showUpper ? metalLevels.filter((m, i) => i === 0 || m.layer === value) : metalLevels;

  const chip = (m: MetalLevel, hotkey?: string) => (
    <button
      key={m.id}
      type="button"
      className={"chip" + (m.layer === value ? " on" : "")}
      style={{ cursor: "pointer", boxShadow: `inset 0 -2px 0 ${m.color}` }}
      title={showHotkeys ? withShortcut(m.name, hotkey) : m.name}
      onClick={() => onChange(m.layer)}
    >
      {chipLabel(m)}
    </button>
  );

  return (
    <span className="row" style={{ gap: 4, flexWrap: wrap ? "wrap" : "nowrap", flexShrink: wrap ? 1 : 0 }}>
      {silicon.map((m) => chip(m))}
      {silicon.length > 0 && <span style={{ width: 1, alignSelf: "stretch", background: "var(--l2)" }} />}
      {shownMetals.map((m) => {
        const i = metalLevels.indexOf(m);
        return chip(m, i < 9 ? String(i + 1) : undefined);
      })}
      {collapsible && (
        <button
          type="button"
          className="chip"
          style={{ cursor: "pointer" }}
          title={showUpper ? "Hide metal 2 and up" : "Show metal 2 and up"}
          onClick={() => setShowUpper(!showUpper)}
        >
          {showUpper ? "−" : `+${metalLevels.length - 1}`}
        </button>
      )}
    </span>
  );
}
