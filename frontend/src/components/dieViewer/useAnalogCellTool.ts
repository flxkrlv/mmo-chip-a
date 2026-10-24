import { useCallback, useEffect, useMemo, useState } from "react";
import type { Cell, CellType } from "shared";
import type { AnalogLibParams, AnalogLibTemplate, AnalogPcellSpec } from "shared";
import {
  ANALOG_LIB_TEMPLATES,
  DEFAULT_ANALOG_LIB_RULES,
  buildAnalogPcell,
  defaultAnalogParams,
  normalizeAnalogParams,
  resolveAnalogTemplate,
  validateAnalogParams,
  type AnalogPcellLayout
} from "shared/analogLib";
import type { ActionDispatcher, AnnotationAction } from "../../api/actions";
import { pointInRect, type Point } from "../../lib/geometry";
import { isTypingTarget } from "../../lib/keyboard";
import { createLiveValue, type LiveValue } from "../../lib/liveValue";
import { cellInstanceScale } from "../../lib/cellFootprint";
import { orientOnDie, type DieOrientOp, type Orient } from "../../lib/mergeCells";
import { uuid } from "../../lib/uuid";
import type { Interaction, PointerEventData } from "../../renderer/interaction";
import type { Viewport } from "../../renderer/types";
import { useDieViewerStore, type ToolKind } from "../../state/dieViewer";
import { usePreferences } from "../../state/preferences";
import {
  analogDrop,
  analogFollow,
  analogFootprint,
  analogResizeFromCorner,
  newAnalogDraft,
  type AnalogDraft
} from "../../lib/analogPlacement";
import { rectCornerPoints } from "../../lib/libraryPlacement";

/** Corner-handle grab radius, css px. */
const HANDLE_TOL_PX = 8;

export interface AnalogCellTool {
  /** The devices the library offers. */
  templates: typeof ANALOG_LIB_TEMPLATES;
  /** The chosen device. */
  template: AnalogLibTemplate;
  /** Its parameters. */
  params: AnalogLibParams;
  /** Pixels per micrometre the device is generated at. */
  scale: number;
  /** The die's library scale — the default for a new device. */
  dieScale: number;
  /** Micrometres per die pixel, when the die is calibrated. */
  umPerPx: number | null;
  /** The device being re-generated (its type is replaced, not duplicated). */
  editing: AnalogEditTarget | null;
  chooseTemplate: (template: AnalogLibTemplate) => void;
  setParams: (params: AnalogLibParams) => void;
  setScale: (scale: number) => void;
  /** Load a placed device's parameters back into the tool. */
  beginEdit: (cell: Cell, cellType: CellType) => void;
  /** Leave the edit and go back to placing new devices. */
  stopEditing: () => void;
  /** Arm the placement tool — the template sticks to the pointer. */
  startPlacing: () => void;
  /** The generated device, as the template shows it. */
  layout: AnalogPcellLayout;
  /** Why the device can't be laid out — null when it can. */
  problem: string | null;
  /** The template being fitted (the overlay subscribes to it). */
  draftLive: LiveValue<AnalogDraft | null>;
  hasDraft: boolean;
  /** The template sticks to the pointer (it has not been dropped yet). */
  following: boolean;
  /** The tool is armed: the pointer places the device. */
  armed: boolean;
  /** The orientation new devices are laid out with. */
  orientation: Orient;
  orient: (op: DieOrientOp) => void;
  /** Place the device and remember its parameters. */
  accept: () => Promise<void>;
  cancel: () => void;
  /** Canvas click: the template is dropped there. */
  moveTo: (p: Point) => void;
  /** The pointer moved: the template follows it while it is stuck to it. */
  follow: (p: Point) => void;
  pointerDown: (e: PointerEventData) => Interaction;
  busy: boolean;
  error: string | null;
  /** Last acceptance, for the status line. */
  notice: string | null;
}

/** A placed device that is being re-generated: its type is replaced by a
 *  freshly laid out one, so the hand-made edits to it are lost. */
export interface AnalogEditTarget {
  cellId: string;
  cellTypeId: string;
  prevCell: Cell;
  prevCellType: CellType;
}

/**
 * The "Place analog device" tool: pick a device from the analog library
 * (pmos / nmos / npn / pnp / lpnp), set its parameters — the finger count,
 * W and L per finger in micrometres, the bulk connection — and the scale
 * it is generated at, then stretch the template over the transistor in the
 * die image and accept: a cell carrying the device's layers lands there.
 *
 * The template sticks to the pointer: "Place" arms the tool, the device
 * follows the mouse over the die, a click drops it, the corners set its
 * size and Enter places it. Nothing is dropped in the middle of the view.
 *
 * The cell is an ordinary one: its layers can be edited by hand afterwards,
 * and it is unique — the library's device is never touched.
 */
export function useAnalogCellTool({
  dieId,
  dispatcher,
  viewportLive,
  activeTool,
  setActiveTool,
  dieScale,
  umPerPx
}: {
  dieId: string;
  dispatcher: ActionDispatcher;
  viewportLive: LiveValue<Viewport | null>;
  activeTool: ToolKind;
  setActiveTool: (tool: ToolKind) => void;
  /** The die's library scale (pixels per library unit) — the default. */
  dieScale: number;
  /** Micrometres per die pixel, when the die is calibrated. */
  umPerPx: number | null;
}): AnalogCellTool {
  const draftLive = useMemo(() => createLiveValue<AnalogDraft | null>(null), []);
  const [hasDraft, setHasDraft] = useState(false);
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<AnalogEditTarget | null>(null);
  // The user armed the placement: the pointer carries the device. It is
  // cleared by accepting, cancelling or leaving the tool — otherwise the
  // device would come back on the next mouse move.
  const [placing, setPlacing] = useState(false);
  // The orientation new devices are laid out with. It lives here, not in
  // the draft, so it can be turned before the template even appears.
  const [orientation, setOrientation] = useState<Orient>({
    rotation: 0,
    flippedH: false,
    flippedV: false
  });

  // The last device the user placed — the tool starts from it. A stored
  // template can be gone (the vertical pnp was removed) and a stored
  // parameter set can miss fields added later, so both are normalized.
  const last = usePreferences((s) => s.analogCellLast);
  const [template, setTemplate] = useState<AnalogLibTemplate>(
    resolveAnalogTemplate(last?.template)
  );
  const [params, setParamsState] = useState<AnalogLibParams>(
    normalizeAnalogParams(resolveAnalogTemplate(last?.template), last?.params)
  );
  const [scale, setScaleState] = useState<number>(last?.scale ?? dieScale);

  const setDraft = useCallback(
    (d: AnalogDraft | null) => {
      draftLive.set(d);
      setHasDraft(d !== null);
      setFollowing(d?.follow === true);
    },
    [draftLive]
  );

  // The die's scale is the default; an explicit choice sticks.
  useEffect(() => {
    if (last?.scale == null) setScaleState(dieScale);
  }, [dieScale, last?.scale]);

  // Leaving the tool drops the template.
  useEffect(() => {
    if (activeTool !== "analogCell") {
      setDraft(null);
      setPlacing(false);
    }
  }, [activeTool, setDraft]);

  const spec = useMemo<AnalogPcellSpec>(
    () => ({
      template,
      params,
      scale,
      rules: { ...DEFAULT_ANALOG_LIB_RULES }
    }),
    [template, params, scale]
  );

  const problem = useMemo(() => {
    const paramsError = validateAnalogParams(params);
    if (paramsError) return paramsError;
    if (!(scale > 0)) return "scale must be greater than 0";
    return null;
  }, [params, scale]);

  const layout = useMemo<AnalogPcellLayout>(() => {
    if (problem) {
      return { layers: {}, cropRect: { x: 0, y: 0, width: 0, height: 0 }, summary: "" };
    }
    try {
      return buildAnalogPcell(spec, "preview");
    } catch {
      return { layers: {}, cropRect: { x: 0, y: 0, width: 0, height: 0 }, summary: "" };
    }
  }, [spec, problem]);

  const chooseTemplate = useCallback(
    (id: AnalogLibTemplate) => {
      setTemplate(id);
      setParamsState(defaultAnalogParams(id));
      setError(null);
      // The template keeps its place — the new device shows up there, in
      // the size its new parameters give it.
    },
    []
  );

  const setParams = useCallback((next: AnalogLibParams) => {
    setParamsState(next);
    setError(null);
  }, []);

  const setScale = useCallback((value: number) => {
    setScaleState(value);
    setError(null);
  }, []);

  const orient = useCallback(
    (op: DieOrientOp) => {
      // The orientation is the tool's, not the draft's: the device can be
      // turned before its template ever appears.
      const next = orientOnDie(orientation, op);
      setOrientation(next);
      const d = draftLive.get();
      if (d) setDraft({ ...d, ...next });
    },
    [draftLive, orientation, setDraft]
  );

  /** Load a placed device's parameters back into the tool, so it can be
   *  laid out again — the same cell, the same place, new parameters. */
  const beginEdit = useCallback(
    (cell: Cell, cellType: CellType) => {
      const pcell = cellType.pcell;
      if (!pcell) {
        setError("this cell was not laid out by the analog library");
        return;
      }
      setEditing({
        cellId: cell.id,
        cellTypeId: cellType.id,
        prevCell: cell,
        prevCellType: cellType
      });
      setTemplate(pcell.template);
      setParamsState(normalizeAnalogParams(pcell.template, pcell.params));
      setScaleState(pcell.scale);
      setError(null);
      // The template starts where the device sits — it is not stuck to the
      // pointer here, the user is editing the device in place.
      const k = cellInstanceScale(cell, cellType, dieScale);
      const orient: Orient = {
        rotation: (cell.rotation ?? 0) as Orient["rotation"],
        flippedH: cell.flippedH === true,
        flippedV: cell.flippedV === true
      };
      setOrientation(orient);
      setDraft({
        cx: cell.x + (cellType.cropRect.width * k) / 2,
        cy: cell.y + (cellType.cropRect.height * k) / 2,
        k: 1,
        ...orient,
        follow: false
      });
      setActiveTool("analogCell");
      setPlacing(true);
    },
    [dieScale, setActiveTool, setDraft]
  );

  const stopEditing = useCallback(() => {
    setEditing(null);
    setDraft(null);
    setPlacing(false);
  }, [setDraft]);

  /** Arm the placement tool. The template sticks to the pointer: it
   *  follows it over the die, a click drops it, and Enter places it. */
  const startPlacing = useCallback(() => {
    setActiveTool("analogCell");
    setPlacing(true);
    setNotice(null);
    const d = draftLive.get();
    // The template sticks to the pointer again. If there is none yet, it
    // appears as soon as the pointer reaches the canvas.
    if (d) setDraft({ ...d, follow: true });
  }, [draftLive, setActiveTool, setDraft]);

  const cancel = useCallback(() => {
    setDraft(null);
    setPlacing(false);
  }, [setDraft]);

  /** The click: the template is dropped where the pointer is. */
  const moveTo = useCallback(
    (p: Point) => {
      const d = draftLive.get();
      if (d) setDraft(analogDrop(d, p));
      else setDraft(newAnalogDraft(p, { ...orientation, follow: false }));
    },
    [draftLive, orientation, setDraft]
  );

  /** The pointer moved: the template follows it while it is stuck to it. */
  const follow = useCallback(
    (p: Point) => {
      if (activeTool !== "analogCell" || !placing) return;
      const d = draftLive.get();
      if (!d) {
        // The tool is armed and the pointer reached the canvas: the
        // template appears, stuck to the pointer.
        setDraft(newAnalogDraft(p, orientation));
        return;
      }
      const next = analogFollow(d, p);
      if (next !== d) setDraft(next);
    },
    [activeTool, draftLive, orientation, placing, setDraft]
  );

  const accept = useCallback(async () => {
    const d = draftLive.get();
    if (!d || busy || problem) return;
    setBusy(true);
    setError(null);
    try {
      // The stretch becomes part of the device's own scale: the cell is
      // generated at the final size, so its layers are what it shows.
      const finalScale = scale * d.k;
      const finalSpec: AnalogPcellSpec = { ...spec, scale: finalScale };
      const typeId = editing ? editing.cellTypeId : uuid();
      const built = buildAnalogPcell(finalSpec, typeId);
      const w = built.cropRect.width;
      const h = built.cropRect.height;
      const x = Math.round(d.cx - w / 2);
      const y = Math.round(d.cy - h / 2);

      let cell: Cell;
      let cellType: CellType;
      let actions: AnnotationAction[];
      if (editing) {
        // Re-generate the device in place: the same type and the same
        // cell, freshly laid out. Hand-made edits to the layers are lost.
        cellType = {
          ...editing.prevCellType,
          name: built.summary,
          cropRect: built.cropRect,
          layers: built.layers,
          pcell: finalSpec
        };
        cell = {
          ...editing.prevCell,
          x,
          y,
          scale: finalScale
        };
        if (d.rotation) cell.rotation = d.rotation;
        else delete cell.rotation;
        if (d.flippedH) cell.flippedH = true;
        else delete cell.flippedH;
        if (d.flippedV) cell.flippedV = true;
        else delete cell.flippedV;
        actions = [
          { kind: "upsertCellType", cellType, prevCellType: editing.prevCellType },
          { kind: "upsertCell", cell, prevCell: editing.prevCell }
        ];
      } else {
        cellType = {
          id: typeId,
          name: built.summary,
          cropRect: built.cropRect,
          layers: built.layers,
          matched: true,
          pcell: finalSpec
        };
        cell = {
          id: uuid(),
          cellTypeId: typeId,
          x,
          y,
          scale: finalScale,
          merged: true
        };
        if (d.rotation) cell.rotation = d.rotation;
        if (d.flippedH) cell.flippedH = true;
        if (d.flippedV) cell.flippedV = true;
        actions = [
          { kind: "upsertCellType", cellType, prevCellType: null },
          { kind: "upsertCell", cell, prevCell: null }
        ];
      }
      await dispatcher.dispatch({ kind: "batch", actions });
      // Remember the device, so the next one starts the same way.
      usePreferences.getState().setAnalogCellLast({ template, params, scale });
      setDraft(null);
      setEditing(null);
      setPlacing(false);
      useDieViewerStore.getState().select([`cell:${cell.id}`], "replace");
      setNotice(
        `${built.summary} · ${Math.round(w)}×${Math.round(h)} px · ${finalScale.toFixed(3)} px/µm`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "placing the device failed");
    } finally {
      setBusy(false);
    }
  }, [busy, dispatcher, draftLive, editing, params, problem, scale, setDraft, spec, template]);

  // Enter accepts, Escape drops the template.
  useEffect(() => {
    if (activeTool !== "analogCell") return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter" && draftLive.get()) {
        e.preventDefault();
        void accept();
      } else if (e.key === "Escape" && placing) {
        e.preventDefault();
        // Cancel: the template goes away and the pointer stops carrying
        // it — otherwise the next mouse move would bring it back.
        setDraft(null);
        setPlacing(false);
        setActiveTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool, accept, draftLive, placing, setActiveTool, setDraft]);

  const pointerDown = useCallback(
    (e: PointerEventData): Interaction => {
      const d = draftLive.get();
      const vp = viewportLive.get();
      if (!d || !vp || problem) return "pan";
      if (d.follow) {
        // The template sticks to the pointer: the click drops it here.
        // (The pointer move already carried it along.)
        return {
          onPointerUp: ({ worldPoint }) => {
            const cur = draftLive.get();
            if (cur) setDraft(analogDrop(cur, worldPoint));
          }
        };
      }
      const fp = analogFootprint(d, layout.cropRect.width, layout.cropRect.height);
      const tol = HANDLE_TOL_PX / vp.zoom;
      const corner = rectCornerPoints(fp).findIndex(
        (c) => Math.abs(c.x - e.worldPoint.x) <= tol && Math.abs(c.y - e.worldPoint.y) <= tol
      );
      if (corner >= 0) {
        // Corner: stretch the template, the opposite corner pinned.
        const resize = (wp: Point) =>
          draftLive.set(
            analogResizeFromCorner(d, layout.cropRect.width, layout.cropRect.height, corner, wp)
          );
        return {
          onDragStart: ({ worldPoint }) => resize(worldPoint),
          onDragMove: ({ worldPoint }) => resize(worldPoint),
          onPointerUp: ({ dragged, worldPoint }) => {
            if (dragged) resize(worldPoint);
          },
          onCancel: () => draftLive.set(d)
        };
      }
      if (pointInRect(e.worldPoint, fp)) {
        // Body: move.
        const move = (wp: Point, from: Point) =>
          draftLive.set({ ...d, cx: d.cx + wp.x - from.x, cy: d.cy + wp.y - from.y });
        return {
          onDragStart: ({ worldPoint, startWorld }) => move(worldPoint, startWorld),
          onDragMove: ({ worldPoint, startWorld }) => move(worldPoint, startWorld),
          onPointerUp: ({ dragged, worldPoint, startWorld }) => {
            if (dragged) move(worldPoint, startWorld);
          },
          onCancel: () => draftLive.set(d)
        };
      }
      // Elsewhere: pan (a plain click moves the template there).
      return "pan";
    },
    [draftLive, layout.cropRect.height, layout.cropRect.width, problem, setDraft, viewportLive]
  );

  return {
    templates: ANALOG_LIB_TEMPLATES,
    template,
    params,
    scale,
    dieScale,
    umPerPx,
    editing,
    chooseTemplate,
    setParams,
    setScale,
    beginEdit,
    stopEditing,
    startPlacing,
    layout,
    problem,
    draftLive,
    hasDraft,
    following,
    armed: placing,
    orientation,
    orient,
    accept,
    cancel,
    moveTo,
    follow,
    pointerDown,
    busy,
    error,
    notice
  };
}
