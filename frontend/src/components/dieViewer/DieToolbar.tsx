import { Fragment, type ReactNode } from "react";
import { Ic } from "../../icons";
import { useDieViewerStore, type ToolKind } from "../../state/dieViewer";
import { useFloorplanStore } from "../../state/floorplan";
import { usePreferences } from "../../state/preferences";
import { useSession, DEFAULT_METAL_STACK } from "../../state/session";
import { ToolDivider } from "../shell/SubBar";
import { AnnotationClassSelect } from "./AnnotationClassSelect";
import { BigToolDivider, Tool } from "./DieViewerUI";
import { WireLayerSelect } from "./WireLayerSelect";

/** One toolbar entry: either a real, selectable tool (`kind`) or a not-yet-
 *  built placeholder (`todo`) rendered disabled. */
type ToolItem =
  | { kind: ToolKind; icon: ReactNode; label: string }
  | { todo: true; icon: ReactNode; label: string };

interface ToolGroup {
  /** Lowercase tag rendered before the group (omit for the unlabeled
   *  navigation cluster). */
  label?: string;
  items: ToolItem[];
}

/** Ordered groups; a thin divider renders between groups. Cells come before
 *  vias so the related "draw a shape" tools cluster early in the bar. */
const TOOL_GROUPS: ToolGroup[] = [
  {
    items: [
      { kind: "select", icon: Ic.cursor, label: "Select / marquee" },
      { kind: "pan", icon: Ic.pan, label: "Pan / zoom — hold Space or middle-drag" }
    ]
  },
  {
    label: "wires",
    items: [
      { kind: "wire", icon: Ic.wire, label: "Draw wire" },
      { kind: "multiWire", icon: Ic.multiWire, label: "Draw multi-wire" }
    ]
  },
  {
    label: "cells",
    items: [
      { kind: "addCell", icon: Ic.cellRect, label: "Draw cell rectangle" },
      { kind: "cellGuideLine", icon: Ic.gridLine, label: "Draw cell-grid guide line" },
      { kind: "cellGuideSeg", icon: Ic.gridSeg, label: "Draw cell-grid guide segment" },
      { kind: "ioPoint", icon: Ic.ioPoint, label: "Place I/O point" }
    ]
  },
  {
    label: "vias",
    items: [
      { kind: "via", icon: Ic.viaPoint, label: "Place via point" },
      { kind: "viaRect", icon: Ic.viaRect, label: "Draw via rectangle" },
      { kind: "viaPoly", icon: Ic.viaPolygon, label: "Draw via polygon" }
    ]
  },
  {
    label: "ml",
    items: [
      { kind: "roi", icon: Ic.roi, label: "Draw ML ROI rectangle" },
      { kind: "ignore", icon: Ic.mlIgnore, label: "Draw ML ignore rectangle" }
    ]
  },
  {
    label: "tools",
    items: [
      { kind: "measure", icon: Ic.ruler, label: "Ruler — drag to measure distance" },
      { kind: "comment", icon: Ic.comment, label: "Comment — click to add a comment pin" },
      { kind: "floorplan", icon: Ic.floorplan, label: "Floorplan — draw functional block outlines" }
    ]
  }
];

/**
 * The die-viewer's left/centre toolbar: grouped tool buttons, then (only when
 * the active tool actually has options) a stronger divider followed by that
 * tool's controls.
 */
export function DieToolbar({
  activeTool,
  setActiveTool,
  multiWireHint
}: {
  activeTool: ToolKind;
  setActiveTool: (tool: ToolKind) => void;
  /** Phase-aware help line for the multi-wire tool (kept short to save
   *  toolbar space; changes as the tool moves through its stages). */
  multiWireHint?: string;
}) {
  const options = toolOptions(activeTool, multiWireHint);
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
          {group.items.map((item, ii) =>
            "kind" in item ? (
              <Tool
                key={item.kind}
                icon={item.icon}
                label={item.label}
                on={activeTool === item.kind}
                onClick={() => setActiveTool(item.kind)}
              />
            ) : (
              <Tool
                key={`todo-${gi}-${ii}`}
                icon={item.icon}
                label={item.label}
                todo
              />
            )
          )}
        </Fragment>
      ))}
      {options && (
        <>
          <BigToolDivider />
          <div
            className="row"
            style={{ alignItems: "center", gap: 10, minWidth: 0 }}
          >
            {options}
          </div>
        </>
      )}
    </>
  );
}

/** The active tool's inline options, or null when it has none. Each tool's
 *  controls will grow here as later phases land. */
function toolOptions(tool: ToolKind, multiWireHint?: string): ReactNode {
  if (tool === "wire") return <WireOptions />;
  if (tool === "multiWire") return <WireOptions hint={multiWireHint} />;
  if (tool === "addCell") return <CellOptions />;
  if (tool === "via" || tool === "viaRect" || tool === "viaPoly") return <ViaOptions />;
  if (tool === "roi") return <RoiOptions />;
  if (tool === "cellGuideLine") return <GuideLineOptions />;
  if (tool === "measure") return <MeasureOptions />;
  if (tool === "floorplan") return <FloorplanOptions />;
  // others (incl. cellGuideSeg) have no options.
  return null;
}

function MeasureOptions() {
  const mode = useDieViewerStore((s) => s.measureMode);
  const setMode = useDieViewerStore((s) => s.setMeasureMode);
  const showPx = useDieViewerStore((s) => s.showRulerPx);
  const showUm = useDieViewerStore((s) => s.showRulerUm);
  const showNm = useDieViewerStore((s) => s.showRulerNm);
  const setDisplay = useDieViewerStore((s) => s.setRulerDisplay);
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Mode
      </span>
      <span className="row" style={{ gap: 4 }}>
        {(
          [
            ["free" as const, "free"],
            ["ortho" as const, "orthogonal"],
            ["h" as const, "horizontal"],
            ["v" as const, "vertical"],
            ["diag" as const, "diagonal"]
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            className={"chip" + (mode === m ? " on" : "")}
            style={{ cursor: "pointer" }}
            onClick={() => setMode(m)}
          >
            {label}
          </button>
        ))}
      </span>
      <span className="row" style={{ gap: 6, marginLeft: 6 }}>
        <label className="check" title="Show source-pixel length">
          <input type="checkbox" checked={showPx} onChange={(e) => setDisplay({ showRulerPx: e.target.checked })} />
          px
        </label>
        <label className="check" title="Show micrometre length; values below 1 µm are shown in nm">
          <input type="checkbox" checked={showUm} onChange={(e) => setDisplay({ showRulerUm: e.target.checked })} />
          µm
        </label>
        <label className="check" title="Show nanometre length instead of µm">
          <input type="checkbox" checked={showNm} onChange={(e) => setDisplay({ showRulerNm: e.target.checked })} />
          nm
        </label>
      </span>
    </>
  );
}

function GuideLineOptions() {
  const axis = useDieViewerStore((s) => s.guideAxis);
  const setAxis = useDieViewerStore((s) => s.setGuideAxis);
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Orientation
      </span>
      <span className="row" style={{ gap: 4 }}>
        {(
          [
            ["x", "vertical"],
            ["y", "horizontal"]
          ] as const
        ).map(([a, label]) => (
          <button
            key={a}
            type="button"
            className={"chip" + (axis === a ? " on" : "")}
            style={{ cursor: "pointer" }}
            onClick={() => setAxis(a)}
          >
            {label}
          </button>
        ))}
      </span>
    </>
  );
}

function FloorplanOptions() {
  const toolMode = useFloorplanStore((s) => s.toolMode);
  const setToolMode = useFloorplanStore((s) => s.setToolMode);
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Mode
      </span>
      <span className="row" style={{ gap: 4 }}>
        <button
          type="button"
          className={"chip" + (toolMode === "rect" || toolMode === "idle" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setToolMode("rect")}
        >
          Rect
        </button>
        <button
          type="button"
          className={"chip" + (toolMode === "poly" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setToolMode("poly")}
        >
          Poly
        </button>
      </span>
    </>
  );
}

function RoiOptions() {
  const roiClasses = usePreferences((s) => s.roiClasses);
  const setRoiClasses = usePreferences((s) => s.setRoiClasses);
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        ROI labels
      </span>
      <AnnotationClassSelect value={roiClasses} onChange={setRoiClasses} />
    </>
  );
}

function WireOptions({ hint }: { hint?: string }) {
  const activeMetalId = useDieViewerStore((s) => s.activeMetalId);
  const setActiveMetalId = useDieViewerStore((s) => s.setActiveMetalId);
  const metals = (useSession((s) => s.metalStack) ?? DEFAULT_METAL_STACK).metals;
  const snapToVias = usePreferences((s) => s.snapToVias);
  const setSnapToVias = usePreferences((s) => s.setSnapToVias);
  const autoEndOnVia = usePreferences((s) => s.wireAutoEndOnVia);
  const setAutoEndOnVia = usePreferences((s) => s.setWireAutoEndOnVia);
  const autoEndOnContact = usePreferences((s) => s.autoEndOnContact);
  const setAutoEndOnContact = usePreferences((s) => s.setAutoEndOnContact);
  const autoVia = usePreferences((s) => s.autoViaEnabled);
  const setAutoVia = usePreferences((s) => s.setAutoViaEnabled);
  const viaPlaceMode = usePreferences((s) => s.viaPlaceMode);
  const setViaPlaceMode = usePreferences((s) => s.setViaPlaceMode);
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Layer
      </span>
      <WireLayerSelect metals={metals} value={activeMetalId != null ? metals.find(m => m.id === activeMetalId)?.layer ?? null : null} onChange={(layer) => { const m = metals.find(m => m.layer === layer); setActiveMetalId(m?.id ?? null); }} />
      <label
        className="check"
        title="Snap click positions to the nearest via (ML or manually placed)"
      >
        <input
          type="checkbox"
          checked={snapToVias}
          onChange={(e) => setSnapToVias(e.target.checked)}
        />
        Snap to vias
      </label>
      <label
        className="check"
        title="Snap the next point onto any via the projected wire passes through. Single wire keeps drafting from the via so you can chain more segments; multi-wire locks each wire on its own via and commits when all are locked."
      >
        <input
          type="checkbox"
          checked={autoEndOnVia}
          onChange={(e) => setAutoEndOnVia(e.target.checked)}
        />
        Auto-end on via
      </label>
      <label
        className="check"
        title="When clicking on a cell terminal (orange snap halo), commit the wire immediately instead of staying in edit mode."
      >
        <input
          type="checkbox"
          checked={autoEndOnContact}
          onChange={(e) => setAutoEndOnContact(e.target.checked)}
        />
        Auto-end on contact
      </label>
      <label
        className="check"
        title="When enabled, clicking a vertex on an adjacent metal auto-places the via and connects"
      >
        <input
          type="checkbox"
          checked={autoVia}
          onChange={(e) => setAutoVia(e.target.checked)}
        />
        AutoVia
      </label>
      <label
        className="check"
        title="E/Q via placement: at cursor position, or at the snapped end of the wire preview"
      >
        <input
          type="checkbox"
          checked={viaPlaceMode === "wire-end"}
          onChange={(e) => setViaPlaceMode(e.target.checked ? "wire-end" : "cursor")}
        />
        Via: {viaPlaceMode === "cursor" ? "cursor" : "wire-end"}
      </label>
      {hint && (
        <span
          className="m"
          style={{ fontSize: 10.5, color: "var(--ink3)", fontStyle: "italic" }}
        >
          {hint}
        </span>
      )}
    </>
  );
}

function ViaOptions() {
  const activeViaId = useDieViewerStore((s) => s.activeViaId);
  const setActiveViaId = useDieViewerStore((s) => s.setActiveViaId);
  const vias = (useSession((s) => s.metalStack) ?? DEFAULT_METAL_STACK).vias;
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Via layer
      </span>
      <span className="row" style={{ gap: 4 }}>
        {vias.map((v) => (
          <button
            key={v.id}
            type="button"
            className={"chip" + (activeViaId === v.id ? " on" : "")}
            style={{ cursor: "pointer" }}
            onClick={() => setActiveViaId(v.id)}
          >
            {v.id.toLowerCase()}
          </button>
        ))}
      </span>
      {activeViaId && (
        <span style={{ fontSize: 10, color: "var(--ink3)", marginLeft: 4 }}>
          O to cycle
        </span>
      )}
    </>
  );
}

function CellOptions() {
  const snap = usePreferences((s) => s.cellSnapToGuides);
  const setSnap = usePreferences((s) => s.setCellSnapToGuides);
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={snap}
        onChange={(e) => setSnap(e.target.checked)}
      />
      Snap to guides
    </label>
  );
}

export function IssuesChip({
  errors = 0,
  warnings = 0,
  onClick,
}: {
  errors?: number;
  warnings?: number;
  onClick?: () => void;
}) {
  const tone = errors > 0 ? "err" : warnings > 0 ? "warn" : "";
  return onClick ? (
    <button
      className={"chip" + (tone ? ` ${tone}` : "")}
      title={`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${
        warnings === 1 ? "" : "s"
      }`}
      onClick={onClick}
      style={{
        cursor: "pointer", border: 0, fontSize: "inherit", fontFamily: "inherit",
        background: tone === "err" ? "var(--err-bg, #3a1111)" : tone === "warn" ? "var(--warn-bg, #3a2a00)" : "var(--l1)",
        color: "inherit", padding: "0 6px", borderRadius: 3, height: 22,
      }}
    >
      {Ic.mlExclude}
      {errors} / {warnings}
    </button>
  ) : (
    <span
      className={"chip" + (tone ? ` ${tone}` : "")}
      title={`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${
        warnings === 1 ? "" : "s"
      }`}
    >
      {Ic.mlExclude}
      {errors} / {warnings}
    </span>
  );
}
