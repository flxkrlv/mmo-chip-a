import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type {
  Cell,
  ForcedDiffusionType,
  LayerShape,
  LayerType,
  ShapeLabel
} from "shared";
import { AppShell } from "../components/shell/AppShell";
import { StatusBar } from "../components/shell/StatusBar";
import { SubBar } from "../components/shell/SubBar";
import { Ic } from "../icons";
import { useDie } from "../api/dies";
import { useAnnotations } from "../api/annotations";
import { useAnnotationsWebSocket } from "../api/annotationsWebSocket";
import { useActionDispatcher } from "../api/actions";
import { useSession } from "../state/session";
import { useCellREStore, TOOL_LAYERS } from "../state/cellRE";
import { usePreferences } from "../state/preferences";
import { fitRectViewport } from "../renderer/TiledCanvas";
import { isTypingTarget } from "../lib/keyboard";
import {
  PASTE_OFFSET,
  resolveActiveCell,
  snapshotForClipboard
} from "../lib/cellRE";
import {
  buildInsertShapesAction,
  buildRemoveShapesAction,
  buildRenameCellTypeAction,
  buildSetShapeCustomNameAction,
  buildSetShapeForcedTypesAction,
  buildSetShapeLabelsAction,
  translateShape
} from "../lib/cellLayers";
import {
  buildOrientAction,
  buildUnmatchAction,
  cellCropUrl,
  cellTypeById,
  cellTypeCropUrl,
  membersOf,
  rotateCw
} from "../lib/mergeCells";
import {
  CellRECanvas,
  type CellRECanvasHandle,
  type CanvasHoverTarget
} from "../components/cellRE/CellRECanvas";
import {
  canvasHoverToEntity,
  entityToImageShapeKeys,
  type HoverEntity
} from "../components/cellRE/hoverEntity";
import { CellREToolbar } from "../components/cellRE/CellREToolbar";
import { CellRELeftPanel } from "../components/cellRE/CellRELeftPanel";
import { CellRERightPanel } from "../components/cellRE/CellRERightPanel";
import { SchematicCanvas } from "../components/cellRE/SchematicCanvas";
import { LogicSchematicCanvas } from "../components/cellRE/LogicSchematicCanvas";
import {
  CellREContextMenu,
  type ReContextMenuState
} from "../components/cellRE/CellREContextMenu";
import {
  ShapeContextMenu,
  type AppliedForcedType,
  type AppliedLabel,
  type ShapeContextMenuState
} from "../components/cellRE/ShapeContextMenu";
import type { CellType } from "shared";
import { useLayerPolyTool } from "../components/cellRE/useLayerPolyTool";
import { useLayerPolylineTool } from "../components/cellRE/useLayerPolylineTool";
import { parseShapeKey, shapeKey } from "../state/cellRE";
import { useCellExtraction } from "../api/cellExtraction";
import { netDisplayName } from "../lib/labels";
import type { CellExtraction, ExtractedNet } from "../lib/extraction";

export function RECellPage() {
  const [params] = useSearchParams();
  const sessionDieId = useSession((s) => s.dieId);
  const setSessionDieId = useSession((s) => s.setDieId);
  const dieId = params.get("die") ?? sessionDieId ?? null;

  useEffect(() => {
    if (dieId && dieId !== sessionDieId) setSessionDieId(dieId);
  }, [dieId, sessionDieId, setSessionDieId]);

  if (!dieId) {
    return (
      <AppShell breadcrumb="RE cell">
        <Centered>Open a die from the Library to reverse-engineer cells.</Centered>
      </AppShell>
    );
  }
  return <RE key={dieId} dieId={dieId} />;
}

function RE({ dieId }: { dieId: string }) {
  const navigate = useNavigate();
  const [params, setSearchParams] = useSearchParams();
  const die = useDie(dieId).data;
  const annotationsQ = useAnnotations(dieId);
  useAnnotationsWebSocket(dieId);
  const annotations = annotationsQ.data;
  const dispatcher = useActionDispatcher(dieId);

  // ── State (transient page + persisted prefs) ───────────────────────
  const activeCellTypeId = useCellREStore((s) => s.activeCellTypeId);
  const activeCellId = useCellREStore((s) => s.activeCellId);
  const activeTool = useCellREStore((s) => s.activeTool);
  const activeLayer = useCellREStore((s) => s.activeLayer);
  const selectedShapeIds = useCellREStore((s) => s.selectedShapeIds);
  const clipboard = useCellREStore((s) => s.clipboard);
  const canvasTab = useCellREStore((s) => s.canvasTab);
  const activeDomainId = useCellREStore((s) => s.activeDomainId);
  const setActiveDomainId = useCellREStore((s) => s.setActiveDomainId);
  const setActiveCellType = useCellREStore((s) => s.setActiveCellType);
  const setActiveTool = useCellREStore((s) => s.setActiveTool);
  const setActiveLayer = useCellREStore((s) => s.setActiveLayer);
  const setSelectedShapeIds = useCellREStore((s) => s.setSelectedShapeIds);
  const setClipboard = useCellREStore((s) => s.setClipboard);
  const setCanvasTab = useCellREStore((s) => s.setCanvasTab);

  const layerHidden = usePreferences((s) => s.reLayerHidden);

  const canvasRef = useRef<CellRECanvasHandle | null>(null);
  const [menu, setMenu] = useState<ReContextMenuState | null>(null);
  const [shapeMenu, setShapeMenu] = useState<ShapeContextMenuState | null>(null);
  // What the canvas cursor is currently over. Page-local because two
  // consumers want it (status bar + right-panel row highlight) and both
  // are in this subtree.
  const [canvasHover, setCanvasHover] = useState<CanvasHoverTarget | null>(null);
  // Single source of truth for "what is the user pointing at?" — fed by
  // schematic-side hovers AND right-panel row hovers. Image-canvas cursor
  // hovers go through `canvasHover` (which carries extra subRegion info
  // for the status bar) and are folded into an entity below.
  //
  // Why typed instead of a Set<shapeKey>? See hoverEntity.ts — the
  // shape-key approach caused over-highlight via sub-region → parent-diff
  // folding (two nets sharing a diffusion parent looked "related" to
  // every consumer).
  const [hoveredEntity, setHoveredEntity] = useState<HoverEntity>(null);

  // Selection is an image-tab concept (canvas halos + right-panel-row
  // accent). Switching tabs clears it so the user lands in a fresh state
  // every time they bounce between image and schematic — leftover
  // selection from a previous session would just confuse on return.
  useEffect(() => {
    setSelectedShapeIds(new Set());
  }, [canvasTab, setSelectedShapeIds]);

  // Hover entity references net / transistor / domain ids that don't
  // outlive the current cell type — drop it when the active type changes
  // so a stale id can't ghost-match against the new cell's rows.
  useEffect(() => {
    setHoveredEntity(null);
    setCanvasHover(null);
  }, [activeCellTypeId]);

  // ── URL ↔ store sync ──────────────────────────────────────────────
  // One-shot hydration on mount: `?type=&cell=&tab=` seeds the store so a
  // refresh (or a deep link) lands the user on the same cell and tab.
  // useLayoutEffect so the set fires before the auto-select-first effect
  // below sees `activeCellTypeId` still null and overrides the URL choice.
  const hydratedFromUrlRef = useRef(false);
  useLayoutEffect(() => {
    if (hydratedFromUrlRef.current) return;
    hydratedFromUrlRef.current = true;
    const type = params.get("type");
    const cell = params.get("cell");
    if (type) setActiveCellType(type, cell);
    // Only honour the tab param when it's a non-default value — keeps
    // the URL clean for first-time visits (cell-image is the implicit
    // default the URL doesn't have to spell out).
    const tab = params.get("tab");
    if (tab === "schematic") setCanvasTab("schematic");
    else if (tab === "logic") setCanvasTab("logicSchematic");
  }, [params, setActiveCellType, setCanvasTab]);

  // Write the active type / cell / tab back into the URL whenever they
  // change. Uses `replace` so per-click switching doesn't pollute the
  // back-button history. Diffs first so the store→URL→params→effect loop
  // self-terminates. `tab` is omitted when it's the default ("image") so
  // the URL stays compact.
  useEffect(() => {
    if (!hydratedFromUrlRef.current) return;
    const next = new URLSearchParams(params);
    let changed = false;
    if (activeCellTypeId) {
      if (next.get("type") !== activeCellTypeId) {
        next.set("type", activeCellTypeId);
        changed = true;
      }
    } else if (next.has("type")) {
      next.delete("type");
      changed = true;
    }
    if (activeCellId) {
      if (next.get("cell") !== activeCellId) {
        next.set("cell", activeCellId);
        changed = true;
      }
    } else if (next.has("cell")) {
      next.delete("cell");
      changed = true;
    }
    // The URL uses short tokens: "schematic" + "logic" (vs the store's
    // longer "logicSchematic"). Keeps the URL bar readable for shared
    // deep links.
    const tabToken =
      canvasTab === "schematic" ? "schematic"
      : canvasTab === "logicSchematic" ? "logic"
      : null;
    if (tabToken) {
      if (next.get("tab") !== tabToken) {
        next.set("tab", tabToken);
        changed = true;
      }
    } else if (next.has("tab")) {
      next.delete("tab");
      changed = true;
    }
    if (changed) setSearchParams(next, { replace: true });
  }, [activeCellTypeId, activeCellId, canvasTab, params, setSearchParams]);

  // ── Resolve current cell type + instance ──────────────────────────
  const { cellType, cell } = useMemo(() => {
    if (!annotations) return { cellType: null, cell: null };
    return resolveActiveCell(annotations, activeCellTypeId, activeCellId);
  }, [annotations, activeCellTypeId, activeCellId]);

  // ── Cell extraction (shared between canvas + right panel) ────────
  // Single-source the hook here so the canvas's diffusion-type overlay and
  // the right panel's lists render off the same memoised result. Re-runs
  // whenever `cellType` identity changes (every annotation edit).
  const extraction = useCellExtraction(cellType);

  // Resolve the schematic's active domain. Falls back to the first domain
  // when the stored id is stale (different cell, deleted shape) or unset.
  // The render auto-selects, so the user lands on something when they
  // switch to the Schematic tab for the first time.
  const activeDomain = useMemo(() => {
    if (!extraction.data || extraction.data.kind !== "inferred") return null;
    const list = extraction.data.domains;
    if (list.length === 0) return null;
    return list.find((d) => d.id === activeDomainId) ?? list[0];
  }, [extraction.data, activeDomainId]);


  // Hover-driven status string for the status bar — derived directly from
  // the (richer) canvas hover target since it still carries the sub-region
  // info that's strictly an image-canvas thing.
  const hoverStatus = useMemo(
    () => describeHoverTarget(canvasHover, extraction.data),
    [canvasHover, extraction.data],
  );
  // Effective hover entity — what every consumer (image canvas dim/halo,
  // right-panel rows, schematic narrow highlight) actually reads. The page
  // sets `hoveredEntity` directly from schematic + right-panel hovers; the
  // image canvas's `canvasHover` (cursor-on-shape) folds in via
  // `canvasHoverToEntity` as a fallback so the inverse mapping (image →
  // panel row) still works without making the canvas component aware of
  // the typed entity machinery.
  const effectiveHover: HoverEntity = useMemo(
    () => hoveredEntity ?? canvasHoverToEntity(canvasHover, extraction.data),
    [hoveredEntity, canvasHover, extraction.data],
  );
  // Concrete shape keys for the image canvas — resolution lives in the
  // entity helper so the dim+brighten pass keeps its existing Set<string>
  // API but no longer suffers cross-net leakage at the parent-diff fold.
  const imageHoverKeys = useMemo(
    () => entityToImageShapeKeys(effectiveHover, extraction.data),
    [effectiveHover, extraction.data],
  );

  // Auto-select the first available cell type when there's nothing yet.
  // Runs after URL hydration (above), so a deep link's `?type=` wins.
  useEffect(() => {
    if (!annotations || activeCellTypeId) return;
    const first =
      annotations.cellTypes.find((c) => c.matched === true) ??
      annotations.cellTypes[0] ??
      null;
    if (first) setActiveCellType(first.id, null);
  }, [annotations, activeCellTypeId, setActiveCellType]);

  // If the URL points at a stale cell type (deleted between sessions) the
  // initial hydration set a non-existent id; once annotations load, drop
  // back to the auto-select path so the page stays usable.
  useEffect(() => {
    if (!annotations || !activeCellTypeId) return;
    if (!annotations.cellTypes.some((ct) => ct.id === activeCellTypeId)) {
      setActiveCellType(null, null);
    }
  }, [annotations, activeCellTypeId, setActiveCellType]);

  // Switching the active tool to one whose layer doesn't accept the current
  // layer (e.g. rect → point: "polysilicon" isn't in TOOL_LAYERS.point)
  // re-defaults to the tool's first valid layer.
  useEffect(() => {
    if (activeTool === "select" || activeTool === "pan") return;
    const allowed = TOOL_LAYERS[activeTool];
    if (!allowed.includes(activeLayer)) setActiveLayer(allowed[0]);
  }, [activeTool, activeLayer, setActiveLayer]);

  // ── Polygon draft (page-level for global ⌘Z + Enter / Esc) ────────
  const poly = useLayerPolyTool({
    dispatcher,
    cellType,
    activeLayer,
    active: activeTool === "polygon"
  });

  const polyline = useLayerPolylineTool({
    dispatcher,
    cellType,
    activeLayer,
    active: activeTool === "polyline",
  });

  // ── Cell orientation (right-click) ────────────────────────────────
  const orient = useCallback(
    (
      target: Cell,
      patch: Partial<Pick<Cell, "flippedH" | "flippedV" | "rotation">>
    ) => {
      void dispatcher.dispatch(buildOrientAction(target, patch));
    },
    [dispatcher]
  );

  const doUnmatch = useCallback(
    (target: Cell) => {
      if (!annotations) return;
      void dispatcher.dispatch(buildUnmatchAction(annotations, target));
    },
    [annotations, dispatcher]
  );

  const jumpToDie = useCallback(
    (target: Cell) => {
      const ct = annotations ? cellTypeById(annotations, target.cellTypeId) : null;
      if (ct) {
        const rect = {
          x: target.x,
          y: target.y,
          width: ct.cropRect.width || 64,
          height: ct.cropRect.height || 64
        };
        const v = fitRectViewport(
          rect,
          Math.max(320, window.innerWidth - 568),
          Math.max(240, window.innerHeight - 140),
          80,
          4
        );
        usePreferences.getState().saveViewport(dieId, v);
      }
      navigate(`/die/${dieId}`);
    },
    [annotations, dieId, navigate]
  );

  // ── Clipboard (⌘C / ⌘V) ──────────────────────────────────────────
  const doCopy = useCallback(() => {
    if (!cellType || selectedShapeIds.size === 0) return;
    setClipboard(snapshotForClipboard(cellType, selectedShapeIds));
  }, [cellType, selectedShapeIds, setClipboard]);

  const doPaste = useCallback(() => {
    if (!cellType || clipboard.length === 0) return;
    // Default to pasting all into the active layer if it's a sensible target
    // (i.e. the active layer matches the source layer of every item), else
    // each item lands back in its original layer. Either way new ids and an
    // offset so the duplicates are obviously distinct from anything below.
    const uniformLayer =
      clipboard.every((c) => c.layer === activeLayer) ? activeLayer : null;
    // Group by destination layer.
    const byLayer = new Map<LayerType, LayerShape[]>();
    for (const item of clipboard) {
      const layer = uniformLayer ?? item.layer;
      const shape = translateShape(item.shape, PASTE_OFFSET, PASTE_OFFSET);
      let arr = byLayer.get(layer);
      if (!arr) {
        arr = [];
        byLayer.set(layer, arr);
      }
      arr.push(shape);
    }
    // Sequential inserts so each upsert sees the previous edit's CellType.
    let working = cellType;
    const newKeys = new Set<string>();
    const actions = [];
    for (const [layer, shapes] of byLayer) {
      const { action, insertedIds } = buildInsertShapesAction(working, layer, shapes);
      if (action.kind === "upsertCellType") working = action.cellType;
      actions.push(action);
      for (const id of insertedIds) newKeys.add(`${layer}:${id}`);
    }
    if (actions.length === 1) void dispatcher.dispatch(actions[0]);
    else void dispatcher.dispatch({ kind: "batch", actions });
    setSelectedShapeIds(newKeys);
  }, [cellType, clipboard, activeLayer, dispatcher, setSelectedShapeIds]);

  // ── Shape-menu action handlers ────────────────────────────────────
  //
  // The right-click menu can act on the multi-selection (Duplicate / Copy /
  // Delete) OR on a single specific shape (Set label / Force diffusion type).
  // We funnel everything through the existing dispatcher so undo/redo treats
  // a menu click identically to a keyboard shortcut.

  /** Duplicate every currently-selected shape in place (offset by
   *  PASTE_OFFSET, same layer, fresh ids) and switch the selection to the
   *  copies — same behaviour as Copy + Paste but skips the clipboard. */
  const doDuplicate = useCallback(() => {
    if (!cellType || selectedShapeIds.size === 0) return;
    const snap = snapshotForClipboard(cellType, selectedShapeIds);
    if (snap.length === 0) return;
    const byLayer = new Map<LayerType, LayerShape[]>();
    for (const item of snap) {
      const shape = translateShape(item.shape, PASTE_OFFSET, PASTE_OFFSET);
      const arr = byLayer.get(item.layer) ?? [];
      arr.push(shape);
      byLayer.set(item.layer, arr);
    }
    let working = cellType;
    const newKeys = new Set<string>();
    const actions = [];
    for (const [layer, shapes] of byLayer) {
      const { action, insertedIds } = buildInsertShapesAction(working, layer, shapes);
      if (action.kind === "upsertCellType") working = action.cellType;
      actions.push(action);
      for (const id of insertedIds) newKeys.add(shapeKey(layer, id));
    }
    if (actions.length === 1) void dispatcher.dispatch(actions[0]);
    else void dispatcher.dispatch({ kind: "batch", actions });
    setSelectedShapeIds(newKeys);
  }, [cellType, selectedShapeIds, dispatcher, setSelectedShapeIds]);

  /** Delete the current selection. Mirrors the Delete/Backspace path the
   *  canvas already handles, just driven from the menu. */
  const doDelete = useCallback(() => {
    if (!cellType || selectedShapeIds.size === 0) return;
    const removals: Array<{ layer: LayerType; id: string }> = [];
    for (const k of selectedShapeIds) {
      const p = parseShapeKey(k);
      if (p) removals.push(p);
    }
    const action = buildRemoveShapesAction(cellType, removals);
    if (action) void dispatcher.dispatch(action);
    setSelectedShapeIds(new Set());
  }, [cellType, selectedShapeIds, dispatcher, setSelectedShapeIds]);

  /** Set / clear `label` on every selected shape compatible with the menu's
   *  category. Only the METAL label group goes through here now — diffusion
   *  has its own dedicated `forcedType` field handled by `doSetForcedType`
   *  below. The right-clicked shape is always in the selection (the canvas
   *  auto-selects on right-click), so iterating `selectedShapeIds` always
   *  includes it. Returns silently when every applicable shape already
   *  carries the requested label. */
  const doSetLabel = useCallback(
    (target: ShapeContextMenuState, label: ShapeLabel | null) => {
      if (!cellType) return;
      const allowedLayers = labelLayersFor(target.layer);
      const targets: Array<{ layer: LayerType; id: string }> = [];
      for (const key of selectedShapeIds) {
        const p = parseShapeKey(key);
        if (p && allowedLayers.has(p.layer)) targets.push(p);
      }
      // Fallback: if for some reason the right-clicked shape isn't in the
      // selection, label it solo. Keeps the menu predictable even if the
      // canvas's auto-select path is bypassed (e.g. via a future hotkey).
      if (targets.length === 0) {
        targets.push({ layer: target.layer, id: target.shape.id });
      }
      const action = buildSetShapeLabelsAction(cellType, targets, label);
      if (action) void dispatcher.dispatch(action);
    },
    [cellType, selectedShapeIds, dispatcher]
  );

  /** Set / clear `forcedType` on every selected diffusion. Mirrors the label
   *  handler but only ever touches diffusion shapes — the menu's
   *  forced-type group is gated to `layer === "diffusion"`. */
  const doSetForcedType = useCallback(
    (target: ShapeContextMenuState, type: ForcedDiffusionType | null) => {
      if (!cellType) return;
      const targets: Array<{ layer: LayerType; id: string }> = [];
      for (const key of selectedShapeIds) {
        const p = parseShapeKey(key);
        if (p && p.layer === "diffusion") targets.push(p);
      }
      if (targets.length === 0) {
        targets.push({ layer: target.layer, id: target.shape.id });
      }
      const action = buildSetShapeForcedTypesAction(cellType, targets, type);
      if (action) void dispatcher.dispatch(action);
    },
    [cellType, selectedShapeIds, dispatcher]
  );

  // ── Page-level keyboard shortcuts ─────────────────────────────────
  //   ⌘Z / ⌘⇧Z — undo / redo (respects polygon-draft override)
  //   V select · M pan · R rect · P polygon · X point
  //   ⌘C / ⌘V — copy / paste selected shapes (cross-cell-type supported)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void dispatcher.redo();
        else void dispatcher.undo();
        return;
      }
      if (meta && e.key.toLowerCase() === "c") {
        e.preventDefault();
        doCopy();
        return;
      }
      if (meta && e.key.toLowerCase() === "v") {
        e.preventDefault();
        doPaste();
        return;
      }
      if (meta || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case "v":
          setActiveTool("select");
          break;
        case "m":
          setActiveTool("pan");
          break;
        case "r":
          setActiveTool("rect");
          break;
        case "p":
          setActiveTool("polygon");
          break;
        case "x":
          setActiveTool("point");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatcher, setActiveTool, doCopy, doPaste]);

  // ── Status bar fragments ──────────────────────────────────────────
  const baseImageName = die?.originalFilename ?? die?.name ?? "base image";
  // Prefer the specific instance crop (carries instance position / orientation
  // metadata); fall back to the cell-type crop template when the type has no
  // member instances yet (rare, but the page still needs imagery to draw on).
  const imageUrl = cell
    ? cellCropUrl(dieId, cell)
    : cellType
      ? cellTypeCropUrl(dieId, cellType.id)
      : null;
  const cellInstanceCount = cellType
    ? membersOf(annotations!, cellType.id).length
    : 0;

  return (
    <AppShell
      breadcrumb={die?.name ?? "RE cell"}
      meta={
        cellType
          ? `re · ${cellType.name}${cell ? ` · cell ${cell.id.slice(0, 6)}` : ""}`
          : "re"
      }
      onUndo={() => void dispatcher.undo()}
      onRedo={() => void dispatcher.redo()}
      canUndo={dispatcher.canUndo}
      canRedo={dispatcher.canRedo}
    >
      <SubBar
        right={
          <button
            className="btn"
            disabled
            title="Base image (one per die for now)"
            style={{ maxWidth: 220 }}
          >
            {Ic.image}
            <span
              className="m"
              style={{
                fontSize: 10.5,
                marginLeft: 4,
                overflow: "hidden",
                textOverflow: "ellipsis"
              }}
            >
              {baseImageName}
            </span>
            {Ic.caret}
          </button>
        }
      >
        <CellREToolbar
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          activeLayer={activeLayer}
          setActiveLayer={setActiveLayer}
          polyDraftLen={poly.points.length}
        />
      </SubBar>

      <main
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex"
        }}
      >
        {annotations ? (
          <CellRELeftPanel
            annotations={annotations}
            onCellContextMenu={(c, x, y) => {
              const canUnmatch =
                membersOf(annotations, c.cellTypeId).length > 1;
              setMenu({ x, y, cellId: c.id, canUnmatch });
            }}
          />
        ) : (
          <div style={{ width: 248, flex: "0 0 auto", background: "var(--card)" }} />
        )}

        <div className="col" style={{ flex: "1 1 auto", minWidth: 0, minHeight: 0 }}>
          {/* Tab strip above the canvas. Three views on the same cell:
              the image (editing), the CMOS-level schematic (per-domain
              transistor view), and the logic-level abstraction (the
              cell as a tree of gate symbols). */}
          <div
            style={{
              height: 30,
              borderBottom: "1px solid var(--l2)",
              background: "var(--panel)",
              display: "flex",
              alignItems: "center",
              padding: "0 8px",
              gap: 0
            }}
          >
            <button
              type="button"
              className={"tab" + (canvasTab === "image" ? " on" : "")}
              onClick={() => setCanvasTab("image")}
              style={tabStyle(canvasTab === "image")}
            >
              cell image
            </button>
            <button
              type="button"
              className={"tab" + (canvasTab === "schematic" ? " on" : "")}
              onClick={() => setCanvasTab("schematic")}
              style={tabStyle(canvasTab === "schematic")}
              title="CMOS-level schematic, per domain"
            >
              schematic (cmos)
            </button>
            <button
              type="button"
              className={"tab" + (canvasTab === "logicSchematic" ? " on" : "")}
              onClick={() => setCanvasTab("logicSchematic")}
              style={tabStyle(canvasTab === "logicSchematic")}
              title="Logic-level schematic — gates instead of transistors"
            >
              schematic (logic)
            </button>
            <div style={{ flex: 1 }} />
            {cellType && (
              <span
                className="m"
                style={{ fontSize: 10.5, color: "var(--ink3)" }}
              >
                {cellType.name} ·{" "}
                {Math.round(cellType.cropRect.width)}×{Math.round(cellType.cropRect.height)} px ·{" "}
                {cellInstanceCount} instance{cellInstanceCount === 1 ? "" : "s"}
              </span>
            )}
          </div>

          {cellType ? (
            canvasTab === "schematic" ? (
              <SchematicCanvas
                domain={activeDomain}
                transistors={
                  extraction.data?.kind === "inferred"
                    ? extraction.data.transistors
                    : []
                }
                nets={
                  extraction.data?.kind === "inferred" ? extraction.data.nets : []
                }
                extraction={
                  extraction.data?.kind === "inferred" ? extraction.data : null
                }
                hover={effectiveHover}
                onHoverEntity={setHoveredEntity}
              />
            ) : canvasTab === "logicSchematic" ? (
              <LogicSchematicCanvas
                extraction={extraction.data}
                hover={effectiveHover}
                onHoverEntity={setHoveredEntity}
              />
            ) : (
              <CellRECanvas
                ref={canvasRef}
                cellType={cellType}
                cell={cell}
                imageUrl={imageUrl}
                annotations={annotations}
                extraction={extraction.data}
                activeTool={activeTool}
                activeLayer={activeLayer}
                layerHidden={layerHidden}
                selectedShapeIds={selectedShapeIds}
                hoveredShapeIds={imageHoverKeys}
                // Dim only when the hover came from outside the canvas
                // (right panel or schematic). The image-canvas cursor's
                // own hover still draws the halo on the targeted shape,
                // but doesn't fade the rest of the image — mousing
                // across the canvas would otherwise feel like the image
                // is constantly flickering.
                dimNonHovered={hoveredEntity != null}
                onSelect={setSelectedShapeIds}
                dispatch={(action) => void dispatcher.dispatch(action)}
                polyDraft={poly.points}
                onPolyAddVertex={poly.addPoint}
                onPolyCommit={poly.commit}
                onPolyCancel={poly.cancel}
                polylineDraft={polyline.points}
                onPolylineAddVertex={polyline.addPoint}
                onPolylineCommit={polyline.commit}
                onPolylineCancel={polyline.cancel}
                polylineWidth={polyline.width}
                polylineWidth={useCellREStore.getState().polylineWidth}
                polylineDraft={polyline.points}
                onPolylineAddVertex={polyline.addPoint}
                onPolylineCommit={polyline.commit}
                onPolylineCancel={polyline.cancel}
                polylineWidth={polyline.width}
                polylineWidth={useCellREStore.getState().polylineWidth}
                onEscape={() => setActiveTool("select")}
                onShapeContextMenu={(target, x, y) => {
                  if (!target) {
                    setShapeMenu(null);
                    return;
                  }
                  setShapeMenu({ x, y, layer: target.layer, shape: target.shape });
                }}
                onCanvasHover={setCanvasHover}
              />
            )
          ) : (
            <div
              className="m"
              style={{
                flex: "1 1 auto",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--canvas-bg)",
                color: "var(--ink3)",
                fontSize: 12
              }}
            >
              {annotations
                ? "select a cell type on the left to begin"
                : "loading annotations…"}
            </div>
          )}
        </div>

        <CellRERightPanel
          cellType={cellType}
          extraction={extraction.data}
          loading={extraction.loading}
          error={extraction.error}
          hoverEntity={effectiveHover}
          selectedShapeIds={selectedShapeIds}
          activeDomainId={activeDomain?.id ?? null}
          canvasTab={canvasTab}
          onHoverEntity={setHoveredEntity}
          onSelect={setSelectedShapeIds}
          onRename={(newName) => {
            if (!cellType) return;
            const action = buildRenameCellTypeAction(cellType, newName);
            if (action) void dispatcher.dispatch(action);
          }}
          onRenameNet={(netId, newName) => {
            if (!cellType || extraction.data?.kind !== "inferred") return;
            const candidates = netShapeCandidates(extraction.data, netId);
            if (candidates.length === 0) return;
            const trimmed = newName.trim();
            // Clearing → wipe customName from every candidate (so a
            // stale name on a now-merged net doesn't resurrect).
            // Setting → only write to the topmost-preferred candidate;
            // extractor's first-wins propagation handles the rest.
            if (trimmed.length === 0) {
              for (const c of candidates) {
                const action = buildSetShapeCustomNameAction(
                  cellType, c.layer, c.id, null,
                );
                if (action) void dispatcher.dispatch(action);
              }
              return;
            }
            const action = buildSetShapeCustomNameAction(
              cellType, candidates[0].layer, candidates[0].id, trimmed,
            );
            if (action) void dispatcher.dispatch(action);
          }}
          onSetNetLabel={(netId, label) => {
            if (!cellType || extraction.data?.kind !== "inferred") return;
            // Same candidate-pick logic as rename, but excluding
            // diffusion — labels there mean "force P/N" via the
            // forcedType field, not a net role. The label cascade in
            // buildNets explicitly skips diffusion shapes, so writing
            // a label to a diffusion sub-region would be a no-op
            // anyway.
            const candidates = netShapeCandidates(extraction.data, netId).filter(
              (c) => c.layer !== "diffusion",
            );
            if (candidates.length === 0) return;
            // Clearing → wipe label from every non-diffusion candidate
            // (same dedup story as rename). Setting → write only to
            // the topmost; propagation handles the rest, and a single
            // labelled shape is enough to tag the net.
            if (label === null) {
              const action = buildSetShapeLabelsAction(cellType, candidates, null);
              if (action) void dispatcher.dispatch(action);
              return;
            }
            const action = buildSetShapeLabelsAction(
              cellType, [candidates[0]], label,
            );
            if (action) void dispatcher.dispatch(action);
          }}
          onSetDiffusionForcedType={(diffusionShapeId, type) => {
            if (!cellType) return;
            // Diffusion forced-type acts directly on the diff shape
            // itself (no representative-shape picking — the diff row
            // IS one user-drawn shape). Reuses the existing single-
            // shape forced-type action builder.
            const action = buildSetShapeForcedTypesAction(
              cellType,
              [{ layer: "diffusion", id: diffusionShapeId }],
              type,
            );
            if (action) void dispatcher.dispatch(action);
          }}
          onDomainOpen={(domainId) => {
            setActiveDomainId(domainId);
            setCanvasTab("schematic");
          }}
        />
      </main>

      <StatusBar
        items={[
          die?.name ?? dieId,
          cellType ? `cell ${cellType.name}` : "no cell type",
          `tool: ${activeTool}`,
          hoverStatus ??
            (selectedShapeIds.size > 0
              ? `${selectedShapeIds.size} selected`
              : "—")
        ]}
      />

      {menu && annotations && (
        <CellREContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onFlipH={() => {
            const c = annotations.cells.find((x) => x.id === menu.cellId);
            if (c) orient(c, { flippedH: !(c.flippedH === true) });
          }}
          onFlipV={() => {
            const c = annotations.cells.find((x) => x.id === menu.cellId);
            if (c) orient(c, { flippedV: !(c.flippedV === true) });
          }}
          onRotate={() => {
            const c = annotations.cells.find((x) => x.id === menu.cellId);
            if (c) orient(c, { rotation: rotateCw((c.rotation ?? 0) as 0) });
          }}
          onUnmatch={() => {
            const c = annotations.cells.find((x) => x.id === menu.cellId);
            if (c) doUnmatch(c);
          }}
          onJumpToDie={() => {
            const c = annotations.cells.find((x) => x.id === menu.cellId);
            if (c) jumpToDie(c);
          }}
        />
      )}

      {shapeMenu && cellType && (() => {
        // Compute the multi-select aggregates the menu needs: how many
        // shapes each action touches and the current label / forced-type
        // they all share (or "mixed").
        const labels = summarizeLabels(cellType, selectedShapeIds, shapeMenu);
        const forced = summarizeForcedTypes(cellType, selectedShapeIds, shapeMenu);
        return (
          <ShapeContextMenu
            menu={shapeMenu}
            selectionCount={selectedShapeIds.size}
            labelTargetCount={labels.count}
            appliedLabel={labels.applied}
            forcedTypeTargetCount={forced.count}
            appliedForcedType={forced.applied}
            hasClipboard={clipboard.length > 0}
            onClose={() => setShapeMenu(null)}
            onSetLabel={(label) => doSetLabel(shapeMenu, label)}
            onSetForcedType={(type) => doSetForcedType(shapeMenu, type)}
            onDuplicate={doDuplicate}
            onCopy={doCopy}
            onPaste={doPaste}
            onDelete={doDelete}
          />
        );
      })()}
    </AppShell>
  );
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    height: 30,
    padding: "0 12px",
    background: active ? "var(--canvas-bg)" : "transparent",
    color: active ? "var(--ink)" : "var(--ink3)",
    border: 0,
    borderRight: "1px solid var(--l2)",
    borderLeft: active ? "1px solid var(--l2)" : 0,
    fontFamily: "var(--mono)",
    fontSize: 10.5,
    letterSpacing: 0.4,
    cursor: "pointer"
  };
}

/**
 * Format a hover-over-shape into a one-line status string. Falls back to
 * `null` (caller should render the default "N selected" line) when the
 * cursor isn't over a shape or extraction isn't loaded.
 *
 * For non-diffusion shapes: surfaces the net id + role + label.
 * For diffusion: surfaces the inferred P/N type plus — when we resolved a
 * specific sub-region under the cursor — that sub-region's net info, so
 * the user can see which S/D pad they're pointing at.
 */
function describeHoverTarget(
  hover: CanvasHoverTarget | null,
  extraction: CellExtraction | null,
): string | null {
  if (!hover) return null;
  const parts: string[] = [hover.layer];
  if (!extraction || extraction.kind !== "inferred") {
    return parts.join(" · ");
  }
  const ext = extraction;
  if (hover.layer === "diffusion") {
    const diff = ext.diffusions.find((d) => d.shapeId === hover.shape.id);
    if (diff && diff.type !== "unknown") {
      parts.push(`${diff.type.toUpperCase()}-type${diff.forced ? " (forced)" : ""}`);
    }
    if (hover.subRegionId) {
      const sub = ext.shapes.find((s) => s.id === hover.subRegionId);
      const net = sub ? ext.nets.find((n) => n.id === sub.netId) : null;
      if (net) parts.push(formatNet(net));
    }
    return parts.join(" · ");
  }
  // Non-diffusion: resolve to the net via the user-drawn shape id.
  const shape = ext.shapes.find(
    (s) => s.layer === hover.layer && s.id === hover.shape.id,
  );
  if (shape) {
    const net = ext.nets.find((n) => n.id === shape.netId);
    if (net) parts.push(formatNet(net));
  }
  return parts.join(" · ");
}

function formatNet(net: ExtractedNet): string {
  // Lead with the same display name the schematic + right panel show
  // (customName > label > netN) so the status bar's hover text and
  // the rest of the UI agree on what a given net is called.
  const display = netDisplayName(net);
  const tags: string[] = [display];
  // If the display name is the customName, still surface the role so
  // the user knows what classification the extractor inferred.
  if (display !== `net${net.id}` && net.role) tags.push(net.role);
  else if (display === `net${net.id}` && net.role) tags.push(net.role);
  return tags.join(" ");
}

/**
 * Which selected layers the shape-menu's metal label action applies to,
 * given the layer of the right-clicked anchor shape. metal1 + metal2 share
 * a category (so a mixed selection labels them together); everything else
 * is single-layer scope. Diffusion is intentionally excluded — its
 * force-type action goes through `doSetForcedType` on a separate field.
 */
function labelLayersFor(anchorLayer: LayerType): Set<LayerType> {
  if (anchorLayer === "metal1" || anchorLayer === "metal2") {
    return new Set<LayerType>(["metal1", "metal2"]);
  }
  return new Set<LayerType>([anchorLayer]);
}

/**
 * Inspect the selection (filtered to the menu's label category) and return
 * how many shapes the label action will touch + their shared label state.
 * Used by the page to drive ShapeContextMenu's "✓ on all that agree" UI.
 *
 * If the right-clicked shape isn't in the selection (defensive — the canvas
 * normally auto-selects it), we fall back to a single-shape view of its own
 * label so the menu still reflects what an action would do.
 */
function summarizeLabels(
  cellType: CellType,
  selectedShapeIds: Set<string>,
  menu: ShapeContextMenuState
): { count: number; applied: AppliedLabel } {
  const allowed = labelLayersFor(menu.layer);
  const labels: Array<ShapeLabel | null> = [];
  for (const key of selectedShapeIds) {
    const p = parseShapeKey(key);
    if (!p || !allowed.has(p.layer)) continue;
    const shape = cellType.layers?.[p.layer]?.find((s) => s.id === p.id);
    if (!shape) continue;
    labels.push(shape.label ?? null);
  }
  if (labels.length === 0) {
    labels.push(menu.shape.label ?? null);
  }
  const first = labels[0];
  const allSame = labels.every((l) => l === first);
  return {
    count: labels.length,
    applied: allSame ? first : "mixed"
  };
}

/**
 * Same shape as `summarizeLabels`, but for the diffusion-only `forcedType`
 * field. Only diffusion shapes contribute. Returns `null` (the default)
 * when none are forced, the type when all targets agree, or `"mixed"`.
 */
function summarizeForcedTypes(
  cellType: CellType,
  selectedShapeIds: Set<string>,
  menu: ShapeContextMenuState
): { count: number; applied: AppliedForcedType } {
  const types: Array<ForcedDiffusionType | null> = [];
  for (const key of selectedShapeIds) {
    const p = parseShapeKey(key);
    if (!p || p.layer !== "diffusion") continue;
    const shape = cellType.layers?.[p.layer]?.find((s) => s.id === p.id);
    if (!shape) continue;
    types.push(shape.forcedType ?? null);
  }
  if (types.length === 0) {
    types.push(menu.shape.forcedType ?? null);
  }
  const first = types[0];
  const allSame = types.every((t) => t === first);
  return {
    count: types.length,
    applied: allSame ? first : "mixed"
  };
}

/**
 * Resolve a net id to the list of user-drawn shapes that could
 * carry a label / customName for it, in preference order (metal2 →
 * metal1 → polysilicon → diffusion → contact → via1, then by shape
 * id for determinism).
 *
 * Sub-region ids (synthesised by the diffusion-split pass) aren't
 * stored in `cellType.layers`, so we fold them back to their parent
 * diffusion's id. Same logic for both `onRenameNet` and
 * `onSetNetLabel` — pulled out so the two stay in sync.
 */
function netShapeCandidates(
  extraction: Extract<CellExtraction, { kind: "inferred" }>,
  netId: number,
): Array<{ layer: LayerType; id: string }> {
  const net = extraction.nets.find((n) => n.id === netId);
  if (!net) return [];
  const shapeIndex = new Map(extraction.shapes.map((s) => [s.id, s]));
  const candidates: Array<{ layer: LayerType; id: string }> = [];
  const seen = new Set<string>();
  for (const sid of net.shapeIds) {
    const s = shapeIndex.get(sid);
    if (!s) continue;
    const layer: LayerType = s.parentDiffId ? "diffusion" : s.layer;
    const id = s.parentDiffId ?? s.id;
    const key = `${layer}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ layer, id });
  }
  const layerRank: Record<string, number> = {
    metal2: 0,
    metal1: 1,
    polysilicon: 2,
    diffusion: 3,
    contact: 4,
    via1: 5,
  };
  candidates.sort((a, b) => {
    const ra = layerRank[a.layer] ?? 99;
    const rb = layerRank[b.layer] ?? 99;
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : 1;
  });
  return candidates;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        flex: "1 1 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--ink3)",
        fontSize: 12
      }}
    >
      {children}
    </div>
  );
}
