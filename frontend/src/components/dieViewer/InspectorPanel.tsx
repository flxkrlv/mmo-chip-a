import { useState, useRef, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DieAnnotations, MLInferenceJob, WireLayer } from "shared";
import type { ActionDispatcher } from "../../api/actions";
import { uuid } from "../../lib/uuid";
import {
  cvDebug,
  cvDebugDump,
  cvMatch,
  cvTemplateMatch,
  exportMlData,
  mlJobKey,
  selectMLModel,
  startMLJob,
  stopMLJob,
  useMLJob,
  useMLModels,
  useMLStatus
} from "../../api/ml";
import { parseNetPartId } from "../../lib/netGraph";
import {
  isMlViaId,
  type MLViasLayer
} from "../../renderer/layers/MLViasLayer";
import { useDieViewerStore } from "../../state/dieViewer";
import { usePreferences } from "../../state/preferences";
import { useSession, DEFAULT_METAL_STACK } from "../../state/session";
import { useOverlayLayers } from "../../state/overlayLayers";
import { WireLayerSelect } from "./WireLayerSelect";
import { AnnotationClassSelect } from "./AnnotationClassSelect";

/** A single labelled property row (`.prop` matches the hifi spec). */
function Prop({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="prop">
      <span className="lbl">{label}</span>
      <span className="val" style={{ minWidth: 0 }}>
        {children}
      </span>
    </div>
  );
}

/** Sub-section header inside the inspector (e.g. the selected segment). */
function SubHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "6px 12px",
        borderTop: "1px solid var(--l1)",
        borderBottom: "1px solid var(--l1)",
        background: "var(--panel)"
      }}
    >
      <span className="u">{children}</span>
    </div>
  );
}

/** Editable name field. Uncontrolled + keyed by uid so it resets when the
 *  selection changes; commits on blur / Enter, reverts on Escape. */
function NameField({
  uid,
  value,
  onCommit
}: {
  uid: string;
  value: string;
  onCommit: (next: string) => void;
}) {
  const commit = (el: HTMLInputElement) => {
    const next = el.value.trim();
    if (!next || next === value) {
      el.value = value;
      return;
    }
    onCommit(next);
  };
  return (
    <label className="input" style={{ flex: 1 }}>
      <input
        key={uid}
        defaultValue={value}
        spellCheck={false}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.currentTarget.value = value;
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

const short = (id: string) => (id.length > 10 ? id.slice(0, 8) + "…" : id);

interface Resolved {
  typeLabel: string;
  displayName: string;
  uid: string;
  /** Present only when the entity carries an editable name. */
  name?: { value: string; onCommit: (next: string) => void };
  /** Extra property rows shown after `uid` (text or interactive controls,
   *  e.g. the ROI class selector). */
  rows?: [string, ReactNode][];
  /** Net sub-part (segment / vertex) detail panel. Row values may be plain
   *  text or an interactive control (e.g. the segment layer selector). */
  sub?: { kind: string; id: string; rows: [string, ReactNode][] };
}

function resolve(
  id: string,
  ann: DieAnnotations,
  dispatcher: ActionDispatcher,
  mlViasLayer: MLViasLayer | null,
  cellTypeCounts?: Map<string, number>
): Resolved | null {
  // ── ML vias (synthetic position id; no persistent annotation) ──────
  // Checked first because the prefix is unambiguous and the layer lookup
  // is cheap — keeps `parseNetPartId` and the prefix switch focused on
  // the persisted-annotation paths below.
  if (isMlViaId(id)) {
    const v = mlViasLayer?.findViaById(id) ?? null;
    if (!v) {
      // Tile evicted (model switch / refetch) — keep the slot so the user
      // sees *something* and can deselect; we just don't have score/kind.
      return {
        typeLabel: "ML via",
        displayName: `ML via ${short(id)}`,
        uid: id,
        rows: [["status", "not in current cache"]]
      };
    }
    const typeLabel = v.kind === "point" ? "ML via point" : "ML via region";
    return {
      typeLabel,
      displayName: `${typeLabel} ${short(id)}`,
      uid: id,
      rows: [
        ["confidence", `${(v.score * 100).toFixed(1)}%`],
        ["position", `(${Math.round(v.x)}, ${Math.round(v.y)})`],
        ["source", "ML prediction"]
      ]
    };
  }

  // ── Nets (incl. a selected segment / vertex sub-part) ──────────────
  const net = parseNetPartId(id);
  if (net) {
    const n = ann.nets.find((x) => x.id === net.netId);
    if (!n) return null;
    const base: Resolved = {
      typeLabel: "Net",
      displayName: n.name || `Net ${short(n.id)}`,
      uid: n.id,
      name: {
        value: n.name ?? "",
        onCommit: (name) =>
          void dispatcher.dispatch({
            kind: "upsertNet",
            net: { ...n, name },
            prevNet: n
          })
      }
    };
    if (net.part === "edge" && net.partId) {
      const e = n.edges.find((x) => x.id === net.partId);
      const a = e && n.nodes.find((nd) => nd.id === e.from);
      const b = e && n.nodes.find((nd) => nd.id === e.to);
      if (e && a && b) {
        const len = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
        const stack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;
        const setLayer = (layer: string | null) => {
          const edges = n.edges.map((x) => {
            if (x.id !== e.id) return x;
            if (layer) return { ...x, layer: layer as WireLayer };
            const { layer: _drop, ...rest } = x;
            return rest;
          });
          void dispatcher.dispatch({
            kind: "upsertNet",
            net: { ...n, edges },
            prevNet: n
          });
        };
        base.sub = {
          kind: "Segment",
          id: e.id,
          rows: [
            ["from", `(${Math.round(a.x)}, ${Math.round(a.y)})`],
            ["to", `(${Math.round(b.x)}, ${Math.round(b.y)})`],
            ["length", `${len} px`],
            [
              "layer",
              <WireLayerSelect
                key="layer"
                metals={stack.metals}
                value={e.layer ?? null}
                onChange={setLayer}
              />
            ]
          ]
        };
      }
    } else if (net.part === "node" && net.partId) {
      const nd = n.nodes.find((x) => x.id === net.partId);
      if (nd) {
        const deg = n.edges.filter(
          (e) => e.from === nd.id || e.to === nd.id
        ).length;
        base.sub = {
          kind: "Vertex",
          id: nd.id,
          rows: [
            ["position", `(${Math.round(nd.x)}, ${Math.round(nd.y)})`],
            ["edges", String(deg)]
          ]
        };
      }
    }
    return base;
  }

  const [prefix, eid] = splitId(id);
  switch (prefix) {
    case "cellType": {
      const ct = ann.cellTypes.find((x) => x.id === eid);
      if (!ct) return null;
      return {
        typeLabel: "Cell type",
        displayName: ct.name || `Cell type ${short(ct.id)}`,
        uid: ct.id,
        name: {
          value: ct.name ?? "",
          onCommit: (name) =>
            void dispatcher.dispatch({
              kind: "upsertCellType",
              cellType: { ...ct, name },
              prevCellType: ct
            })
        }
      };
    }
    case "cell": {
      const c = ann.cells.find((x) => x.id === eid);
      if (!c) return null;
      const ct = ann.cellTypes.find((t) => t.id === c.cellTypeId);
      // Like net→segment: the cell *type* is the editable top-level entity;
      // the placed instance is a read-only sub-section underneath.
      const base: Resolved = ct
        ? {
            typeLabel: "Cell type",
            displayName: ct.name || `Cell type ${short(ct.id)}`,
            uid: ct.id,
            name: {
              value: ct.name ?? "",
              onCommit: (name) =>
                void dispatcher.dispatch({
                  kind: "upsertCellType",
                  cellType: { ...ct, name },
                  prevCellType: ct
                })
            }
          }
        : { typeLabel: "Cell", displayName: `Cell ${short(c.id)}`, uid: c.id };
      const rows: [string, string][] = [
        ["position", `(${Math.round(c.x)}, ${Math.round(c.y)})`]
      ];
      if (ct) {
        rows.push(["size", `${ct.cropRect.width}×${ct.cropRect.height}`]);
        const count = cellTypeCounts?.get(ct.id) ?? 1;
        rows.push(["relationship", count > 1 ? `Linked (×${count})` : "Unique"]);
      }
      rows.push(["flipped", c.flippedV ? "vertical" : "no"]);
      base.sub = { kind: "Cell", id: c.id, rows };
      return base;
    }
    case "pin": {
      const p = ann.pins?.find((x) => x.id === eid);
      if (!p) return null;
      return {
        typeLabel: "I/O pin",
        displayName: p.name || `pin ${p.pin}`,
        uid: p.id,
        name: {
          value: p.name ?? "",
          onCommit: (name) =>
            void dispatcher.dispatch({
              kind: "upsertPin",
              pin: { ...p, name },
              prevPin: p
            })
        }
      };
    }
    case "anno": {
      const a = ann.annotations?.find((x) => x.id === eid);
      if (!a) return null;
      const g = a.geometry;
      const typeLabel = a.class === "point_via" ? "Via point" : "Via region";
      const geomRow: [string, ReactNode] =
        g.kind === "point"
          ? ["point", `(${Math.round(g.x)}, ${Math.round(g.y)})`]
          : g.kind === "rectangle"
            ? ["size", `${Math.round(g.width)}×${Math.round(g.height)}`]
            : ["points", `${g.points.length} pts`];
      return {
        typeLabel,
        displayName: `${typeLabel} ${short(a.id)}`,
        uid: a.id,
        rows: [
          ["class", a.class],
          geomRow,
          ...(a.layer ? [["via layer", a.layer] as [string, ReactNode]] : []),
        ]
      };
    }
    case "roi": {
      const r = ann.rois?.find((x) => x.id === eid);
      if (!r) return null;
      const classes = r.classes ?? [];
      return {
        typeLabel: "ML ROI",
        displayName: `ML ROI ${short(r.id)}`,
        uid: r.id,
        rows: [
          ["size", `${r.width}×${r.height}`],
          [
            "labels",
            <AnnotationClassSelect
              key="cls"
              value={classes}
              onChange={(next) =>
                void dispatcher.dispatch({
                  kind: "upsertRoi",
                  roi: { ...r, classes: next },
                  prevRoi: r
                })
              }
            />
          ]
        ]
      };
    }
    case "ignore": {
      const i = ann.ignores?.find((x) => x.id === eid);
      if (!i) return null;
      return {
        typeLabel: "Ignore region",
        displayName: `Ignore region ${short(i.id)}`,
        uid: i.id,
        rows: [["size", `${i.width}×${i.height}`]]
      };
    }
    default: {
      if (!eid) return null;
      const typeLabel = cap(prefix);
      return { typeLabel, displayName: `${typeLabel} ${short(eid)}`, uid: eid };
    }
  }
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function splitId(id: string): [string, string] {
  const i = id.indexOf(":");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

/**
 * Right-side panel: tabbed Inspector / ML. The Inspector shows the selected
 * object's type + name in a common title bar, then its properties (name
 * editable where supported, uid read-only), with a sub-panel for a selected
 * net segment or vertex. ML is intentionally empty for now.
 */
export function InspectorPanel({
  annotations,
  dispatcher,
  dieId,
  mlViasLayer,
  cellTypeCounts,
}: {
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
  dieId: string;
  /** Live ML via layer — the inspector resolves `ml-via:` selection ids
   *  through it to fetch score / class. May be null while the page is still
   *  bootstrapping. */
  mlViasLayer: MLViasLayer | null;
  /** cellTypeId → instance count for relationship display. */
  cellTypeCounts?: Map<string, number>;
}) {
  const tab = usePreferences((s) => s.inspectorTab);
  const setTab = usePreferences((s) => s.setInspectorTab);
  const selectedIds = useDieViewerStore((s) => s.selectedIds);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" }}>
      <div
        className="ph"
        style={{ padding: 0, gap: 0, height: 30 }}
      >
        {(["inspector", "ml"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={"tab" + (tab === k ? " on" : "")}
            style={{ background: "transparent", cursor: "pointer" }}
            onClick={() => setTab(k)}
          >
            {k === "inspector" ? "Inspector" : "ML"}
          </button>
        ))}
      </div>

      <div style={{ flex: "1 1 auto", overflow: "auto", minHeight: 0 }}>
        {tab === "ml" ? (
          <MLPanel dieId={dieId} annotations={annotations} dispatcher={dispatcher} mlViasLayer={mlViasLayer} />
        ) : (
          <InspectorBody
            annotations={annotations}
            dispatcher={dispatcher}
            ids={selectedIds}
            mlViasLayer={mlViasLayer}
            cellTypeCounts={cellTypeCounts}
          />
        )}
      </div>
    </div>
  );
}

function InspectorBody({
  annotations,
  dispatcher,
  ids,
  mlViasLayer,
  cellTypeCounts,
}: {
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
  ids: ReadonlySet<string>;
  mlViasLayer: MLViasLayer | null;
  cellTypeCounts?: Map<string, number>;
}) {
  if (!annotations) return <Empty>loading…</Empty>;
  if (ids.size === 0) return <Empty>Nothing selected</Empty>;
  if (ids.size > 1) return <Empty>{ids.size} items selected</Empty>;

  const only = ids.values().next().value as string;
  const r = resolve(only, annotations, dispatcher, mlViasLayer, cellTypeCounts);
  if (!r) return <Empty>Selection not found</Empty>;

  return (
    <div>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--l1)" }}>
        <div className="u">{r.typeLabel}</div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--ink)",
            marginTop: 3,
            fontFamily: "var(--mono)",
            wordBreak: "break-word"
          }}
        >
          {r.displayName}
        </div>
      </div>

      {r.name && (
        <Prop label="name">
          <NameField uid={r.uid} value={r.name.value} onCommit={r.name.onCommit} />
        </Prop>
      )}
      <Prop label="uid">
        <span
          title={r.uid}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--ink2)"
          }}
        >
          {r.uid}
        </span>
      </Prop>

      {r.rows?.map(([label, value]) => (
        <Prop key={label} label={label}>
          {value}
        </Prop>
      ))}

      {r.sub && (
        <>
          <SubHeader>
            {r.sub.kind} · {short(r.sub.id)}
          </SubHeader>
          {r.sub.rows.map(([label, value]) => (
            <Prop key={label} label={label}>
              {value}
            </Prop>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * The ML tab: an Inference section (model selection, the die-wide inference
 * job + its live progress, confidence threshold) and a Training section
 * (mask sizing + dataset export). Inference job state is shared via WS so
 * progress a teammate triggered shows here too.
 */
function MLPanel({
  dieId,
  annotations,
  dispatcher,
  mlViasLayer
}: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
  mlViasLayer: MLViasLayer | null;
}) {
  return (
    <div>
      <MLSectionHeader>Inference</MLSectionHeader>
      <InferenceSection dieId={dieId} />
      <MLSectionHeader>ML Vias</MLSectionHeader>
      <ApproveSection dieId={dieId} annotations={annotations} dispatcher={dispatcher} mlViasLayer={mlViasLayer} />
      <MLSectionHeader>CV Cell Detection</MLSectionHeader>
      <CVSection dieId={dieId} annotations={annotations} dispatcher={dispatcher} />
      <MLSectionHeader>Training</MLSectionHeader>
      <TrainingSection dieId={dieId} />
    </div>
  );
}

/** Approve ML vias — convert selected predictions to human annotations. */
function ApproveSection({
  annotations,
  dispatcher,
  mlViasLayer
}: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
  mlViasLayer: MLViasLayer | null;
}) {
  const selectedIds = useDieViewerStore((s) => s.selectedIds);
  const mlViaIds = [...selectedIds].filter(isMlViaId);
  const count = mlViaIds.length;
  const vias = (useSession((s) => s.metalStack) ?? DEFAULT_METAL_STACK).vias;

  // Detect via layer from the first selected ML via
  const detectedLayer = count > 0 && mlViasLayer
    ? mlViasLayer.findViaById(mlViaIds[0])?.viaLayer
    : undefined;

  const [selectedViaId, setSelectedViaId] = useState<string | null>(
    detectedLayer && vias.some((v) => v.id === detectedLayer) ? detectedLayer : (vias[0]?.id ?? null)
  );

  // Reset selectedViaId when detectedLayer changes (new selection)
  // We use a ref to track the previous detectedLayer to avoid loop
  const prevDetectedRef = usePrevious(detectedLayer);
  if (detectedLayer !== prevDetectedRef && detectedLayer && vias.some((v) => v.id === detectedLayer)) {
    setSelectedViaId(detectedLayer);
  }

  const approveSelected = async () => {
    if (!mlViasLayer || !annotations || !selectedViaId) return;
    for (const id of mlViaIds) {
      const hit = mlViasLayer.findViaById(id);
      if (!hit) continue;
      void dispatcher.dispatch({
        kind: "upsertAnnotation",
        annotation: {
          id: uuid(),
          class: "point_via",
          geometry: { kind: "point", x: hit.x, y: hit.y },
          source: "approved",
          layer: selectedViaId,
        },
        prevAnnotation: null
      });
    }
  };

  if (count === 0) {
    return (
      <div style={{ padding: "12px" }}>
        <div
          className="m"
          style={{ fontSize: 10.5, color: "var(--ink3)", marginBottom: 10 }}
        >
          Select ML vias on the die to approve them as permanent annotations.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "12px" }}>
      <div
        className="m"
        style={{ fontSize: 10.5, color: "var(--ink3)", marginBottom: 10 }}
      >
        {count} ML via{count > 1 ? "s" : ""} selected.
        {detectedLayer && <span style={{ color: "var(--ink2)" }}> (detected: {detectedLayer})</span>}
      </div>

      {/* Via layer selector */}
      <div
        className="row"
        style={{ gap: 4, flexWrap: "wrap", marginBottom: 10 }}
      >
        <span className="u" style={{ fontSize: 10, minWidth: 40, alignSelf: "center" }}>
          Set as
        </span>
        {vias.map((v) => (
          <button
            key={v.id}
            type="button"
            className={"chip" + (selectedViaId === v.id ? " on" : "")}
            style={{
              cursor: "pointer",
              borderColor: v.color,
              ...(selectedViaId === v.id ? { background: v.color, color: "#000" } : {})
            }}
            onClick={() => setSelectedViaId(v.id)}
          >
            {v.id.toLowerCase()}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="btn"
        style={{ width: "100%", cursor: "pointer" }}
        onClick={() => void approveSelected()}
      >
        Approve as {selectedViaId?.toLowerCase() ?? "via"} ({count})
      </button>
    </div>
  );
}

/** Returns the previous value of a variable across renders. */
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => { ref.current = value; });
  return ref.current;
}

function MLSectionHeader({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "7px 12px",
        borderBottom: "1px solid var(--l1)",
        background: "var(--panel)"
      }}
    >
      <span className="u">{children}</span>
    </div>
  );
}

/** CV cell detection: select a reference cell, run contour matching, place results. */
function CVSection({
  dieId,
  annotations,
  dispatcher
}: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
}) {
  const selectedIds = useDieViewerStore((s) => s.selectedIds);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ count: number } | null>(null);
  const [threshold, setThreshold] = useState(0.5);
  const [rotationSteps, setRotationSteps] = useState(4);
  const [maxMatches, setMaxMatches] = useState(100);
  const [showDebug, setShowDebug] = useState(false);
  const [debugData, setDebugData] = useState<import("shared").CVDebugData | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [tmRunning, setTmRunning] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [minArea, setMinArea] = useState(200);
  const [minDistance, setMinDistance] = useState(10);
  const [shapeThresh, setShapeThresh] = useState(1.5);
  const [areaLo, setAreaLo] = useState(0.8);
  const [areaHi, setAreaHi] = useState(1.2);
  const [aspectThresh, setAspectThresh] = useState(0.5);
  const [solidityThresh, setSolidityThresh] = useState(0.9);
  const [extentThresh, setExtentThresh] = useState(0.9);
  const [circularityThresh, setCircularityThresh] = useState(0.9);

  // Find the selected cell and its cell type
  const selectedCellId = [...selectedIds].find((id) => id.startsWith("cell:"))?.slice(5);
  const selectedCell = annotations?.cells?.find((c) => c.id === selectedCellId);
  const selectedType = selectedCell
    ? annotations?.cellTypes?.find((ct) => ct.id === selectedCell.cellTypeId)
    : null;

  // Check if it has at least one analog device (we can't check directly without
  // the analog device registry, so we rely on the cell type existing)
  const canBeRef = !!selectedType;

  const runDetection = async () => {
    if (!dieId || !selectedCell || !selectedType) return;
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const overlayLayers = useOverlayLayers.getState().layers;
      const visibleOverlay = overlayLayers.find((l) => !l.hidden && l.loaded);
      const res = await cvMatch({
        dieId,
        cellTypeId: selectedType.id,
        cellX: selectedCell.x,
        cellY: selectedCell.y,
        overlayFilename: visibleOverlay?.name,
        threshold,
        rotationSteps,
        maxMatches,
        minArea,
        minDistance,
        shapeThresh,
        areaLo,
        areaHi,
        aspectThresh,
        solidityThresh,
        extentThresh,
        circularityThresh,
      });

      // Place cells for each match
      for (const match of res.matches) {
        if (match.confidence < threshold) continue;
        void dispatcher.dispatch({
          kind: "upsertCell",
          cell: {
            id: uuid(),
            cellTypeId: selectedType.id,
            x: Math.round(match.x - selectedType.cropRect.width / 2),
            y: Math.round(match.y - selectedType.cropRect.height / 2),
            rotation: match.rotation as 0 | 90 | 180 | 270,
            mlDetected: true,
            mlConfidence: match.confidence,
          },
          prevCell: null,
        });
      }
      setResult({ count: res.matches.length });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "CV detection failed");
    } finally {
      setRunning(false);
    }
  };

  const runTemplateDetection = async () => {
    if (!dieId || !selectedCell || !selectedType) return;
    setTmRunning(true);
    setErr(null);
    setResult(null);
    try {
      const overlayLayers = useOverlayLayers.getState().layers;
      const visibleOverlay = overlayLayers.find((l) => !l.hidden && l.loaded);
      const res = await cvTemplateMatch({
        dieId,
        cellTypeId: selectedType.id,
        cellX: selectedCell.x,
        cellY: selectedCell.y,
        overlayFilename: visibleOverlay?.name,
        threshold,
        rotationSteps,
        maxMatches,
      });

      for (const match of res.matches) {
        if (match.confidence < threshold) continue;
        void dispatcher.dispatch({
          kind: "upsertCell",
          cell: {
            id: uuid(),
            cellTypeId: selectedType.id,
            x: Math.round(match.x - selectedType.cropRect.width / 2),
            y: Math.round(match.y - selectedType.cropRect.height / 2),
            rotation: match.rotation as 0 | 90 | 180 | 270,
            mlDetected: true,
            mlConfidence: match.confidence,
          },
          prevCell: null,
        });
      }
      setResult({ count: res.matches.length });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Template matching failed");
    } finally {
      setTmRunning(false);
    }
  };

  return (
    <div style={{ padding: "12px" }}>
      {!selectedCell && (
        <div className="m" style={{ fontSize: 10.5, color: "var(--ink3)", marginBottom: 10 }}>
          Select a cell on the die to use as reference for CV detection.
        </div>
      )}

      {selectedCell && selectedType && (
        <>
          <div
            className="m"
            style={{ fontSize: 10.5, color: "var(--ink2)", marginBottom: 10 }}
          >
            Reference: <span className="u">{selectedType.name}</span>
            <br />
            Crop: {Math.round(selectedType.cropRect.width)}×{Math.round(selectedType.cropRect.height)} px
          </div>

          {/* Confidence threshold */}
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
            <span className="u" style={{ fontSize: 10 }}>Min confidence</span>
            <span className="m" style={{ fontSize: 11, color: "var(--ink2)" }}>{threshold.toFixed(2)}</span>
          </div>
          <input
            type="range" min={0} max={1} step={0.01}
            value={threshold}
            style={{ width: "100%", marginBottom: 8 }}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />

          {/* Rotation steps */}
          <div className="row" style={{ gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="u" style={{ fontSize: 10, alignSelf: "center" }}>
              Rotation
            </span>
            {[1, 2, 4].map((n) => (
              <button
                key={n}
                type="button"
                className={"chip" + (rotationSteps === n ? " on" : "")}
                style={{ cursor: "pointer" }}
                onClick={() => setRotationSteps(n)}
              >
                {n === 4 ? "0°/90°/180°/270°" : n === 2 ? "0°/180°" : "0°"}
              </button>
            ))}
          </div>

          {/* Max matches */}
          <div className="row" style={{ gap: 4, alignItems: "center", marginBottom: 10 }}>
            <span className="u" style={{ fontSize: 10 }}>Max matches</span>
            <input
              type="number" min={1} max={10000}
              value={maxMatches}
              style={{ width: 60, padding: "2px 4px", fontSize: 11, fontFamily: "var(--mono)" }}
              onChange={(e) => setMaxMatches(Math.max(1, Number(e.target.value)))}
            />
          </div>

          {/* Advanced contour params toggle */}
          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer", marginBottom: 6, opacity: 0.55, fontSize: 10 }}
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? "▾ Advanced contour params" : "▸ Advanced contour params"}
          </button>

          {showAdvanced && (
            <div style={{ marginBottom: 8, padding: "6px 8px", background: "var(--l1)", borderRadius: 4, fontSize: 10 }}>
              {/* minArea */}
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 2 }}>
                <span className="u" style={{ fontSize: 9 }}>Min area (px²)</span>
                <span style={{ color: "var(--ink2)", fontFamily: "var(--mono)" }}>{minArea}</span>
              </div>
              <input type="range" min={1} max={5000} step={10} value={minArea}
                style={{ width: "100%", marginBottom: 6 }}
                onChange={(e) => setMinArea(Number(e.target.value))} />

              {/* minDistance */}
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 2 }}>
                <span className="u" style={{ fontSize: 9 }}>NMS min distance (px)</span>
                <span style={{ color: "var(--ink2)", fontFamily: "var(--mono)" }}>{minDistance}</span>
              </div>
              <input type="range" min={1} max={50} step={1} value={minDistance}
                style={{ width: "100%", marginBottom: 6 }}
                onChange={(e) => setMinDistance(Number(e.target.value))} />

              {/* shapeThresh */}
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 2 }}>
                <span className="u" style={{ fontSize: 9 }}>Shape threshold</span>
                <span style={{ color: "var(--ink2)", fontFamily: "var(--mono)" }}>{shapeThresh.toFixed(2)}</span>
              </div>
              <input type="range" min={0.1} max={3.0} step={0.05} value={shapeThresh}
                style={{ width: "100%", marginBottom: 6 }}
                onChange={(e) => setShapeThresh(Number(e.target.value))} />

              {/* areaLo / areaHi */}
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 2 }}>
                <span className="u" style={{ fontSize: 9 }}>Area ratio range</span>
                <span style={{ color: "var(--ink2)", fontFamily: "var(--mono)" }}>{areaLo.toFixed(2)} – {areaHi.toFixed(2)}</span>
              </div>
              <div className="row" style={{ gap: 4, marginBottom: 6 }}>
                <input type="range" min={0.05} max={2.0} step={0.05} value={areaLo}
                  style={{ flex: 1 }}
                  onChange={(e) => setAreaLo(Math.min(Number(e.target.value), areaHi))} />
                <input type="range" min={0.5} max={10.0} step={0.1} value={areaHi}
                  style={{ flex: 1 }}
                  onChange={(e) => setAreaHi(Math.max(Number(e.target.value), areaLo))} />
              </div>

              {/* aspectThresh */}
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 2 }}>
                <span className="u" style={{ fontSize: 9 }}>Aspect threshold</span>
                <span style={{ color: "var(--ink2)", fontFamily: "var(--mono)" }}>{aspectThresh.toFixed(2)}</span>
              </div>
              <input type="range" min={0.1} max={3.0} step={0.05} value={aspectThresh}
                style={{ width: "100%", marginBottom: 6 }}
                onChange={(e) => setAspectThresh(Number(e.target.value))} />

              {/* solidityThresh */}
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 2 }}>
                <span className="u" style={{ fontSize: 9 }}>Solidity threshold</span>
                <span style={{ color: "var(--ink2)", fontFamily: "var(--mono)" }}>{solidityThresh.toFixed(2)}</span>
              </div>
              <input type="range" min={0.05} max={1.0} step={0.05} value={solidityThresh}
                style={{ width: "100%", marginBottom: 6 }}
                onChange={(e) => setSolidityThresh(Number(e.target.value))} />

              {/* extentThresh */}
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 2 }}>
                <span className="u" style={{ fontSize: 9 }}>Extent threshold</span>
                <span style={{ color: "var(--ink2)", fontFamily: "var(--mono)" }}>{extentThresh.toFixed(2)}</span>
              </div>
              <input type="range" min={0.05} max={1.0} step={0.05} value={extentThresh}
                style={{ width: "100%", marginBottom: 6 }}
                onChange={(e) => setExtentThresh(Number(e.target.value))} />

              {/* circularityThresh */}
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 2 }}>
                <span className="u" style={{ fontSize: 9 }}>Circularity threshold</span>
                <span style={{ color: "var(--ink2)", fontFamily: "var(--mono)" }}>{circularityThresh.toFixed(2)}</span>
              </div>
              <input type="range" min={0.05} max={1.0} step={0.05} value={circularityThresh}
                style={{ width: "100%" }}
                onChange={(e) => setCircularityThresh(Number(e.target.value))} />
            </div>
          )}

          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer" }}
            disabled={running}
            onClick={() => void runDetection()}
          >
            {running ? "Running CV detection contour (EXPERIMENTAL)…" : "Run CV detection contour (EXPERIMENTAL)"}
          </button>

          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer", marginTop: 4 }}
            disabled={tmRunning}
            onClick={() => void runTemplateDetection()}
          >
            {tmRunning ? "Running template match…" : "Run CV detection (template)"}
          </button>

          {result && (
            <div className="m" style={{ marginTop: 8, fontSize: 10.5, color: "var(--ink2)" }}>
              Found {result.count} matches — placed as ML-detected cells.
            </div>
          )}

          {err && (
            <div className="m" style={{ marginTop: 8, fontSize: 10.5, color: "var(--danger, #e36854)" }}>
              {err}
            </div>
          )}

          {/* Debug toggle */}
          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer", marginTop: 8, opacity: 0.6 }}
            disabled={debugLoading}
            onClick={async () => {
              if (!showDebug) {
                setDebugLoading(true);
                setDebugData(null);
                try {
                  const ovLayers = useOverlayLayers.getState().layers;
                  const visible = ovLayers.find((l) => !l.hidden && l.loaded);
                  const data = await cvDebug({
                    dieId,
                    cellTypeId: selectedType!.id,
                    cellX: selectedCell.x,
                    cellY: selectedCell.y,
                    overlayFilename: visible?.name,
                    threshold,
                    rotationSteps,
                    minArea,
                    minDistance,
                    shapeThresh,
                    areaLo,
                    areaHi,
                    aspectThresh,
                    solidityThresh,
                    extentThresh,
                    circularityThresh,
                  });
                  setDebugData(data);
                  setShowDebug(true);
                } catch (e) {
                  setErr(e instanceof Error ? e.message : "debug failed");
                } finally {
                  setDebugLoading(false);
                }
              } else {
                setShowDebug(false);
              }
            }}
          >
            {debugLoading ? "Loading debug…" : showDebug ? "Hide debug" : "Debug CV"}
          </button>

          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer", marginTop: 4, opacity: 0.5 }}
            onClick={async () => {
              try {
                const ovLayers = useOverlayLayers.getState().layers;
                const visible = ovLayers.find((l) => !l.hidden && l.loaded);
                const result = await cvDebugDump({
                  dieId,
                  cellTypeId: selectedType!.id,
                  cellX: selectedCell.x,
                  cellY: selectedCell.y,
                  overlayFilename: visible?.name,
                  threshold,
                  rotationSteps,
                  minArea,
                  minDistance,
                  shapeThresh,
                  areaLo,
                  areaHi,
                  aspectThresh,
                  solidityThresh,
                  extentThresh,
                  circularityThresh,
                });
                setErr(`Debug dumped to ${result.dump_path}`);
              } catch (e) {
                setErr(e instanceof Error ? e.message : "dump failed");
              }
            }}
          >
            Dump debug to file
          </button>

          {showDebug && debugData && (
            <div style={{ marginTop: 8, fontSize: 10, color: "var(--ink2)" }}>
              <div className="m" style={{ marginBottom: 4 }}>
                Contours found: {debugData.total_contours_found} · Candidates: {debugData.total_candidates}
              </div>
              {debugData.ref_crop_png_b64 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="u" style={{ fontSize: 9, marginBottom: 2 }}>Reference crop</div>
                  <img src={`data:image/png;base64,${debugData.ref_crop_png_b64}`} alt="ref crop"
                    style={{ maxWidth: "100%", borderRadius: 3 }} />
                </div>
              )}
              {debugData.ref_contour_png_b64 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="u" style={{ fontSize: 9, marginBottom: 2 }}>
                    Reference contours ({debugData.ref_contour_count})
                    {debugData.ref_contours && (() => {
                      const top = debugData.ref_contours!.filter((r) => (r.depth ?? -1) <= 0).length;
                      const nest = debugData.ref_contours!.length - top;
                      return <span style={{ fontSize: 8, color: "var(--ink3)", marginLeft: 2 }}>
                        ({top} outer, {nest} nested)
                      </span>;
                    })()}
                    {debugData.ref_contours?.map((rc, i) => (
                      <span key={i} style={{ fontSize: 8, color: "var(--ink3)", marginLeft: 4 }}>
                        #{i + 1} d={rc.depth ?? "?"} area={rc.area} asp={rc.aspect}
                      </span>
                    ))}
                  </div>
                  <img src={`data:image/png;base64,${debugData.ref_contour_png_b64}`} alt="ref contours"
                    style={{ maxWidth: "100%", borderRadius: 3 }} />
                </div>
              )}
              {debugData.search_preview_png_b64 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="u" style={{ fontSize: 9, marginBottom: 2 }}>
                    Search preview (green=top20, red=candidates)
                  </div>
                  <img src={`data:image/jpeg;base64,${debugData.search_preview_png_b64}`} alt="search preview"
                    style={{ maxWidth: "100%", borderRadius: 3 }} />
                </div>
              )}
              {debugData.top_matches.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="u" style={{ fontSize: 9, marginBottom: 2 }}>Top matches</div>
                  <div style={{ maxHeight: 200, overflow: "auto" }}>
                    {debugData.top_matches.map((m, i) => (
                      <div key={i} style={{ padding: "2px 0", borderBottom: "1px solid var(--l1)", fontSize: 9 }}>
                        #{i + 1} conf={m.confidence} score={m.total_score}
                        shape={m.shape_dist} area={m.area_ratio}
                        aspect={m.aspect_err} solidity={m.solidity_err}
                        centroid=({m.centroid[0]},{m.centroid[1]})
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {debugData.clusters && debugData.clusters.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="u" style={{ fontSize: 9, marginBottom: 2 }}>
                    Clusters ({debugData.clusters.filter((c) => c.passed).length} passed of {debugData.clusters.length})
                  </div>
                  <div style={{ maxHeight: 200, overflow: "auto" }}>
                    {debugData.clusters.map((cl, i) => (
                      <div key={i} style={{
                        padding: "2px 0", borderBottom: "1px solid var(--l1)", fontSize: 9,
                        color: cl.passed ? "var(--green, #4caf50)" : "var(--ink3)",
                      }}>
                        #{i + 1} {cl.passed ? "PASS" : "FAIL"} centroide=({cl.centroid[0]},{cl.centroid[1]})
                        conf={cl.confidence} ref_ids=[{cl.ref_ids.join(",")}] n_matches={cl.n_matches}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const SELECT_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--panel)",
  color: "var(--ink)",
  border: "1px solid var(--l1)",
  borderRadius: 4,
  padding: "3px 6px",
  fontSize: 11,
  fontFamily: "var(--mono)"
};

function jobStatusLine(job: MLInferenceJob | null | undefined): string {
  if (!job) return "—";
  const { status, completedTiles: done, totalTiles: total, percentage } = job;
  if (status === "running")
    return `Running · ${done}/${total} tiles (${percentage}%)`;
  if (status === "completed") return `Complete · ${total} tiles`;
  if (status === "failed")
    return `Failed${job.error ? ` · ${job.error}` : ""}`;
  if (done > 0)
    return `Stopped · ${done}/${total} tiles cached (${percentage}%)`;
  return `Idle · 0/${total} tiles`;
}

/** Model dropdown, start/stop, live job progress, confidence threshold. */
function InferenceSection({ dieId }: { dieId: string }) {
  const qc = useQueryClient();
  const models = useMLModels();
  const status = useMLStatus();
  const job = useMLJob(dieId);
  const confidence = usePreferences((s) => s.viaConfidenceThreshold);
  const setConfidence = usePreferences((s) => s.setViaConfidenceThreshold);
  const [busy, setBusy] = useState<null | "model" | "job">(null);
  const [err, setErr] = useState<string | null>(null);

  const modelList = models.data?.models ?? [];
  const residentName =
    modelList.find((m) => m.resident)?.name ?? status.data?.checkpoint ?? "";
  const running = job.data?.status === "running";
  const sidecarDown = status.data?.reachable === false;

  const switchModel = async (name: string) => {
    if (!name || name === residentName) return;
    if (
      !window.confirm(
        "Switching the model clears every cached inference result for all " +
          "dies — you'll need to re-run inference. Continue?"
      )
    )
      return;
    setBusy("model");
    setErr(null);
    try {
      await selectMLModel(name);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["mlModels"] }),
        qc.invalidateQueries({ queryKey: ["mlStatus"] }),
        qc.invalidateQueries({ queryKey: mlJobKey(dieId) })
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "model switch failed");
    } finally {
      setBusy(null);
    }
  };

  const overlayLayers = useOverlayLayers((s) => s.layers);
  const visibleOverlay = overlayLayers.find((l) => !l.hidden && l.loaded);
  const overlayName = visibleOverlay?.name ?? null;

  const toggleJob = async () => {
    setBusy("job");
    setErr(null);
    try {
      const next = running ? await stopMLJob(dieId) : await startMLJob(dieId, overlayName ?? undefined);
      qc.setQueryData(mlJobKey(dieId), next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "inference job failed");
    } finally {
      setBusy(null);
    }
  };

  const pct = job.data?.percentage ?? 0;

  return (
    <div style={{ padding: "12px" }}>
      {/* Model selection */}
      <div
        className="row"
        style={{ gap: 8, alignItems: "center", marginBottom: 10 }}
      >
        <span className="u" style={{ fontSize: 10, minWidth: 38 }}>
          Model
        </span>
        <select
          value={modelList.length > 0 ? residentName : ""}
          disabled={busy !== null || running || modelList.length === 0}
          onChange={(e) => void switchModel(e.target.value)}
          style={SELECT_STYLE}
        >
          {modelList.length === 0 && (
            <option value="">
              {sidecarDown ? "sidecar offline" : "no models"}
            </option>
          )}
          {modelList.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      {/* Source badge */}
      <div
        className="row"
        style={{ gap: 8, alignItems: "center", marginBottom: 8, fontSize: 10, color: "var(--ink3)" }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          Source
        </span>
        <span className="m">
          {overlayName ? `overlay: ${overlayName}` : "base image"}
        </span>
      </div>

      {/* Start / stop */}
      <button
        type="button"
        className="btn"
        style={{ width: "100%", cursor: "pointer" }}
        disabled={busy !== null || sidecarDown}
        onClick={() => void toggleJob()}
      >
        {busy === "job"
          ? "…"
          : running
            ? "Stop inference"
            : "Start inference"}
      </button>

      {/* Job status + progress */}
      <div
        className="m"
        style={{ fontSize: 10.5, color: "var(--ink2)", margin: "8px 0 6px" }}
      >
        {jobStatusLine(job.data)}
      </div>
      <div
        style={{
          height: 5,
          borderRadius: 3,
          background: "var(--l1)",
          overflow: "hidden"
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.min(100, Math.max(0, pct))}%`,
            background: "var(--accent, #7fb2ff)",
            transition: "width 0.2s"
          }}
        />
      </div>

      {err && (
        <div
          className="m"
          style={{
            marginTop: 8,
            fontSize: 10.5,
            color: "var(--danger, #e36854)",
            wordBreak: "break-word"
          }}
        >
          {err}
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--l1)", margin: "14px 0 12px" }} />

      {/* Confidence threshold */}
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 4 }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          Confidence threshold
        </span>
        <span className="m" style={{ fontSize: 11, color: "var(--ink2)" }}>
          {confidence.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={confidence}
        style={{ width: "100%" }}
        onChange={(e) => setConfidence(Number(e.target.value))}
      />
      <div
        className="m"
        style={{ fontSize: 10, color: "var(--ink3)", marginTop: 4 }}
      >
        Filters ML vias below this model confidence.
      </div>
    </div>
  );
}

/** Mask sizing (source-px) + dataset export. */
function TrainingSection({ dieId }: { dieId: string }) {
  const mlConfig = useDieViewerStore((s) => s.mlConfig);
  const setMlConfig = useDieViewerStore((s) => s.setMlConfig);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<
    { ok: true } | { ok: false; msg: string } | null
  >(null);
  const overlayLayers = useOverlayLayers((s) => s.layers);
  const visibleOverlay = overlayLayers.find((l) => !l.hidden && l.loaded);
  const overlayName = visibleOverlay?.name ?? undefined;

  const runExport = async () => {
    setExporting(true);
    setResult(null);
    try {
      await exportMlData(dieId, Math.max(1, Math.round(mlConfig.pointViaSize)), overlayName);
      setResult({ ok: true });
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : "failed" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{ padding: "12px 12px 16px" }}>
      <div
        className="m"
        style={{ fontSize: 10.5, color: "var(--ink3)", marginBottom: 10 }}
      >
        Real-die sizes baked into the generated training pixel masks. The
        canvas previews these while this tab is open.
      </div>

      <div
        className="row"
        style={{ gap: 8, alignItems: "center", marginBottom: 8, fontSize: 10, color: "var(--ink3)" }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          Source
        </span>
        <span className="m">
          {overlayName ? `overlay: ${overlayName}` : "base image"}
        </span>
      </div>

      <MLSlider
        label="Trace width"
        min={1}
        max={40}
        value={mlConfig.traceWidth}
        onChange={(v) => setMlConfig({ traceWidth: v })}
      />
      <MLSlider
        label="Via size"
        min={1}
        max={30}
        value={mlConfig.pointViaSize}
        onChange={(v) => setMlConfig({ pointViaSize: v })}
      />

      <div style={{ borderTop: "1px solid var(--l1)", margin: "14px 0 12px" }} />

      <button
        type="button"
        className="btn"
        style={{ width: "100%", cursor: "pointer" }}
        disabled={exporting}
        onClick={() => void runExport()}
      >
        {exporting ? "Exporting…" : "Export training data"}
      </button>
      {result && (
        <div
          className="m"
          style={{
            marginTop: 8,
            fontSize: 10.5,
            color: result.ok ? "var(--ink2)" : "var(--danger, #e36854)",
            wordBreak: "break-word"
          }}
        >
          {result.ok
            ? "Export started — written to the server's ML exports dir (see server logs)."
            : `Export failed: ${result.msg}`}
        </div>
      )}

      <button
        type="button"
        className="btn"
        style={{ width: "100%", marginTop: 8, opacity: 0.55 }}
        disabled
        title="Not implemented yet"
      >
        Start training
      </button>
      <div
        className="m"
        style={{ fontSize: 10, color: "var(--ink3)", marginTop: 4 }}
      >
        Training from the UI not available yet, please use the CLI.
      </div>
    </div>
  );
}

function MLSlider({
  label,
  min,
  max,
  value,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 4 }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          {label}
        </span>
        <span
          className="m"
          style={{ fontSize: 11, color: "var(--ink2)" }}
        >
          {value} px
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        style={{ width: "100%" }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 120,
        fontSize: 11,
        color: "var(--ink3)"
      }}
    >
      {children}
    </div>
  );
}
