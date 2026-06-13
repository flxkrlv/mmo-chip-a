import { Fragment, type ReactNode } from "react";
import type { LayerType } from "shared";
import { Ic } from "../../icons";
import { TOOL_LAYERS, type ReToolKind, useCellREStore } from "../../state/cellRE";
import { BigToolDivider, Tool } from "../dieViewer/DieViewerUI";
import { ToolDivider } from "../shell/SubBar";
import { LayerChips } from "./LayerChips";

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
 * The Cells-RE page's tool strip + per-tool options. Drawing tools (rect /
 * polygon / point) expose a layer-chip row; the point tool additionally
 * shows the (greyed-out) snap-to-ML-via toggle the spec calls out for
 * future work.
 */
export function CellREToolbar({
  activeTool,
  setActiveTool,
  activeLayer,
  setActiveLayer,
  polyDraftLen
}: {
  activeTool: ReToolKind;
  setActiveTool: (tool: ReToolKind) => void;
  activeLayer: LayerType;
  setActiveLayer: (layer: LayerType) => void;
  /** Optional hint: # of vertices in the in-progress polygon. Renders a tiny
   *  status line under the layer chips when > 0. */
  polyDraftLen?: number;
}) {
  const plWidth = useCellREStore((s) => s.polylineWidth);
  const setPlWidth = useCellREStore((s) => s.setPolylineWidth);
  return (
    <>
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
          <span className="m" style={{fontSize:10,color:'var(--ink3)'}}>W:</span>
              <input type='number' min={1} max={50} defaultValue={plWidth} onBlur={e=>{const n=+e.target.value; if(n>=1&&n<=50)setPlWidth(n); else e.target.value=''+plWidth}} style={{width:45,background:'var(--bg1)',border:'1px solid var(--border)',color:'var(--ink0)',fontSize:10,padding:'1px 4px',borderRadius:3}} />
              <span className="m" style={{fontSize:10,color:'var(--ink3)'}}>px</span>
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
