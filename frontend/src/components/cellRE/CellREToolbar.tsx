import { Fragment, type ReactNode } from "react";
import type { CellType, LayerType } from "shared";
import { Ic } from "../../icons";
import { TOOL_LAYERS, type ReToolKind, useCellREStore } from "../../state/cellRE";
import { usePreferences } from "../../state/preferences";
import { BigToolDivider, Tool } from "../dieViewer/DieViewerUI";
import { ToolDivider } from "../shell/SubBar";
import { LayerChips } from "./LayerChips";

/** Three discrete label sizes. Kept in one place so canvas + toolbar agree. */
const LABEL_SCALES = [
  { value: 0 as const, label: "S" },
  { value: 1 as const, label: "M" },
  { value: 2 as const, label: "L" },
];

/** One toolbar entry: a real, selectable tool. */
interface ToolItem {
  kind: ReToolKind;
  icon: ReactNode;
  label: string;
}

interface ToolGroup {
  label?: string;
  items: ToolItem[];
}

/** Ordered groups; thin divider between. Drawing tools live in their own
 *  "annotations" group so the navigation cluster (select/pan) reads as
 *  separate from the per-layer drawing tools. */
const TOOL_GROUPS: ToolGroup[] = [
  {
    items: [
      { kind: "select", icon: Ic.cursor, label: "Select / marquee - V" },
      { kind: "pan", icon: Ic.pan, label: "Pan / zoom - hold Space or middle-drag" }
    ]
  },
  {
    label: "annotations",
    items: [
      { kind: "rect", icon: Ic.cellRect, label: "Draw layer rectangle — R" },
      { kind: "polygon", icon: Ic.viaPolygon, label: "Draw layer polygon — P" },
      { kind: "point", icon: Ic.viaPoint, label: "Place via/contact point — O" },
      { kind: "polyline", icon: Ic.wire, label: "Draw polyline (resistor) - L" }
    ]
  }
];

/**
 * The Cells-RE page's tool strip + per-tool options.
 *
 * When the polyline tool is active, extra options appear:
 * - Width slider + manual input in µm (default for new polylines)
 * - Opacity slider for resistor body layers (to check width overlay)
 */
export function CellREToolbar({
  activeTool,
  setActiveTool,
  activeLayer,
  setActiveLayer,
  polyDraftLen,
  /** Pixels-per-micrometre scale from DieAnnotations.umPerPx. */
  umPerPx,
}: {
  activeTool: ReToolKind;
  setActiveTool: (tool: ReToolKind) => void;
  activeLayer: LayerType;
  setActiveLayer: (layer: LayerType) => void;
  polyDraftLen?: number;
  umPerPx?: number;
}) {
  const plWidth = useCellREStore((s) => s.polylineWidth);
  const setPlWidth = useCellREStore((s) => s.setPolylineWidth);
  const resistorOpacity = usePreferences((s) => s.resistorOpacity);
  const setResistorOpacity = usePreferences((s) => s.setResistorOpacity);
  // Overlay controls — kept here (not behind a per-tool gate) so they're
  // visible regardless of the active tool: users often switch tools just
  // to turn labels off when reading a dense layout.
  const deviceLabelsVisible = usePreferences((s) => s.reDeviceLabelsVisible);
  const setDeviceLabelsVisible = usePreferences((s) => s.setReDeviceLabelsVisible);
  const terminalLabelsVisible = usePreferences((s) => s.reTerminalLabelsVisible);
  const setTerminalLabelsVisible = usePreferences((s) => s.setReTerminalLabelsVisible);
  const labelScale = usePreferences((s) => s.reAnalogLabelScale);
  const setLabelScale = usePreferences((s) => s.setReAnalogLabelScale);

  // polylineWidth is stored in µm directly — no conversion needed.
  const currentWidthUm = Math.round(plWidth);

  const setWidth = (um: number) => {
    const roundedUm = Math.round(um);
    setPlWidth(Math.max(1, Math.min(50, roundedUm)));
  };

  // Slider range in µm: 1–50, step 1
  const SLIDER_MIN_UM = 1;
  const SLIDER_MAX_UM = 50;
  const SLIDER_STEP_UM = 1;

  return (
    <>
      {/* Overlay controls — always visible regardless of active tool.
          Grouped under a "overlays" header so users can find them when the
          canvas feels cluttered (toggle labels off, keep nets visible, etc.) */}
      <span
        className="u"
        style={{ fontSize: 10, color: "var(--ink3)", margin: "0 4px 0 2px" }}
      >
        overlays
      </span>
      <label
        className="check"
        style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 10.5 }}
        title="Show device instance labels (M1, Q12, R34…) over the cell image"
      >
        <input
          type="checkbox"
          checked={deviceLabelsVisible}
          onChange={(e) => setDeviceLabelsVisible(e.target.checked)}
        />
        Devices
      </label>
      <label
        className="check"
        style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 10.5 }}
        title="Show device terminal letters and dots (G/S/D/B/C/E/+/−)"
      >
        <input
          type="checkbox"
          checked={terminalLabelsVisible}
          onChange={(e) => setTerminalLabelsVisible(e.target.checked)}
        />
        Terminals
      </label>
      <ToolDivider />
      <span
        className="m"
        style={{ fontSize: 10, color: "var(--ink3)", marginRight: 2 }}
      >
        Label size:
      </span>
      <div
        role="group"
        style={{
          display: "inline-flex",
          border: "1px solid var(--l2)",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        {LABEL_SCALES.map((opt, i) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setLabelScale(opt.value)}
            title={`Label size: ${opt.label} (${opt.value === 0 ? "0.2x" : opt.value === 2 ? "1.0x" : "0.5x"})`}
            style={{
              padding: "2px 7px",
              fontSize: 10,
              fontFamily: "var(--mono)",
              fontWeight: 600,
              background: labelScale === opt.value ? "var(--accent)" : "var(--bg1)",
              color: labelScale === opt.value ? "var(--accentFg, #fff)" : "var(--ink2)",
              border: 0,
              borderLeft: i > 0 ? "1px solid var(--l2)" : 0,
              cursor: "pointer",
              lineHeight: 1.2,
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <BigToolDivider />
      {TOOL_GROUPS.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <ToolDivider />}
          {group.label && (
            <span
              className="u"
              style={{ fontSize: 10, color: "var(--ink3)", margin: "0 4px 0 2px" }}
            >
              {group.label}
            </span>
          )}
          {group.items.map((item) => (
            <Tool
              key={item.kind}
              icon={item.icon}
              label={item.label}
              on={activeTool === item.kind}
              onClick={() => setActiveTool(item.kind)}
            />
          ))}
        </Fragment>
      ))}
      {activeTool === "rect" && (
        <>
          <BigToolDivider />
          <LayerChips
            options={TOOL_LAYERS.rect}
            value={isInList(activeLayer, TOOL_LAYERS.rect) ? activeLayer : TOOL_LAYERS.rect[0]}
            onChange={setActiveLayer}
          />
        </>
      )}
      {activeTool === "polygon" && (
        <>
          <BigToolDivider />
          <LayerChips
            options={TOOL_LAYERS.polygon}
            value={
              isInList(activeLayer, TOOL_LAYERS.polygon)
                ? activeLayer
                : TOOL_LAYERS.polygon[0]
            }
            onChange={setActiveLayer}
          />
          {polyDraftLen != null && polyDraftLen > 0 && (
            <span
              className="m"
              style={{ fontSize: 10.5, color: "var(--ink3)", fontStyle: "italic" }}
            >
              {polyDraftLen} vertex{polyDraftLen === 1 ? "" : "es"} - Enter to commit,
              Esc to cancel, ⌘Z removes last
            </span>
          )}
        </>
      )}
      {activeTool === "polyline" && (
        <>
          <BigToolDivider />
          <LayerChips
            options={TOOL_LAYERS.polyline}
            value={isInList(activeLayer, TOOL_LAYERS.polyline) ? activeLayer : TOOL_LAYERS.polyline[0]}
            onChange={setActiveLayer}
          />
          <ToolDivider />
          {/* Width slider + manual input in µm (default for NEW polylines) */}
                  <div
          className="row"
          style={{ gap: 4, alignItems: "center", padding: "2px 6px" }}
        >
          <span className="m" style={{ fontSize: 10, color: "var(--ink3)", whiteSpace: "nowrap" }}>
            W:
          </span>
          <input
            type="range"
            min={SLIDER_MIN_UM}
            max={SLIDER_MAX_UM}
            step={SLIDER_STEP_UM}
            value={Math.min(SLIDER_MAX_UM, Math.max(SLIDER_MIN_UM, currentWidthUm))}
            onChange={(e) => setWidth(parseFloat(e.target.value))}
            title="Default width for new polylines"
            style={{ width: 80, height: 14, accentColor: "var(--accent)" }}
          />
          <input
            type="number"
            min={SLIDER_MIN_UM}
            max={SLIDER_MAX_UM}
            step={SLIDER_STEP_UM}
            value={Math.min(SLIDER_MAX_UM, Math.max(SLIDER_MIN_UM, currentWidthUm))}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v)) setWidth(v);
            }}
            style={{
              width: 52,
              background: "var(--bg1)",
              border: "1px solid var(--border)",
              color: "var(--ink0)",
              fontSize: 10,
              padding: "1px 4px",
              borderRadius: 3,
            }}
          />
          <span className="m" style={{ fontSize: 10, color: "var(--ink3)" }}>µm</span>
        </div>
          {/* Opacity slider for resistor layers */}
          <ToolDivider />
          <div
            className="row"
            style={{ gap: 4, alignItems: "center", padding: "2px 6px" }}
          >
            <span className="m" style={{ fontSize: 10, color: "var(--ink3)", whiteSpace: "nowrap" }}>
              Opacity:
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={resistorOpacity}
              onChange={(e) => setResistorOpacity(parseFloat(e.target.value))}
              title="Resistor layer opacity — dim to check width overlay against the image"
              style={{ width: 60, height: 14, accentColor: "var(--accent)" }}
            />
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={resistorOpacity}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v)) setResistorOpacity(v);
              }}
              style={{
                width: 42,
                background: "var(--bg1)",
                border: "1px solid var(--border)",
                color: "var(--ink0)",
                fontSize: 10,
                padding: "1px 4px",
                borderRadius: 3,
              }}
            />
          </div>
        </>
      )}
      {activeTool === "point" && (
        <>
          <BigToolDivider />
          <LayerChips
            options={TOOL_LAYERS.point}
            value={
              isInList(activeLayer, TOOL_LAYERS.point) ? activeLayer : TOOL_LAYERS.point[0]
            }
            onChange={setActiveLayer}
          />
          {/* Divider gives the snap checkbox visual breathing room from the
              layer chips - they're two distinct options groups, not one row. */}
          <ToolDivider />
          <label
            className="check"
            style={{ opacity: 0.45, cursor: "not-allowed" }}
            title="Snap to ML via - feature not implemented yet"
          >
            <input type="checkbox" disabled checked={false} readOnly />
            Snap to ML via
          </label>
        </>
      )}
    </>
  );
}

function isInList<T>(value: T, list: ReadonlyArray<T>): boolean {
  return list.includes(value);
}
