import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Cell } from "shared";
import { AppShell } from "../components/shell/AppShell";
import { StatusBar } from "../components/shell/StatusBar";
import { SubBar, ToolDivider } from "../components/shell/SubBar";
import { Ic } from "../icons";
import { useDie } from "../api/dies";
import { useAnnotations } from "../api/annotations";
import { useAnnotationsWebSocket } from "../api/annotationsWebSocket";
import { useActionDispatcher } from "../api/actions";
import { useDieVias, type DieViasBbox } from "../api/ml";
import { useSession } from "../state/session";
import { useMergeStore } from "../state/mergeCells";
import { usePreferences } from "../state/preferences";
import { fitRectViewport } from "../renderer/TiledCanvas";
import { isTypingTarget } from "../lib/keyboard";
import { ShortcutsPanel } from "../components/dieViewer/ShortcutsPanel";
import {
  MergeCanvas,
  type CellView,
  type MergeCanvasHandle
} from "../components/mergeCells/MergeCanvas";
import { MergeLeftPanel } from "../components/mergeCells/MergeLeftPanel";
import { Filmstrip } from "../components/mergeCells/Filmstrip";
import { MergeBottomBar } from "../components/mergeCells/MergeBottomBar";
import {
  MergeContextMenu,
  type ContextMenuState
} from "../components/mergeCells/MergeContextMenu";
import {
  buildMergeAction,
  buildOrientAction,
  buildUnmatchAction,
  candidatesFor,
  cellById,
  cellCropUrl,
  cellTypeById,
  cellTypeCropUrl,
  membersOf,
  orientOf,
  resolveSpecimenCell,
  rotateCw
} from "../lib/mergeCells";
import { alignVias, viasToCanonical } from "../lib/viaAlign";
import { MERGE_HOTKEYS } from "../lib/hotkeys";
import { useOverlayHotkeys } from "../lib/useOverlayHotkeys";
import { topVisibleOverlaySourceId, useOverlayLayers } from "../state/overlayLayers";

export function MergeCellsPage() {
  const [params] = useSearchParams();
  const sessionDieId = useSession((s) => s.dieId);
  const setSessionDieId = useSession((s) => s.setDieId);
  const dieId = params.get("die") ?? sessionDieId ?? null;

  useEffect(() => {
    if (dieId && dieId !== sessionDieId) setSessionDieId(dieId);
  }, [dieId, sessionDieId, setSessionDieId]);

  if (!dieId) {
    return (
      <AppShell breadcrumb="Merge cells">
        <Centered>Open a die from the Library to merge cells.</Centered>
      </AppShell>
    );
  }
  return <Merge key={dieId} dieId={dieId} />;
}

function Merge({ dieId }: { dieId: string }) {
  const navigate = useNavigate();
  const [params, setSearchParams] = useSearchParams();
  const die = useDie(dieId).data;
  const annotationsQ = useAnnotations(dieId);
  useAnnotationsWebSocket(dieId);
  useOverlayHotkeys();
  const overlayLayers = useOverlayLayers((s) => s.layers);
  const previewOverlaySourceId = useMemo(
    () => topVisibleOverlaySourceId(),
    [overlayLayers]
  );
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    const handler = () => setShortcutsOpen((v) => !v);
    window.addEventListener("toggle-shortcuts", handler);
    return () => window.removeEventListener("toggle-shortcuts", handler);
  }, []);
  const annotations = annotationsQ.data;
  const dispatcher = useActionDispatcher(dieId);

  const mode = usePreferences((s) => s.mergeMode);
  const setMode = usePreferences((s) => s.setMergeMode);
  const opacity = usePreferences((s) => s.mergeOpacity);
  const setOpacity = usePreferences((s) => s.setMergeOpacity);
  const showAnno = usePreferences((s) => s.mergeShowAnno);
  const setShowAnno = usePreferences((s) => s.setMergeShowAnno);
  const showMlVias = usePreferences((s) => s.mergeShowMlVias);
  const setShowMlVias = usePreferences((s) => s.setMergeShowMlVias);

  const specimenTypeId = useMergeStore((s) => s.specimenTypeId);
  const specimenCellId = useMergeStore((s) => s.specimenCellId);
  const candidateCellId = useMergeStore((s) => s.candidateCellId);
  const setSpecimen = useMergeStore((s) => s.setSpecimen);
  const setCandidate = useMergeStore((s) => s.setCandidate);

  // ── URL ↔ store sync ──────────────────────────────────────────────
  // One-shot hydration so a refresh / deep link lands on the same target
  // type + reference instance + candidate. useLayoutEffect so the auto-pick
  // effect below (which fires on the first specimenTypeId transition) sees
  // the hydrated candidate and skips the override.
  const hydratedFromUrlRef = useRef(false);
  useLayoutEffect(() => {
    if (hydratedFromUrlRef.current) return;
    hydratedFromUrlRef.current = true;
    const type = params.get("type");
    const ref = params.get("ref");
    const cand = params.get("cand");
    if (type) setSpecimen(type, ref);
    if (cand) setCandidate(cand);
  }, [params, setSpecimen, setCandidate]);

  // Write the active selection back into the URL. `replace: true` so per-
  // candidate flips don't pollute the back-button history. Diff-first so the
  // store→URL→params→effect loop self-terminates.
  useEffect(() => {
    if (!hydratedFromUrlRef.current) return;
    const next = new URLSearchParams(params);
    let changed = false;
    if (specimenTypeId) {
      if (next.get("type") !== specimenTypeId) {
        next.set("type", specimenTypeId);
        changed = true;
      }
    } else if (next.has("type")) {
      next.delete("type");
      changed = true;
    }
    if (specimenCellId) {
      if (next.get("ref") !== specimenCellId) {
        next.set("ref", specimenCellId);
        changed = true;
      }
    } else if (next.has("ref")) {
      next.delete("ref");
      changed = true;
    }
    if (candidateCellId) {
      if (next.get("cand") !== candidateCellId) {
        next.set("cand", candidateCellId);
        changed = true;
      }
    } else if (next.has("cand")) {
      next.delete("cand");
      changed = true;
    }
    if (changed) setSearchParams(next, { replace: true });
  }, [specimenTypeId, specimenCellId, candidateCellId, params, setSearchParams]);

  // Stale-link guard: if the URL pointed at a cell type that's since been
  // removed, drop the selection so the panel renders cleanly.
  useEffect(() => {
    if (!annotations || !specimenTypeId) return;
    if (!annotations.cellTypes.some((ct) => ct.id === specimenTypeId)) {
      setSpecimen(null, null);
    }
  }, [annotations, specimenTypeId, setSpecimen]);

  const canvasRef = useRef<MergeCanvasHandle | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [confirmMerge, setConfirmMerge] = useState(false);

  // ── Derived views ──────────────────────────────────────────────────
  const specimenType = annotations
    ? cellTypeById(annotations, specimenTypeId)
    : null;
  const specimenCell = annotations
    ? resolveSpecimenCell(annotations, specimenTypeId, specimenCellId)
    : null;
  const candidateCell = annotations ? cellById(annotations, candidateCellId) : null;
  const candidateType = candidateCell
    ? cellTypeById(annotations!, candidateCell.cellTypeId)
    : null;

  // ── ML via overlay (fetched per cell die-bbox; cached client-side) ──
  // Only fetched when the toggle is on so we don't burn ML inference time
  // for users who don't want the help. React Query keys on the bbox tuple,
  // so flipping between candidates instantly serves cached results.
  const specimenBbox: DieViasBbox | null =
    specimenCell && specimenType
      ? [
          specimenCell.x,
          specimenCell.y,
          specimenCell.x + specimenType.cropRect.width,
          specimenCell.y + specimenType.cropRect.height
        ]
      : null;
  const candidateBbox: DieViasBbox | null =
    candidateCell && candidateType
      ? [
          candidateCell.x,
          candidateCell.y,
          candidateCell.x + candidateType.cropRect.width,
          candidateCell.y + candidateType.cropRect.height
        ]
      : null;
  const specimenViasQ = useDieVias(dieId, specimenBbox, { enabled: showMlVias });
  const candidateViasQ = useDieVias(dieId, candidateBbox, { enabled: showMlVias });

  const specimenView: CellView | null = specimenType
    ? {
        cellType: specimenType,
        cell: specimenCell,
        imageUrl: specimenCell
          ? cellCropUrl(dieId, specimenCell, previewOverlaySourceId)
          : cellTypeCropUrl(dieId, specimenType.id, previewOverlaySourceId),
        mlVias: specimenViasQ.data ?? null
      }
    : null;
  const candidateView: CellView | null =
    candidateCell && candidateType
      ? {
          cellType: candidateType,
          cell: candidateCell,
          imageUrl: cellCropUrl(dieId, candidateCell, previewOverlaySourceId),
          mlVias: candidateViasQ.data ?? null
        }
      : null;

  const candidates = useMemo(
    () => (annotations ? candidatesFor(annotations, specimenType) : []),
    [annotations, specimenType]
  );

  // When the specimen *type* changes, jump the selection to the most likely
  // candidate (the closest-size not-yet-matched one — candidates are sorted
  // done-first then by ascending size distance). Only fires on a real type
  // switch, not on every annotations refresh (e.g. after a merge).
  //
  // The very first run after URL hydration is a special case: if `?cand=` was
  // present, hydration set the candidate before this effect ran, and we want
  // to keep it instead of overriding with the auto-pick.
  const prevSpecimenType = useRef<string | null>(null);
  useEffect(() => {
    if (!annotations) return;
    if (specimenTypeId === prevSpecimenType.current) return;
    const wasFirstRun = prevSpecimenType.current === null;
    prevSpecimenType.current = specimenTypeId;
    if (wasFirstRun && candidateCellId) return;
    const list = candidatesFor(
      annotations,
      cellTypeById(annotations, specimenTypeId)
    );
    const first = list.find((c) => !c.done) ?? list[0] ?? null;
    setCandidate(first ? first.cell.id : null);
  }, [specimenTypeId, annotations, candidateCellId, setCandidate]);

  // ── Actions ────────────────────────────────────────────────────────
  const advance = useCallback(() => {
    const idx = candidates.findIndex((c) => c.cell.id === candidateCellId);
    const next =
      candidates.slice(idx + 1).find((c) => !c.done) ??
      candidates.find((c) => !c.done && c.cell.id !== candidateCellId);
    setCandidate(next ? next.cell.id : null);
  }, [candidates, candidateCellId, setCandidate]);

  const orient = useCallback(
    (patch: Partial<Pick<Cell, "flippedH" | "flippedV" | "rotation" | "x" | "y">>) => {
      if (!candidateCell) return;
      void dispatcher.dispatch(buildOrientAction(candidateCell, patch));
    },
    [candidateCell, dispatcher]
  );

  const onFlipH = useCallback(
    () => orient({ flippedH: !(candidateCell?.flippedH === true) }),
    [orient, candidateCell]
  );
  const onFlipV = useCallback(
    () => orient({ flippedV: !(candidateCell?.flippedV === true) }),
    [orient, candidateCell]
  );
  const onRotateCw = useCallback(
    () => orient({ rotation: rotateCw((candidateCell?.rotation ?? 0) as 0) }),
    [orient, candidateCell]
  );
  const onAlign = useCallback(
    (dxSrc: number, dySrc: number) => {
      if (!candidateCell) return;
      orient({
        x: Math.round(candidateCell.x + dxSrc),
        y: Math.round(candidateCell.y + dySrc)
      });
    },
    [orient, candidateCell]
  );

  // ── Auto-align (via Hough voting over the dihedral group D4) ────────
  // Enabled iff both cells have ML vias loaded with at least 2 points each.
  // The button stays present but disabled otherwise (with a tooltip hint).
  const specimenVias = specimenViasQ.data?.pointVias ?? null;
  const candidateVias = candidateViasQ.data?.pointVias ?? null;
  const canAutoAlign =
    !!candidateCell &&
    !!specimenCell &&
    !!specimenType &&
    !!candidateType &&
    !!specimenVias &&
    !!candidateVias &&
    specimenVias.length >= 2 &&
    candidateVias.length >= 2;

  const doAutoAlign = useCallback(() => {
    if (
      !candidateCell ||
      !specimenCell ||
      !specimenType ||
      !candidateType ||
      !specimenVias ||
      !candidateVias
    ) {
      return;
    }
    // Specimen vias projected into the specimen's canonical frame (once).
    // Candidate vias stay in raw cell-local coords — alignVias re-projects
    // them under every candidate orientation it tries.
    const W = candidateType.cropRect.width;
    const H = candidateType.cropRect.height;
    const specCanon = viasToCanonical(
      specimenVias.map((v) => ({
        x: v.x - specimenCell.x,
        y: v.y - specimenCell.y
      })),
      orientOf(specimenCell),
      specimenType.cropRect.width,
      specimenType.cropRect.height
    );
    const candRaw = candidateVias.map((v) => ({
      x: v.x - candidateCell.x,
      y: v.y - candidateCell.y
    }));
    const result = alignVias(specCanon, candRaw, W, H);
    if (!result) {
      // Not enough signal — leave the user in charge. A toast / status line
      // would be friendlier; for now the bottom-bar tooltip explains it.
      console.warn("[merge] auto-align: no orientation produced a strong enough cluster");
      return;
    }
    void dispatcher.dispatch(
      buildOrientAction(candidateCell, {
        flippedH: result.flippedH,
        flippedV: result.flippedV,
        rotation: result.rotation,
        x: Math.round(candidateCell.x + result.dx),
        y: Math.round(candidateCell.y + result.dy)
      })
    );
  }, [
    candidateCell,
    candidateType,
    specimenCell,
    specimenType,
    specimenVias,
    candidateVias,
    dispatcher
  ]);

  const doMerge = useCallback(() => {
    if (!annotations || !candidateCell || !specimenType) return;
    const plan = buildMergeAction(annotations, candidateCell, specimenType, {
      ...orientOf(candidateCell),
      x: candidateCell.x,
      y: candidateCell.y
    });
    if (plan.losesAnnotations && !confirmMerge) {
      setConfirmMerge(true);
      return;
    }
    setConfirmMerge(false);
    void dispatcher.dispatch(plan.action);
    advance();
  }, [annotations, candidateCell, specimenType, confirmMerge, dispatcher, advance]);

  const onSkip = useCallback(() => advance(), [advance]);

  const doUnmatch = useCallback(
    (cell: Cell) => {
      if (!annotations) return;
      void dispatcher.dispatch(buildUnmatchAction(annotations, cell));
    },
    [annotations, dispatcher]
  );

  const jumpToDie = useCallback(
    (cell: Cell) => {
      const ct = annotations ? cellTypeById(annotations, cell.cellTypeId) : null;
      if (ct) {
        const rect = {
          x: cell.x,
          y: cell.y,
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

  // ── Keyboard: ⌘Z / ⌘⇧Z undo-redo ───────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void dispatcher.redo();
        else void dispatcher.undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatcher]);

  // ── Keyboard: merge workflow shortcuts ──────────────────────────────
  //   Alt+1/2/3/4/5  switch merge modes (from MERGE_HOTKEYS)
  //   ←/↑ prev · →/↓ next candidate
  //   f flip H · g flip V · h rotate · j auto-align
  //   y accept & merge
  useEffect(() => {
    const stepCandidate = (delta: number) => {
      if (candidates.length === 0) return;
      const idx = candidates.findIndex((c) => c.cell.id === candidateCellId);
      const base = idx === -1 ? (delta > 0 ? -1 : candidates.length) : idx;
      const next = Math.min(candidates.length - 1, Math.max(0, base + delta));
      const c = candidates[next];
      if (c) setCandidate(c.cell.id);
    };
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+/ or ? → keyboard shortcuts help (before ctrl guard)
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      if (isTypingTarget(e.target)) return;
      // Merge mode shortcuts (Alt+1..Alt+5)
      if (e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        const mode = MERGE_HOTKEYS[`Alt+${e.key}`];
        if (mode) {
          e.preventDefault();
          setMode(mode);
          return;
        }
      }
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          stepCandidate(-1);
          break;
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault();
          stepCandidate(1);
          break;
        case "f":
        case "F":
          onFlipH();
          break;
        case "g":
        case "G":
          onFlipV();
          break;
        case "h":
        case "H":
          onRotateCw();
          break;
        case "j":
        case "J":
          if (canAutoAlign) doAutoAlign();
          break;
        case "y":
        case "Y":
          doMerge();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    candidates,
    candidateCellId,
    setCandidate,
    setMode,
    onFlipH,
    onFlipV,
    onRotateCw,
    doMerge,
    canAutoAlign,
    doAutoAlign
  ]);

  const baseImageName = die?.originalFilename ?? die?.name ?? "base image";

  return (
    <AppShell
      breadcrumb={die?.name ?? "Merge cells"}
      meta={specimenType ? `merge → ${specimenType.name}` : "merge cells"}
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
        <span
          className={"chip" + (mode === "overlay" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setMode("overlay")}
          title="Overlay (Alt+1)"
        >
          <Kb>Alt+1</Kb> overlay
        </span>
        <span
          className={"chip" + (mode === "sxs" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setMode("sxs")}
          title="Side-by-side (Alt+2)"
        >
          <Kb>Alt+2</Kb> side-by-side
        </span>
        <span
          className={"chip" + (mode === "diff" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setMode("diff")}
          title="Pixel difference — black where aligned, bright where they disagree (Alt+3)"
        >
          <Kb>Alt+3</Kb> difference
        </span>
        <span
          className={"chip" + (mode === "specimen" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setMode("specimen")}
          title="Specimen only (Alt+4)"
        >
          <Kb>Alt+4</Kb> specimen
        </span>
        <span
          className={"chip" + (mode === "candidate" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setMode("candidate")}
          title="Candidate only (Alt+5)"
        >
          <Kb>Alt+5</Kb> candidate
        </span>
        {mode === "overlay" && (
          <>
            <span
              className="m"
              style={{ fontSize: 10.5, color: "var(--ink3)", marginLeft: 8 }}
            >
              opacity
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(opacity * 100)}
              onChange={(e) => setOpacity(Number(e.target.value) / 100)}
              style={{ width: 120 }}
            />
            <span className="m" style={{ fontSize: 10.5, color: "var(--ink2)", width: 30 }}>
              {Math.round(opacity * 100)}%
            </span>
          </>
        )}
        <ToolDivider />
        <label className="check">
          <input
            type="checkbox"
            checked={showAnno}
            onChange={(e) => setShowAnno(e.target.checked)}
          />
          Cell annotations
        </label>
        <label
          className="check"
          title="Overlay ML-detected vias on each cell — helps eyeball the alignment"
        >
          <input
            type="checkbox"
            checked={showMlVias}
            onChange={(e) => setShowMlVias(e.target.checked)}
          />
          ML vias
          {showMlVias &&
            (specimenViasQ.isFetching || candidateViasQ.isFetching) && (
              <span style={{ marginLeft: 4, fontSize: 10, color: "var(--ink3)" }}>
                …
              </span>
            )}
          {showMlVias &&
            (specimenViasQ.isError || candidateViasQ.isError) && (
              <span
                style={{ marginLeft: 4, fontSize: 10, color: "var(--err)" }}
                title={
                  (specimenViasQ.error ?? candidateViasQ.error)?.message ??
                  "ML service unavailable"
                }
              >
                ⚠
              </span>
            )}
        </label>
      </SubBar>

      <main
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex"
        }}
      >
        {annotations ? (
          <MergeLeftPanel
            dieId={dieId}
            annotations={annotations}
            onCandidateContextMenu={(cell, x, y) => {
              const canUnmatch =
                membersOf(annotations, cell.cellTypeId).length > 1;
              setMenu({ x, y, cellId: cell.id, canUnmatch, mlDetected: !!cell.mlDetected });
            }}
          />
        ) : (
          <div style={{ width: 248, flex: "0 0 auto", background: "var(--card)" }} />
        )}

        <div className="col" style={{ flex: "1 1 auto", minWidth: 0, minHeight: 0 }}>
          <MergeCanvas
            ref={canvasRef}
            mode={mode}
            opacity={opacity}
            showAnno={showAnno}
            showMlVias={showMlVias}
            specimen={specimenView}
            candidate={candidateView}
            onAlign={onAlign}
          />
          <Filmstrip
            dieId={dieId}
            candidates={candidates}
            selectedId={candidateCellId}
            onPick={(c) => setCandidate(c.id)}
            onContextMenu={(cell, x, y) => {
              const canUnmatch = annotations
                ? membersOf(annotations, cell.cellTypeId).length > 1
                : false;
              setMenu({ x, y, cellId: cell.id, canUnmatch, mlDetected: !!cell.mlDetected });
            }}
          />
          <MergeBottomBar
            hasCandidate={!!candidateView}
            specimenName={specimenType?.name ?? null}
            onFlipH={onFlipH}
            onFlipV={onFlipV}
            onRotateCw={onRotateCw}
            onAutoAlign={canAutoAlign ? doAutoAlign : null}
            onSkip={onSkip}
            onMerge={doMerge}
          />
        </div>
      </main>

      <StatusBar
        items={[
          die?.name ?? dieId,
          mode === "overlay"
            ? `overlay · ${Math.round(opacity * 100)}%`
            : mode === "diff"
              ? "difference"
              : mode === "specimen"
                ? "specimen only"
                : mode === "candidate"
                  ? "candidate only"
                  : "side-by-side",
          specimenType ? `specimen ${specimenType.name}` : "no specimen",
          candidateCell ? `candidate ${candidateCell.id.slice(0, 6)}` : "no candidate"
        ]}
      />

      {menu && (
        <MergeContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onUnmatch={() => {
            const c = annotations ? cellById(annotations, menu.cellId) : null;
            if (c) doUnmatch(c);
          }}
          onJumpToDie={() => {
            const c = annotations ? cellById(annotations, menu.cellId) : null;
            if (c) jumpToDie(c);
          }}
          onDelete={() => {
            const c = annotations ? cellById(annotations, menu.cellId) : null;
            if (c) {
              void dispatcher.dispatch({ kind: "removeCell", cell: c });
            }
          }}
        />
      )}

      {confirmMerge && (
        <ConfirmDialog
          title="Merge will drop annotations"
          body={`The candidate's current type carries layer annotations that ${
            specimenType?.name ?? "the target"
          } doesn't. Merging detaches them. Continue?`}
          confirmLabel="Merge anyway"
          onCancel={() => setConfirmMerge(false)}
          onConfirm={doMerge}
        />
      )}
      <ShortcutsPanel open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </AppShell>
  );
}

/** Tiny inline keyboard-shortcut hint shown inside a chip/button. */
function Kb({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-block",
        minWidth: 12,
        padding: "0 3px",
        marginRight: 2,
        borderRadius: 3,
        border: "1px solid var(--l2)",
        background: "var(--panel)",
        font: "inherit",
        fontSize: 9,
        lineHeight: "13px",
        textAlign: "center",
        color: "var(--ink3)"
      }}
    >
      {children}
    </kbd>
  );
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

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }}
      onClick={onCancel}
    >
      <div
        className="popover"
        style={{ width: 360, padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 8 }}>
          {title}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--ink2)", lineHeight: 1.5, marginBottom: 14 }}>
          {body}
        </div>
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn accent" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
