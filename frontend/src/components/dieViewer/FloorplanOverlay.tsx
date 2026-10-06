/**
 * FloorplanOverlay.tsx — Renders floorplan region outlines on the canvas
 * as positioned HTML divs.
 *
 * Single click on the outline or the label selects the region (Shift: toggle
 * it in the selection); double click opens its window. Only the outline and
 * label catch the mouse — the interior passes through to the canvas.
 */

import { useCallback, useMemo, useState } from "react";
import type { DieAnnotations, FloorplanRegion } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import { useLiveValue } from "../../lib/liveValue";
import { useFloorplanStore } from "../../state/floorplan";
import { useDieViewerStore } from "../../state/dieViewer";
import { usePreferences } from "../../state/preferences";
import type { Viewport } from "../../renderer/types";
import { FloorplanRegionPopover } from "./FloorplanRegionPopover";
import { FloorplanEditHandles } from "./FloorplanEditHandles";
import { FloorplanPolyDraft } from "./FloorplanPolyDraft";
import { floorplanNameLines } from "../../lib/floorplanName";
import { isFloorplanVisible } from "../../lib/floorplanSnapshot";
import type { ActionDispatcher } from "../../api/actions";
import { useAuth } from "../../state/auth";
import { useToast } from "../Toast";

interface Props {
  annotations: DieAnnotations | undefined;
  viewportStore: LiveValue<Viewport | null>;
  /** Rubber-band tip of the polygon draft (world; the cursor constrained to
   *  the floorplan angle mode — see DieViewerPage.constrainPolyPoint). */
  cursorStore: LiveValue<{ x: number; y: number } | null>;
  dieId: string;
  /** Floorplan edits go through it, so they are undoable. */
  dispatcher: ActionDispatcher;
  /** When true, show port dot markers on all region blocks */
  showIO?: boolean;
  /** Called when annotations have changed (to trigger a refetch). */
  onAnnotationChange?: () => void;
}

const FLOORPLAN_STROKE_WIDTH = 2.2;

/** A (possibly multiline) region name as <tspan> rows; the first row sits on
 *  the parent <text>'s y. Blank rows keep their height. */
function NameLines({ name, x, fontSize }: { name: string; x: number; fontSize: number }) {
  return (
    <>
      {floorplanNameLines(name).map((line, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : fontSize * 1.2}>
          {line || "\u00a0"}
        </tspan>
      ))}
    </>
  );
}
const FLOORPLAN_DRAFT_STROKE_WIDTH = 2.2;

/**
 * Renders floorplan region outlines + popover.
 * - Click on outline / label → select (Shift: toggle)
 * - Double-click on outline / label → open the window (Shift: keep selection)
 * - Clicks inside the region → pass through to the canvas
 */
export function FloorplanOverlay({
  annotations,
  viewportStore,
  cursorStore,
  dieId,
  dispatcher,
  showIO,
  onAnnotationChange,
}: Props) {
  const viewport = useLiveValue(viewportStore);
  const regions = useFloorplanStore((s) => s.regions);
  const openRegionId = useFloorplanStore((s) => s.openRegionId);
  const selectRegion = useFloorplanStore((s) => s.selectRegion);
  const openRegion = useFloorplanStore((s) => s.openRegion);
  const viewerSelection = useDieViewerStore((s) => s.selectedIds);
  const draft = useFloorplanStore((s) => s.draft);
  const editingRegionId = useFloorplanStore((s) => s.editingRegionId);
  const upsertRegion = useFloorplanStore((s) => s.upsertRegion);
  const userId = useAuth((s) => s.userId);
  const toast = useToast();
  /** Geometry of the region being reshaped, while a handle drag is live. */
  const [liveEdit, setLiveEdit] = useState<{ id: string; geometry: FloorplanRegion["geometry"] } | null>(null);
  const floorplanGloballyHidden = usePreferences((s) => s.hiddenKinds.includes("floorplan"));
  const hiddenFloorplanTypeNames = usePreferences((s) => s.hiddenFloorplanTypeNames);
  const isRegionVisible = useCallback(
    (region: FloorplanRegion) => isFloorplanVisible(region, floorplanGloballyHidden, hiddenFloorplanTypeNames),
    [floorplanGloballyHidden, hiddenFloorplanTypeNames]
  );

  const clickRegion = useCallback(
    (region: FloorplanRegion, e: React.MouseEvent) => selectRegion(region.id, e.shiftKey ? "toggle" : "replace"),
    [selectRegion],
  );
  // Stop the double-click here so the canvas underneath doesn't treat it as
  // its own (e.g. opening the cell type picker for a cell under the outline).
  const openPopover = useCallback(
    (region: FloorplanRegion, e: React.MouseEvent) => {
      e.stopPropagation();
      openRegion(region.id, e.shiftKey);
    },
    [openRegion],
  );

  const handlePopoverClose = useCallback(() => {
    openRegion(null);
  }, [openRegion]);

  // Build rendered items from saved regions + draft
  const renderedRegions = useMemo(() => {
    if (!viewport) return [];
    const items: { region: FloorplanRegion; cssLeft: number; cssTop: number; cssW: number; cssH: number; isDraft: boolean }[] = [];

    for (const saved of regions) {
      if (!isRegionVisible(saved)) continue;
      const r = liveEdit?.id === saved.id ? { ...saved, geometry: liveEdit.geometry } : saved;
      const pts = r.geometry;
      const minX = Math.min(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y));
      const maxX = Math.max(...pts.map((p) => p.x));
      const maxY = Math.max(...pts.map((p) => p.y));
      items.push({
        region: r,
        cssLeft: (minX - viewport.originX) * viewport.zoom,
        cssTop: (minY - viewport.originY) * viewport.zoom,
        cssW: (maxX - minX) * viewport.zoom,
        cssH: (maxY - minY) * viewport.zoom,
        isDraft: false,
      });
    }

    // Draft (in-progress rect drag or poly)
    // Polygon drafts are drawn by FloorplanPolyDraft (from the first click,
    // with a rubber band to the cursor); only the rect drag lives here.
    if (draft && draft.active && draft.kind === "rect" && draft.points.length >= 2) {
      const pts = draft.points;
      const minX = Math.min(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y));
      const maxX = Math.max(...pts.map((p) => p.x));
      const maxY = Math.max(...pts.map((p) => p.y));
      items.push({
        region: {
          id: "__draft__",
          name: "",
          kind: draft.kind,
          geometry: pts,
          color: "#aaa",
          createdBy: null,
          createdByName: null,
          createdAt: null,
          reservedBy: null,
          reservedByName: null,
          reservedAt: null,
          portAliases: undefined,
        } as FloorplanRegion,
        cssLeft: (minX - viewport.originX) * viewport.zoom,
        cssTop: (minY - viewport.originY) * viewport.zoom,
        cssW: (maxX - minX) * viewport.zoom,
        cssH: (maxY - minY) * viewport.zoom,
        isDraft: true,
      });
    }

    return items;
  }, [regions, draft, viewport, isRegionVisible, liveEdit]);

  // ── Geometry editing ────────────────────────────────────
  // Regions reserved by someone else keep their shape.
  const editingRegion = editingRegionId
    ? regions.find((r) => r.id === editingRegionId) ?? null
    : null;
  const canEdit =
    !!editingRegion &&
    isRegionVisible(editingRegion) &&
    (!editingRegion.reservedBy || editingRegion.reservedBy === userId);

  const commitGeometry = useCallback(
    (updated: FloorplanRegion) => {
      const previous = regions.find((r) => r.id === updated.id);
      if (!previous) return;
      // Instant feedback; the store re-syncs from annotations (incl. rollback).
      upsertRegion(updated);
      setLiveEdit(null);
      void dispatcher
        .dispatch({ kind: "upsertFloorplan", region: updated, prevRegion: previous })
        .then((ok) => {
          if (ok) onAnnotationChange?.();
          else {
            upsertRegion(previous);
            toast.error("Failed to save floorplan");
          }
        });
    },
    [regions, upsertRegion, dispatcher, onAnnotationChange, toast],
  );

  // Selected region for popover
  const selectedRegion = openRegionId
    ? regions.find((r) => r.id === openRegionId) ?? null
    : null;

  // ── Port visualization ──────────────────────────────────
  // Shows port dots on region blocks.
  //   — Always shows dots for the selected (popover) region
  //   — When showIO is enabled, shows dots for ALL regions
  //   — When showIO is off and no region selected, nothing shows
  // Uses annotation-node proximity detection (find first node inside region polygon).
  const portDots = useMemo(() => {
    if (!annotations || !viewport) return null;

    const regionsToRender: FloorplanRegion[] = [];
    if (showIO) {
      regionsToRender.push(...regions);
    } else if (selectedRegion) {
      regionsToRender.push(selectedRegion);
    }
    if (regionsToRender.length === 0) return null;

    const nets = annotations.nets ?? [];
    const result: { x: number; y: number; color: string; label: string; key: string }[] = [];

    for (const region of regionsToRender) {
      const poly =
        region.kind === "rect" && region.geometry.length >= 2
          ? [
              { x: Math.min(region.geometry[0].x, region.geometry[1].x), y: Math.min(region.geometry[0].y, region.geometry[1].y) },
              { x: Math.max(region.geometry[0].x, region.geometry[1].x), y: Math.min(region.geometry[0].y, region.geometry[1].y) },
              { x: Math.max(region.geometry[0].x, region.geometry[1].x), y: Math.max(region.geometry[0].y, region.geometry[1].y) },
              { x: Math.min(region.geometry[0].x, region.geometry[1].x), y: Math.max(region.geometry[0].y, region.geometry[1].y) },
            ]
          : region.geometry;

      const pointInPoly = (px: number, py: number) => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i].x, yi = poly[i].y;
          const xj = poly[j].x, yj = poly[j].y;
          if ((yi > py) !== (yj > py) &&
              px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
          }
        }
        return inside;
      };

      const color = region.color || "#4dabf7";

      for (const net of nets) {
        if (!net.name || net.name === "vcc" || net.name === "gnd" ||
            net.name === "VDD" || net.name === "GND" || net.name === "VSS") continue;
        const firstInsideNode = net.nodes.find((n) => pointInPoly(n.x, n.y));
        if (firstInsideNode) {
          // Dedup: same (region, net, position) should not repeat
          const key = `${region.id}_${net.id}_${firstInsideNode.x.toFixed(1)}_${firstInsideNode.y.toFixed(1)}`;
          if (!result.some((d) => d.key === key)) {
            result.push({ x: firstInsideNode.x, y: firstInsideNode.y, color, label: net.name, key });
          }
        }
      }
    }

    return result.length > 0 ? result : null;
  }, [selectedRegion, annotations, viewport, showIO, regions]);

  return (
    <>
      {/* Region outlines */}
      {renderedRegions.map(({ region, cssLeft, cssTop, cssW, cssH, isDraft }) => {
        const isSelected = region.id === openRegionId || viewerSelection.has(`floorplan:${region.id}`);
        const color = region.color || "#4dabf7";
        const sw = isDraft ? FLOORPLAN_DRAFT_STROKE_WIDTH : FLOORPLAN_STROKE_WIDTH;

        // Accept both "poly" (legacy) and "polygon" for polygon regions
        const isPoly = (region.kind as string) === "poly" || region.kind === "polygon";
        if (isPoly) {
          // SVG polygon for poly regions
          // Polygon outline + label: click selects, double-click opens the window.
          return (
            <svg
              key={region.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
                zIndex: 8,
              }}
            >
              <polygon
                points={
                  viewport
                    ? region.geometry
                        .map((p) => {
                          const px = (p.x - viewport.originX) * viewport.zoom;
                          const py = (p.y - viewport.originY) * viewport.zoom;
                          return `${px},${py}`;
                        })
                        .join(" ")
                    : ""
                }
                fill="none"
                stroke={isSelected ? "#fff" : color}
                strokeWidth={isDraft ? sw : sw * 1.3}
                strokeDasharray={isDraft ? "5 4" : "7 4"}
                opacity={isDraft ? 0.6 : 1}
                style={{ pointerEvents: "auto", cursor: "pointer" }}
                onClick={(e) => !isDraft && clickRegion(region, e)}
                onDoubleClick={(e) => !isDraft && openPopover(region, e)}
              />
              {/* Label — click selects, double-click opens the window */}
              {region.name && !isDraft && viewport && (
                <text
                  x={(region.geometry[0].x - viewport.originX) * viewport.zoom + 8}
                  y={(region.geometry[0].y - viewport.originY) * viewport.zoom + 18}
                  fill={color}
                  fontSize={Math.max(13, 14 * viewport.zoom / 1000)}
                  fontWeight="600"
                  style={{ pointerEvents: "auto", cursor: "pointer", textShadow: "0 0 4px rgba(0,0,0,0.7)" }}
                  onClick={(e) => !isDraft && clickRegion(region, e)}
                  onDoubleClick={(e) => !isDraft && openPopover(region, e)}
                >
                  <NameLines
                    name={region.name}
                    x={(region.geometry[0].x - viewport.originX) * viewport.zoom + 8}
                    fontSize={Math.max(13, 14 * viewport.zoom / 1000)}
                  />
                </text>
              )}
              {/* Draft vertex dots */}
              {isDraft && viewport && (region.geometry as any).length > 0 && (
                (region.geometry as { x: number; y: number }[]).map((p, i) => (
                  <circle
                    key={i}
                    cx={(p.x - viewport.originX) * viewport.zoom}
                    cy={(p.y - viewport.originY) * viewport.zoom}
                    r={3}
                    fill="#fff"
                    stroke="#888"
                    strokeWidth={1.5}
                  />
                ))
              )}
            </svg>
          );
        }

        // Rect region: SVG rect with fill="none" so only the border
        // line catches events — interior passes through to canvas.
        // Outline + label: click selects, double-click opens the window.
        // This mirrors the poly region SVG approach.
        return (
          <svg
            key={region.id}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              zIndex: 8,
            }}
          >
            <rect
              x={cssLeft}
              y={cssTop}
              width={Math.max(0, cssW)}
              height={Math.max(0, cssH)}
              fill="none"
              stroke={isSelected ? "#fff" : color}
              strokeWidth={sw}
              strokeDasharray={isDraft ? "5 4" : "7 4"}
              rx={3}
              ry={3}
              opacity={isDraft ? 0.6 : 1}
              style={{ pointerEvents: isDraft ? "none" : "auto", cursor: "pointer" }}
              onClick={(e) => !isDraft && clickRegion(region, e)}
                onDoubleClick={(e) => !isDraft && openPopover(region, e)}
            />
            {/* Label — click selects, double-click opens the window */}
            {region.name && !isDraft && (
              <text
                x={cssLeft + 6}
                y={cssTop + 16}
                fill={color}
                fontSize={Math.max(13, 14 * viewport!.zoom / 1000)}
                fontWeight="600"
                style={{ pointerEvents: "auto", cursor: "pointer", textShadow: "0 0 4px rgba(0,0,0,0.8)" }}
                onClick={(e) => clickRegion(region, e)}
                onDoubleClick={(e) => openPopover(region, e)}
              >
                <NameLines name={region.name} x={cssLeft + 6} fontSize={Math.max(13, 14 * viewport!.zoom / 1000)} />
              </text>
            )}
            {/* Draft size readout */}
            {isDraft && (
              <text
                x={cssLeft + cssW - 4}
                y={cssTop + cssH - 4}
                fill="#aaa"
                fontSize={11}
                textAnchor="end"
                style={{ pointerEvents: "none", textShadow: "0 0 3px rgba(0,0,0,0.8)" }}
              >
                {Math.round(cssW)} × {Math.round(cssH)}
              </text>
            )}
          </svg>
        );
      })}

      {/* Polygon being drawn */}
      {draft && draft.active && draft.kind === "poly" && viewport && (
        <FloorplanPolyDraft draft={draft} viewport={viewport} cursorStore={cursorStore} />
      )}

      {/* Geometry edit handles */}
      {canEdit && editingRegion && viewport && (
        <FloorplanEditHandles
          region={editingRegion}
          viewport={viewport}
          live={liveEdit?.id === editingRegion.id ? liveEdit.geometry : null}
          setLive={(geometry) => setLiveEdit(geometry ? { id: editingRegion.id, geometry } : null)}
          onCommit={commitGeometry}
        />
      )}

      {/* Popover */}
      {selectedRegion && viewport && (
        <FloorplanRegionPopover
          region={selectedRegion}
          dieId={dieId}
          dispatcher={dispatcher}
          viewportStore={viewportStore}
          annotations={annotations}
          onClose={handlePopoverClose}
          onSaved={onAnnotationChange}
        />
      )}

      {/* Port dots */}
      {portDots && viewport && (
        <svg
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: 9,
          }}
        >
          {portDots.map((dot) => (
            <g key={dot.key}>
              <circle
                cx={(dot.x - viewport.originX) * viewport.zoom}
                cy={(dot.y - viewport.originY) * viewport.zoom}
                r={5}
                fill={dot.color}
                fillOpacity={0.8}
                stroke="#fff"
                strokeWidth={1.5}
              />
              <text
                x={(dot.x - viewport.originX) * viewport.zoom + 8}
                y={(dot.y - viewport.originY) * viewport.zoom + 4}
                fill={dot.color}
                fontSize={Math.max(10, 13 * viewport.zoom / 1000)}
                fontWeight="600"
                style={{ textShadow: "0 0 4px rgba(0,0,0,0.9)" }}
              >
                {dot.label}
              </text>
            </g>
          ))}
        </svg>
      )}
    </>
  );
}
