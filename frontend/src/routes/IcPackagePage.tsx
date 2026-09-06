import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { DieAnnotations } from "shared";
import { useAnnotations } from "../api/annotations";
import { useDie } from "../api/dies";
import { apiPut } from "../api/client";
import { useIcPackageStore } from "../state/icPackage";
import { useOverlayLayers } from "../state/overlayLayers";
import { AppShell } from "../components/shell/AppShell";
import {
  TiledCanvas,
  fitRectViewport,
  type Interaction,
  type PointerEventData,
  type TiledCanvasHandle
} from "../renderer/TiledCanvas";
import { DieImageLayer } from "../renderer/layers/DieImageLayer";
import { PackageOutlineLayer } from "../renderer/layers/PackageOutlineLayer";
import { DiePadMarkersLayer } from "../renderer/layers/DiePadMarkersLayer";
import { WireBondLayer } from "../renderer/layers/WireBondLayer";
import { StaticImageLayer } from "../renderer/layers/StaticImageLayer";
import {
  findNearestPad,
  findClickedPin,
  rotatedImageBbox,
} from "../lib/ic-package/transform";
import { loadPackageGeom } from "../lib/ic-package/footprinter";
import type { Layer, Viewport } from "../renderer/types";
import { PackageSelector } from "../components/ic-package/PackageSelector";
import { PinListPanel } from "../components/ic-package/PinListPanel";
import { DieTransformPanel } from "../components/ic-package/DieTransformPanel";
import { IcPackageToolbar } from "../components/ic-package/IcPackageToolbar";
import { OverlaySelector } from "../components/ic-package/OverlaySelector";
import { useToast } from "../components/Toast";

/** Scale at which to render the package: assume umPerPx defaults to 0.25 µm/px
 *  (a sane mid-range for IC photos) when the user hasn't set the scale yet.
 *  1 mm in package coords → 1000 / umPerPx pixels in die-image space. */
const DEFAULT_UM_PER_PX = 0.25;

export function IcPackagePage() {
  const [searchParams] = useSearchParams();
  const { dieId: routeDieId } = useParams<{ dieId: string }>();
  const dieId = routeDieId ?? searchParams.get("die") ?? null;

  if (!dieId) {
    return (
      <AppShell>
        <div
          className="m"
          style={{
            flex: "1 1 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ink3)",
            fontSize: 12,
          }}
        >
          <span>no die selected — </span>
          <Link to="/" style={{ color: "var(--accent)", marginLeft: 4 }}>
            choose one from the library
          </Link>
        </div>
      </AppShell>
    );
  }
  return <IcPackageView key={dieId} dieId={dieId} />;
}

function IcPackageView({ dieId }: { dieId: string }) {
  const { data: die, isLoading, error } = useDie(dieId);
  const { data: annotations } = useAnnotations(dieId);
  const queryClient = useQueryClient();
  const toast = useToast();
  const canvasHandle = useRef<TiledCanvasHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  /** Pin number being inline-edited on the canvas (HTML input overlay). */
  const [editingPinNumber, setEditingPinNumber] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  /** Bumps on every viewport change so the input re-positions during pan/zoom. */
  const [viewportVersion, setViewportVersion] = useState(0);
  /** Background image under the package outline: null = base die photo,
   *  otherwise an overlay layer id from useOverlayLayers. */
  const [bgOverlayId, setBgOverlayId] = useState<string | null>(null);
  /** Snapshot of the overlay image (mirrored to state so StaticImageLayer's
   *  draw() can re-read it via the live ref). */
  const [bgOverlayImage, setBgOverlayImage] = useState<HTMLImageElement | null>(null);

  // Seed store from annotations when first loaded (or when dieId changes).
  const loadFromAnnotations = useIcPackageStore((s) => s.loadFromAnnotations);
  useEffect(() => {
    loadFromAnnotations(annotations);
  }, [annotations, loadFromAnnotations]);

  // Track container size for fit-to-screen + per-pixel scaling.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setContainerSize({ width: r.width, height: r.height });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setContainerSize({ width: r.width, height: r.height });
    return () => ro.disconnect();
  }, []);

  // Auto-load overlay images from server (same as DieViewerPage) so the
  // overlay selector has options to pick from.
  const autoLoadRef = useRef(false);
  useEffect(() => {
    if (!dieId || autoLoadRef.current) return;
    autoLoadRef.current = true;
    void import("../api/overlayImages").then(async (mod) => {
      try {
        const list = await mod.fetchOverlayImageList(dieId);
        const addLayer = useOverlayLayers.getState().addLayer;
        const addTiledLayer = useOverlayLayers.getState().addTiledLayer;
        for (const source of list.images) {
          if (source.legacy) {
            try {
              const legacy = await mod.loadOverlayImageFromServer(
                dieId, source.originalFilename
              );
              addLayer(legacy.name, legacy.image, true, legacy.serverFilename);
            } catch (error) {
              console.warn("Failed to load legacy overlay", source.name, error);
            }
          } else {
            addTiledLayer(source, true);
          }
        }
      } catch (error) {
        console.warn("Failed to fetch overlay list", error);
      }
    });
  }, [dieId]);

  // Mirror the selected overlay's image into local state so StaticImageLayer
  // can re-read it via getImage(). Layered/tiled overlays aren't supported
  // here — only legacy (full-image) ones for now.
  const overlayLayers = useOverlayLayers((s) => s.layers);
  useEffect(() => {
    if (!bgOverlayId) {
      setBgOverlayImage(null);
      return;
    }
    const layer = overlayLayers.find((l) => l.id === bgOverlayId);
    if (!layer || !layer.image) {
      setBgOverlayImage(null);
      return;
    }
    setBgOverlayImage(layer.image);
  }, [bgOverlayId, overlayLayers]);

  // Compute pxPerMm from umPerPx. Default if missing.
  const umPerPx = annotations?.umPerPx ?? DEFAULT_UM_PER_PX;
  const pxPerMm = 1000 / umPerPx;

  // Where to anchor the package's mm-origin on the die image. We default to
  // dead-center so the user has room to rotate/flip the die image to align
  // pads with pins.
  const origin = useMemo(() => {
    if (!die) return { x: 0, y: 0 };
    return { x: die.width / 2, y: die.height / 2 };
  }, [die]);

  // Subscribe to relevant store state directly (re-render on change).
  const footprint = useIcPackageStore((s) => s.footprint);
  const pins = useIcPackageStore((s) => s.pins);
  const bonds = useIcPackageStore((s) => s.bonds);
  const transform = useIcPackageStore((s) => s.transform);
  const tool = useIcPackageStore((s) => s.tool);
  const selectedPinNumber = useIcPackageStore((s) => s.selectedPinNumber);
  const hoveredPadId = useIcPackageStore((s) => s.hoveredPadId);

  // Actions we don't subscribe to (mutate the store, no render needed).
  const setHoveredPad = useIcPackageStore((s) => s.setHoveredPad);
  const selectPin = useIcPackageStore((s) => s.selectPin);
  const addBond = useIcPackageStore((s) => s.addBond);
  const setTool = useIcPackageStore((s) => s.setTool);
  const namePin = useIcPackageStore((s) => s.namePin);
  const removePinName = useIcPackageStore((s) => s.removePinName);

  // Live ref to the latest inputs so layer callbacks see fresh values.
  const inputsRef = useRef({
    footprint,
    pins,
    bonds,
    transform,
    tool,
    selectedPinNumber,
    hoveredPadId,
    annotations,
  });
  inputsRef.current = {
    footprint,
    pins,
    bonds,
    transform,
    tool,
    selectedPinNumber,
    hoveredPadId,
    annotations,
  };

  // Geometry cached by footprint, recomputed only on footprint change.
  const geom = useMemo(() => {
    try {
      return loadPackageGeom(footprint);
    } catch {
      return null;
    }
  }, [footprint]);

  // Initial viewport: fit the union of (rotated die image bbox) and (package
  // outline bbox), so the user sees both at once even when the package is
  // larger than the die (typical — SOIC-8 is ~5×4 mm, dies are 1–2 mm) AND
  // when rotation 90°/270° expands the visual bbox of a rectangular die.
  const initialViewport = useMemo<Viewport | null>(() => {
    if (!die || !geom || containerSize.width === 0 || containerSize.height === 0) {
      return null;
    }
    const imgBbox = rotatedImageBbox(die.width, die.height, transform.rotationDeg);
    const pkgMinX = origin.x + geom.body.minX * pxPerMm;
    const pkgMinY = origin.y + geom.body.minY * pxPerMm;
    const pkgMaxX = origin.x + geom.body.maxX * pxPerMm;
    const pkgMaxY = origin.y + geom.body.maxY * pxPerMm;
    const minX = Math.min(imgBbox.x, pkgMinX);
    const minY = Math.min(imgBbox.y, pkgMinY);
    const maxX = Math.max(imgBbox.x + imgBbox.width, pkgMaxX);
    const maxY = Math.max(imgBbox.y + imgBbox.height, pkgMaxY);
    return fitRectViewport(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      containerSize.width,
      containerSize.height,
      48,
      32
    );
    // initialViewport only on mount; later rotation/footprint changes are
    // handled by the auto-fit useEffect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [die, containerSize.width, containerSize.height]);

  // ── Layers ────────────────────────────────────────────────────────
  const layers = useMemo<Layer[]>(() => {
    if (!die) return [];
    const imgSize = { width: die.width, height: die.height };
    const out: Layer[] = [];
    // Background image: static overlay when one is selected, otherwise the
    // base die tile pyramid. Both honour the same transform so rotation
    // behaves identically.
    if (bgOverlayImage) {
      out.push(new StaticImageLayer({
        getImage: () => bgOverlayImage,
        getBounds: () => ({ x: 0, y: 0, width: die.width, height: die.height }),
        getTransform: () => inputsRef.current.transform,
      }));
    } else {
      out.push(new DieImageLayer(die, {
        getTransform: () => inputsRef.current.transform,
      }));
    }
    out.push(
      new DiePadMarkersLayer({
        getPads: () => inputsRef.current.annotations?.pins ?? [],
        getTransform: () => inputsRef.current.transform,
        getImgSize: () => imgSize,
        getBondedPadIds: () =>
          new Set(inputsRef.current.bonds.map((b) => b.diePadId)),
        getHoveredPadId: () =>
          inputsRef.current.hoveredPadId,
      }),
      new PackageOutlineLayer(
        {
          getGeom: () => geom,
          getPxPerMm: () => pxPerMm,
          getSelectedPin: () => inputsRef.current.selectedPinNumber,
          getHoveredPin: () => null, // currently we just use store's hoveredPadId for die-side
        },
        { getOriginPx: () => origin }
      ),
      new WireBondLayer({
        getBonds: () => inputsRef.current.bonds,
        getPins: () => inputsRef.current.pins,
        getPads: () => inputsRef.current.annotations?.pins ?? [],
        getTransform: () => inputsRef.current.transform,
        getImgSize: () => imgSize,
        getPxPerMm: () => pxPerMm,
        getOriginPx: () => origin,
        getBondPreview: () => {
          const sel = inputsRef.current.selectedPinNumber;
          const hov = inputsRef.current.hoveredPadId;
          if (
            inputsRef.current.tool !== "bond" ||
            sel == null ||
            !hov
          ) {
            return null;
          }
          return { pinNumber: sel, padId: hov };
        },
      }),
    );
    return out;
  }, [die, geom, pxPerMm, origin, bgOverlayImage]);

  // Re-render canvas on any store change (cheap; rAF coalesces).
  useEffect(() => {
    canvasHandle.current?.invalidate();
  }, [pins, bonds, transform, tool, selectedPinNumber, hoveredPadId, footprint, geom]);

  // ── Interactions ──────────────────────────────────────────────────
  /** Convert world (source-pixel) point to package-mm world point. */
  const worldToPackageMm = useCallback(
    (wx: number, wy: number): { x: number; y: number } => {
      return { x: (wx - origin.x) / pxPerMm, y: (wy - origin.y) / pxPerMm };
    },
    [origin, pxPerMm]
  );

  /** Looser tolerance — packages are small (~mm scale); 1.5 mm covers
   *  pin-width + click slop. Pad snap is generous too (40 px). */
  const PIN_CLICK_MM = 1.5;
  const PAD_SNAP_PX = 40;

  const onPointerDown = useCallback(
    (e: PointerEventData): Interaction => {
      if (e.button !== 0) return "pan";
      const t = inputsRef.current.tool;
      if (t === "pan") return "pan";

      // For name and bond tools we want a click, not a drag.
      return {
        onPointerUp: ({ dragged, modifiers }) => {
          if (dragged) return;
          if (t === "name") {
            // Click a package pin → open inline editor on canvas.
            const pinMm = worldToPackageMm(e.worldPoint.x, e.worldPoint.y);
            const num = findClickedPin(
              pinMm.x,
              pinMm.y,
              inputsRef.current.pins,
              PIN_CLICK_MM
            );
            if (num != null) {
              const pin = inputsRef.current.pins.find((p) => p.number === num);
              setEditDraft(pin?.name ?? "");
              setEditingPinNumber(num);
            }
            return;
          }
          if (t === "bond") {
            const sel = inputsRef.current.selectedPinNumber;
            if (sel == null) {
              const pinMm = worldToPackageMm(
                e.worldPoint.x,
                e.worldPoint.y
              );
              const num = findClickedPin(
                pinMm.x,
                pinMm.y,
                inputsRef.current.pins,
                PIN_CLICK_MM
              );
              if (num != null) selectPin(num);
            } else {
              const pads = inputsRef.current.annotations?.pins ?? [];
              const img = die
                ? { width: die.width, height: die.height }
                : { width: 0, height: 0 };
              const snap = findNearestPad(
                e.worldPoint.x,
                e.worldPoint.y,
                pads,
                img.width,
                img.height,
                inputsRef.current.transform,
                PAD_SNAP_PX
              );
              if (snap) {
                addBond(sel, snap.id);
              } else {
                selectPin(null);
              }
            }
            return;
          }
          void modifiers;
        },
      } as Interaction;
    },
    [die, selectPin, addBond, worldToPackageMm]
  );

  const onCanvasClick = useCallback(
    (point: { x: number; y: number }) => {
      const t = inputsRef.current.tool;
      if (t === "name") {
        const pinMm = worldToPackageMm(point.x, point.y);
        const num = findClickedPin(
          pinMm.x,
          pinMm.y,
          inputsRef.current.pins,
          PIN_CLICK_MM
        );
        if (num != null) {
          const pin = inputsRef.current.pins.find((p) => p.number === num);
          setEditDraft(pin?.name ?? "");
          setEditingPinNumber(num);
        }
        return;
      }
      if (t !== "bond") return;
      const sel = inputsRef.current.selectedPinNumber;
      if (sel == null) {
        const pinMm = worldToPackageMm(point.x, point.y);
        const num = findClickedPin(
          pinMm.x,
          pinMm.y,
          inputsRef.current.pins,
          PIN_CLICK_MM
        );
        if (num != null) selectPin(num);
      }
    },
    [worldToPackageMm, selectPin]
  );

  // Hover handling for pad snap preview — use the canvas pointermove.
  useEffect(() => {
    if (tool !== "bond") {
      setHoveredPad(null);
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const canvas = el.querySelector("canvas");
    if (!canvas) return;
    const onMove = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const cssX = ev.clientX - rect.left;
      const cssY = ev.clientY - rect.top;
      const vp = canvasHandle.current?.getViewport();
      if (!vp) return;
      const disp = { x: vp.originX + cssX / vp.zoom, y: vp.originY + cssY / vp.zoom };
      const pads = inputsRef.current.annotations?.pins ?? [];
      if (!die) return;
      const snap = findNearestPad(
        disp.x,
        disp.y,
        pads,
        die.width,
        die.height,
        inputsRef.current.transform,
        PAD_SNAP_PX
      );
      setHoveredPad(snap?.id ?? null);
    };
    canvas.addEventListener("pointermove", onMove);
    return () => {
      canvas.removeEventListener("pointermove", onMove);
    };
  }, [tool, setHoveredPad, die]);

  // Auto-fit viewport when rotation or footprint changes, so the entire
  // (possibly rotated) image and package outline stay on screen. Mirrors
  // don't change the bbox so they're excluded from the refit trigger.
  const lastFitKey = useRef<string | null>(null);
  useEffect(() => {
    if (!die || !geom || containerSize.width === 0 || containerSize.height === 0) {
      return;
    }
    const key = `${transform.rotationDeg}|${footprint}`;
    if (lastFitKey.current === key) return;
    lastFitKey.current = key;
    const imgBbox = rotatedImageBbox(die.width, die.height, transform.rotationDeg);
    const pkgMinX = origin.x + geom.body.minX * pxPerMm;
    const pkgMinY = origin.y + geom.body.minY * pxPerMm;
    const pkgMaxX = origin.x + geom.body.maxX * pxPerMm;
    const pkgMaxY = origin.y + geom.body.maxY * pxPerMm;
    const minX = Math.min(imgBbox.x, pkgMinX);
    const minY = Math.min(imgBbox.y, pkgMinY);
    const maxX = Math.max(imgBbox.x + imgBbox.width, pkgMaxX);
    const maxY = Math.max(imgBbox.y + imgBbox.height, pkgMaxY);
    const vp = fitRectViewport(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      containerSize.width,
      containerSize.height,
      48, 32
    );
    canvasHandle.current?.setViewport(vp);
  }, [
    transform.rotationDeg, footprint,
    die, geom, containerSize.width, containerSize.height,
    origin, pxPerMm,
  ]);

  // Re-compute preview endpoint from hoveredPad → reads from store via WireBondLayer's
  // getBondPreview above. The store's hoveredPadId drives it.

  // Auto-cancel inline edit when the user leaves "name" mode, switches footprint,
  // or changes the pin number externally (e.g. via the right panel).
  useEffect(() => {
    if (editingPinNumber == null) return;
    const stillExists = pins.some((p) => p.number === editingPinNumber);
    if (tool !== "name" || !stillExists) {
      setEditingPinNumber(null);
      setEditDraft("");
    }
  }, [tool, pins, editingPinNumber]);

  // Global Escape: cancel inline edit or selected pin.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editingPinNumber != null) {
        setEditingPinNumber(null);
        setEditDraft("");
        e.preventDefault();
      } else if (selectedPinNumber != null && tool === "bond") {
        selectPin(null);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingPinNumber, selectedPinNumber, tool, selectPin]);

  // ── Save ─────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!annotations || !die) return;
    setSaveStatus("saving");
    try {
      const next: DieAnnotations = {
        ...annotations,
        icPackage: useIcPackageStore.getState().toConfig(),
      };
      await apiPut(`/api/dies/${dieId}/annotations`, next);
      // Refresh the cache.
      queryClient.setQueryData(["annotations", dieId], next);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 1200);
    } catch (e) {
      console.error("save icPackage failed", e);
      setSaveStatus("error");
      toast.error(`Save failed: ${(e as Error).message}`);
    }
  }, [annotations, die, dieId, queryClient, toast]);

  // Auto-save on bond/transform/pin changes (debounced).
  const saveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!annotations) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void save();
    }, 600);
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bonds, transform, footprint, pins.map((p) => p.name).join("|")]);

  // Walk all bonds; for every bond whose package pin has a name, copy that
  // name into annotations.pins[].name. Persisted on Apply click — keeps the
  // die viewer in sync with what the user has mapped in this view.
  const applyToDieViewer = useCallback(async () => {
    if (!annotations || !die) return;
    const { pins: pkgPins, bonds: pkgBonds } = useIcPackageStore.getState();
    const nameByPinNum = new Map<number, string>();
    for (const p of pkgPins) {
      const n = p.name.trim();
      if (n) nameByPinNum.set(p.number, n);
    }
    const padIdToName = new Map<string, string>();
    for (const bond of pkgBonds) {
      const n = nameByPinNum.get(bond.pinNumber);
      if (n) padIdToName.set(bond.diePadId, n);
    }
    if (padIdToName.size === 0) {
      toast.warning("No named bonds — name a package pin first.");
      return;
    }
    const basePins = annotations.pins ?? [];
    let updated = 0;
    const nextPins = basePins.map((p) => {
      const newName = padIdToName.get(p.id);
      if (newName && p.name !== newName) {
        updated++;
        return { ...p, name: newName };
      }
      return p;
    });
    if (updated === 0) {
      toast.warning("Die pads already match package names.");
      return;
    }
    const next: DieAnnotations = { ...annotations, pins: nextPins };
    setSaveStatus("saving");
    try {
      await apiPut(`/api/dies/${dieId}/annotations`, next);
      queryClient.setQueryData(["annotations", dieId], next);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 1200);
      toast.success(`Applied names to ${updated} die pad(s)`);
    } catch (e) {
      setSaveStatus("error");
      toast.error(`Apply failed: ${(e as Error).message}`);
    }
  }, [annotations, die, dieId, queryClient, toast]);

  // Disable the Apply button when no bonds have a named pin.
  const applyDisabled = useMemo(() => {
    const { pins: pkgPins, bonds: pkgBonds } = useIcPackageStore.getState();
    const namedPinNums = new Set(
      pkgPins.filter((p) => p.name.trim()).map((p) => p.number)
    );
    return !pkgBonds.some((b) => namedPinNums.has(b.pinNumber));
  }, [pins, bonds]);

  // ── Render ────────────────────────────────────────────────────────
  const centerMsg = !die
    ? isLoading ? "loading die…" : error ? `error: ${(error as Error).message}` : "loading die…"
    : !initialViewport ? "preparing…" : null;

  return (
    <AppShell
      meta="IC Package"
      savedAgo={
        saveStatus === "saved" ? "saved"
          : saveStatus === "saving" ? "saving…"
            : saveStatus === "error" ? "save failed"
              : undefined
      }
    >
      <IcPackageToolbar
        onApplyToDieViewer={applyToDieViewer}
        applyDisabled={applyDisabled}
        right={<OverlaySelector value={bgOverlayId} onChange={setBgOverlayId} />}
      />
      <div style={{ flex: "1 1 auto", display: "flex", minHeight: 0 }}>
        <div
          ref={containerRef}
          style={{ flex: "1 1 auto", position: "relative", minWidth: 0, background: "var(--bg)" }}
        >
          {die && initialViewport ? (
            <>
              <TiledCanvas
                layers={layers}
                initialViewport={initialViewport}
                onPointerDown={onPointerDown}
                onCanvasClick={onCanvasClick}
                onViewportChange={() => setViewportVersion((v) => v + 1)}
                // No min-zoom cap: large packages (QFP-128 spans ~30 mm) at
                // umPerPx=0.25 still need to fit; default 0.01 cuts them off.
                minZoom={1e-9}
                maxZoom={64}
                cursor={
                  tool === "name" ? "text"
                    : tool === "bond" ? (selectedPinNumber == null ? "crosshair" : "cell")
                      : "default"
                }
                handleRef={canvasHandle}
              />
              <div
                style={{
                  position: "absolute",
                  left: 12,
                  bottom: 12,
                  padding: "6px 10px",
                  background: "rgba(0,0,0,0.55)",
                  borderRadius: 4,
                  fontSize: 11,
                  color: "var(--ink2)",
                  pointerEvents: "none",
                }}
              >
                {tool === "bond" ? (
                  selectedPinNumber == null
                    ? "Click a package pin to start a bond"
                    : hoveredPadId
                      ? `Click die pad to bond pin ${selectedPinNumber} → ${hoveredPadId}`
                      : `Click a die pad to bond pin ${selectedPinNumber} (Esc to cancel)`
                ) : tool === "name" ? (
                  "Click pin name in right panel to edit"
                ) : (
                  `Drag to pan, scroll to zoom · ${pins.length} pins · ${bonds.length} bonds`
                )}
              </div>
              {editingPinNumber != null && (() => {
                const pin = pins.find((p) => p.number === editingPinNumber);
                if (!pin) return null;
                const vp = canvasHandle.current?.getViewport();
                if (!vp) return null;
                const wx = origin.x + pin.x * pxPerMm;
                const wy = origin.y + pin.y * pxPerMm;
                const cssX = (wx - vp.originX) * vp.zoom;
                const cssY = (wy - vp.originY) * vp.zoom;
                // Off-screen? Hide.
                if (cssX < -50 || cssY < -50 || cssX > containerSize.width + 50 || cssY > containerSize.height + 50) {
                  return null;
                }
                return (
                  <input
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onFocus={(e) => {
                      // Select existing name so typing replaces; cursor at end if empty.
                      const v = e.target.value;
                      e.target.setSelectionRange(v.length, v.length);
                    }}
                    onBlur={() => {
                      const name = editDraft.trim();
                      if (name) namePin(pin.number, name);
                      else removePinName(pin.number);
                      setEditingPinNumber(null);
                      setEditDraft("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") {
                        setEditingPinNumber(null);
                        setEditDraft("");
                        (e.target as HTMLInputElement).blur();
                      }
                      // Stop propagation so global handlers don't pan/zoom.
                      e.stopPropagation();
                    }}
                    style={{
                      position: "absolute",
                      left: cssX + 4,
                      top: cssY - 18,
                      zIndex: 10,
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 12,
                      padding: "2px 6px",
                      minWidth: 90,
                      background: "var(--card)",
                      color: "var(--ink)",
                      border: "1px solid var(--accent)",
                      borderRadius: 3,
                      outline: "none",
                    }}
                    placeholder={`pin ${pin.number}`}
                    title="Enter to save, Esc to cancel"
                  />
                );
              })()}
            </>
          ) : (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--ink3)",
                fontSize: 12,
              }}
            >
              {centerMsg}
            </div>
          )}
        </div>
        {die && initialViewport ? (
          <div
            style={{
              width: 260,
              flex: "0 0 auto",
              borderLeft: "1px solid var(--l2)",
              background: "var(--card)",
              display: "flex",
              flexDirection: "column",
              padding: 8,
              gap: 8,
              overflowY: "auto",
            }}
          >
            <PackageSelector />
            <DieTransformPanel />
            <PinListPanel />
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
