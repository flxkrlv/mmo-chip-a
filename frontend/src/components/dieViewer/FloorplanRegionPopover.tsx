/**
 * FloorplanRegionPopover.tsx — Popover for editing/deleting a floorplan region.
 *
 * Shows: region name (editable), color picker, port aliases (B3), Delete button.
 * ReservedBy section is shown only when non-null.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DieAnnotations, FloorplanRegion } from "shared";
import { apiPut, apiDelete } from "../../api/client";
import { collectDieWideAnalogDevices } from "../../api/dieWideAnalog";
import { useAuth } from "../../state/auth";
import { useFloorplanStore } from "../../state/floorplan";
import {
  deviceInRegion,
  detectBoundaryNets,
  resolveGlobalPortAliases,
} from "../../lib/export/hierarchical";
import type { Viewport } from "../../renderer/types";

interface Props {
  region: FloorplanRegion;
  dieId: string;
  viewport: Viewport;
  annotations?: DieAnnotations;
  onClose: () => void;
  onSaved?: () => void;
}

const COLORS = [
  "#4dabf7", // blue
  "#69db7c", // green
  "#ffd43b", // yellow
  "#ff8787", // red
  "#da77f2", // purple
  "#ff922b", // orange
  "#748ffc", // indigo
  "#20c997", // teal
];

/**
 * Detect which nets are boundary nets for the region, based on
 * analog device terminals — same logic as the hierarchical netlist
 * generator.  This guarantees the popover shows exactly the ports
 * that will appear in the netlist.
 */
function detectRegionPorts(
  region: FloorplanRegion,
  annotations: DieAnnotations | undefined,
): { netName: string; netId: number }[] {
  if (!annotations) return [];

  // Compute analog devices from annotations (same as DieViewerPage)
  let devices = [];
  let namedNets = new Map<number, string>();
  try {
    const r = collectDieWideAnalogDevices(annotations as any, annotations.umPerPx ?? 1);
    devices = r.devices;
    namedNets = r.namedNets;
  } catch {
    return [];
  }

  // Find devices inside this region
  const insideDevices = devices.filter((d: any) => deviceInRegion(d, region));
  if (insideDevices.length === 0) return [];

  // Detect boundary nets
  const boundaryNets = detectBoundaryNets(insideDevices, devices);

  // Resolve net names, exclude VDD/GND
  const result: { netName: string; netId: number }[] = [];
  for (const netId of boundaryNets) {
    const rawName = namedNets.get(netId) ?? `n${netId}`;
    if (rawName === "vcc" || rawName === "gnd" ||
        rawName === "VDD" || rawName === "GND" || rawName === "VSS" ||
        rawName === "0") continue;
    result.push({ netName: rawName, netId });
  }

  return result;
}

export function FloorplanRegionPopover({
  region,
  dieId,
  viewport,
  annotations,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState(region.name);
  const [color, setColor] = useState(region.color || "#4dabf7");
  const [portAliases, setPortAliases] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (region.portAliases) {
      for (const [netIdStr, alias] of Object.entries(region.portAliases)) {
        init[`n${netIdStr}`] = alias;
      }
    }
    return init;
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const upsertRegion = useFloorplanStore((s) => s.upsertRegion);
  const removeRegion = useFloorplanStore((s) => s.removeRegion);
  const selectRegion = useFloorplanStore((s) => s.selectRegion);
  const popoverRef = useRef<HTMLDivElement>(null);

  // ── Port detection (B3) ───────────────────────────────────
  const detectedPorts = useMemo(
    () => detectRegionPorts(region, annotations),
    [region, annotations],
  );

  const updatePortAlias = useCallback((netKey: string, value: string) => {
    setPortAliases((prev) => ({ ...prev, [netKey]: value }));
    setDirty(true);
  }, []);

  const buildPortAliasesForSave = useCallback((): Record<number, string> => {
    const result: Record<number, string> = {};
    for (const [key, alias] of Object.entries(portAliases)) {
      if (!alias.trim()) continue;
      const netId = parseInt(key.slice(1), 10);
      if (!isNaN(netId)) result[netId] = alias.trim();
    }
    return result;
  }, [portAliases]);

  // Click outside → close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const updated: FloorplanRegion = {
        ...region,
        name,
        color,
        createdByName: region.createdByName ?? null,
        reservedByName: region.reservedByName ?? null,
        portAliases: Object.keys(buildPortAliasesForSave()).length > 0
          ? buildPortAliasesForSave()
          : undefined,
      };
      await apiPut(`/api/dies/${dieId}/floorplan/${region.id}`, updated);
      upsertRegion(updated);
      setDirty(false);
      onSaved?.();
    } catch (err) {
      console.error("Failed to save floorplan region:", err);
    } finally {
      setSaving(false);
    }
  }, [region, dieId, name, color, saving, upsertRegion, onSaved, buildPortAliasesForSave]);

  const handleDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await apiDelete(`/api/dies/${dieId}/floorplan/${region.id}`);
      removeRegion(region.id);
      selectRegion(null);
      onSaved?.();
    } catch (err) {
      console.error("Failed to delete floorplan region:", err);
    } finally {
      setDeleting(false);
    }
  }, [region.id, dieId, deleting, removeRegion, selectRegion, onSaved]);

  // Compute popover position from region's first point
  const firstP = region.geometry[0] || { x: 0, y: 0 };
  const cssX = (firstP.x - viewport.originX) * viewport.zoom;
  const cssY = (firstP.y - viewport.originY) * viewport.zoom;
  const popW = 280;
  const margin = 12;
  let left = cssX + margin;
  let top = cssY - 100;
  if (left + popW > window.innerWidth - margin) {
    left = cssX - popW - margin;
  }
  left = Math.max(margin, left);
  top = Math.max(margin, top);

  return (
    <div
      ref={popoverRef}
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 1000,
        background: "#2a2a2e",
        border: "1px solid #444",
        borderRadius: 8,
        padding: 12,
        minWidth: popW,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        color: "#ddd",
        fontSize: 13,
      }}
    >
      {/* Name */}
      <label style={{ display: "block", marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 2, display: "block" }}>
          Name
        </span>
        <input
          className="input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          placeholder="e.g. VCC_UVLO"
          style={{ width: "100%", boxSizing: "border-box" }}
        />
      </label>

      {/* Port aliases (B3) */}
      {detectedPorts.length > 0 && (
        <label style={{ display: "block", marginBottom: 10 }}>
          <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 4, display: "block" }}>
            Ports ({detectedPorts.length})
          </span>
          <div style={{ maxHeight: 140, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {detectedPorts.map((p) => {
              const key = `n${p.netId}`;
              const alias = portAliases[key] ?? "";
              return (
                <div key={p.netId} className="row" style={{ gap: 4, alignItems: "center", fontSize: 11 }}>
                  <span style={{ color: "#aaa", minWidth: 60, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.netName}
                  </span>
                  <span style={{ color: "#666" }}>→</span>
                  <input
                    className="input"
                    value={alias}
                    onChange={(e) => updatePortAlias(key, e.target.value)}
                    placeholder="alias (optional)"
                    style={{ flex: 1, fontSize: 11, padding: "2px 4px", minWidth: 0 }}
                  />
                </div>
              );
            })}
          </div>
        </label>
      )}

      {/* Color */}
      <label style={{ display: "block", marginBottom: 12 }}>
        <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 4, display: "block" }}>
          Color
        </span>
        <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => {
                setColor(c);
                setDirty(true);
              }}
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: c,
                border: c === color ? "2px solid #fff" : "2px solid transparent",
                cursor: "pointer",
                padding: 0,
              }}
            />
          ))}
        </span>
      </label>

      {/* Created by */}
      {region.createdByName && (
        <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
          Created by: <strong>{region.createdByName}</strong>
          {region.createdAt && (
            <span> — {new Date(region.createdAt).toLocaleDateString()}</span>
          )}
        </div>
      )}

      {/* Reserved info (if set) */}
      {region.reservedByName && (
        <div style={{ fontSize: 11, color: "#ffd43b", marginBottom: 4 }}>
          🔒 Reserved by: <strong>{region.reservedByName}</strong>
          {region.reservedAt && (
            <span> — {new Date(region.reservedAt).toLocaleDateString()}</span>
          )}
        </div>
      )}

      {/* Reserve/Release button (multiplayer) */}
      {!region.reservedBy && (
        <div style={{ marginBottom: 8 }}>
          <button
            className="btn sm plain"
            onClick={async () => {
              try {
                const au = useAuth.getState();
                await apiPut(`/api/dies/${dieId}/floorplan/${region.id}`, {
                  ...region, name, color,
                  reservedBy: au.userId ?? null,
                  reservedByName: au.username ?? null,
                  reservedAt: new Date().toISOString(),
                });
                upsertRegion({ ...region, reservedBy: au.userId ?? null, reservedByName: au.username ?? null, reservedAt: new Date().toISOString() });
                setDirty(false);
                onSaved?.();
              } catch (err) {
                console.error("Failed to reserve:", err);
              }
            }}
            disabled={saving}
          >
            🔒 Reserve
          </button>
          <span style={{ fontSize: 10, color: "#666", marginLeft: 6 }}>
            Optional — WIP indicator
          </span>
        </div>
      )}

      {/* Actions */}
      <span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button className="btn sm plain" onClick={onClose}>
          Close
        </button>
        <button
          className="btn sm danger"
          onClick={handleDelete}
          disabled={deleting}
        >
          {deleting ? "…" : "Delete"}
        </button>
        <button
          className="btn sm accent"
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </span>
    </div>
  );
}
