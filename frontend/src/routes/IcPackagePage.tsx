import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { DieAnnotations } from "shared";
import { useAnnotations } from "../api/annotations";
import { useDie } from "../api/dies";
import { apiPut } from "../api/client";
import { useIcPackageStore } from "../state/icPackage";
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
import {
  findNearestPad,
  findClickedPin,
} from "../lib/ic-package/transform";
import { loadPackageGeom } from "../lib/ic-package/footprinter";
import type { Layer, Viewport } from "../renderer/types";
import { PackageSelector } from "../components/ic-package/PackageSelector";
import { PinListPanel } from "../components/ic-package/PinListPanel";
import { DieTransformPanel } from "../components/ic-package/DieTransformPanel";
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

  // Initial viewport: fit the die image into the container.
  const initialViewport = useMemo<Viewport | null>(() => {
    if (!die || containerSize.width === 0 || containerSize.height === 0) return null;
    return fitRectViewport(
      { x: 0, y: 0, width: die.width, height: die.height },
      containerSize.width,
      containerSize.height,
      48,
      32
    );
  }, [die, containerSize.width, containerSize.height]);

  // ── Layers ────────────────────────────────────────────────────────
  const layers = useMemo<Layer[]>(() => {
    if (!die) return [];
    const imgSize = { width: die.width, height: die.height };
    return [
      new DieImageLayer(die, {
        getTransform: () => inputsRef.current.transform,
      }),
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
    ];
  }, [die, geom, pxPerMm, origin]);

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

  const onPointerDown = useCallback(
    (e: PointerEventData): Interaction => {
      if (e.button !== 0) return "pan";
      const t = inputsRef.current.tool;
      if (t === "pan") return "pan";

      // For name and bond tools we want a click, not a drag.
      return {
        onPointerUp: ({ dragged, modifiers }) => {
          if (dragged) return;
          if (t === "bond") {
            const sel = inputsRef.current.selectedPinNumber;
            if (sel == null) {
              // Click on package pin (in mm).
              const pinMm = worldToPackageMm(
                e.worldPoint.x,
                e.worldPoint.y
              );
              const num = findClickedPin(
                pinMm.x,
                pinMm.y,
                inputsRef.current.pins,
                0.5
              );
              if (num != null) selectPin(num);
            } else {
              // Commit bond: snap to die pad in display coords = world coords.
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
                24
              );
              if (snap) {
                addBond(sel, snap.id);
              } else {
                // No pad under cursor → cancel selection.
                selectPin(null);
              }
            }
            return;
          }
          // "name" goes through PinListPanel click; "pan" handled by default.
          void modifiers;
        },
      } as Interaction;
    },
    [die, selectPin, addBond, worldToPackageMm]
  );

  const onCanvasClick = useCallback(
    (point: { x: number; y: number }) => {
      // Mirror of onPointerDown's no-drag branch for users that prefer click.
      const t = inputsRef.current.tool;
      if (t !== "bond") return;
      const sel = inputsRef.current.selectedPinNumber;
      if (sel == null) {
        const pinMm = worldToPackageMm(point.x, point.y);
        const num = findClickedPin(pinMm.x, pinMm.y, inputsRef.current.pins, 0.5);
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
        24
      );
      setHoveredPad(snap?.id ?? null);
    };
    canvas.addEventListener("pointermove", onMove);
    return () => {
      canvas.removeEventListener("pointermove", onMove);
    };
  }, [tool, setHoveredPad, die]);

  // Re-compute preview endpoint from hoveredPad → reads from store via WireBondLayer's
  // getBondPreview above. The store's hoveredPadId drives it.

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

  // ── Render ────────────────────────────────────────────────────────
  if (isLoading || error || !die || !initialViewport) {
    return (
      <AppShell>
        <div
          style={{
            flex: "1 1 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ink3)",
            fontSize: 12,
          }}
        >
          {isLoading ? "loading die…" : error ? `error: ${(error as Error).message}` : "preparing…"}
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell meta="IC Package" savedAgo={saveStatus === "saved" ? "saved" : saveStatus === "saving" ? "saving…" : saveStatus === "error" ? "save failed" : undefined}>
      <div style={{ flex: "1 1 auto", display: "flex", minHeight: 0 }}>
        <div
          ref={containerRef}
          style={{ flex: "1 1 auto", position: "relative", minWidth: 0, background: "var(--bg)" }}
        >
          <TiledCanvas
            layers={layers}
            initialViewport={initialViewport}
            onPointerDown={onPointerDown}
            onCanvasClick={onCanvasClick}
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
        </div>
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
      </div>
    </AppShell>
  );
}
