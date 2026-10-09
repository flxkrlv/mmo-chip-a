/**
 * NetRenamePopover.tsx — Non-modal window for renaming / recoloring a net,
 * styled like FloorplanRegionPopover. Opens beside the double-click (or where
 * it was last dragged to, re-anchored to the nearest net node — see
 * useElementWindow) and follows pan / zoom; the canvas stays usable.
 *
 * Name and color are a draft applied together on Save (like the floorplan
 * popover). The color is the per-user net color override (preferences), the
 * same one the outline tree's swatch sets.
 *
 * Enter saves, Escape / Close / clicking outside closes. A name already used
 * by another net shows a live inline warning and the button reads "Save anyway".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationNet } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import { netAnchorPoints, windowAnchorKey } from "../../lib/windowAnchor";
import type { Viewport } from "../../renderer/types";
import { NetColorPickerBody } from "./NetColorPickerBody";
import { useElementWindow } from "./useElementWindow";

interface Props {
  dieId: string;
  /** Live net (re-rendered as annotations change). */
  net: AnnotationNet;
  /** World point the window is anchored to. */
  anchor: { x: number; y: number };
  viewportStore: LiveValue<Viewport | null>;
  /** True if another net already uses `name`. */
  nameTaken: (name: string) => boolean;
  /** The net's current color (its override, or the global net color). */
  color: string;
  /** True when the net has its own color override. */
  hasOverride: boolean;
  /** Global net color (what "default" resets to). */
  defaultColor: string;
  /** Per-net colors render on the canvas (Settings toggle). */
  customColorsEnabled: boolean;
  /** Persist the new name (undoable) and color (`null` = back to default,
   *  `undefined` = unchanged); resolves false if rejected. */
  onSave: (name: string, color: string | null | undefined) => Promise<boolean>;
  onClose: () => void;
}

export function NetRenamePopover({
  dieId,
  net,
  anchor,
  viewportStore,
  nameTaken,
  color,
  hasOverride,
  defaultColor,
  customColorsEnabled,
  onSave,
  onClose
}: Props) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const { windowProps } = useElementWindow({
    anchorKey: windowAnchorKey(dieId, "net", net.id),
    points: netAnchorPoints(net),
    fallback: { ...anchor, dx: 12, dy: 12 },
    viewportStore
  });
  const [name, setName] = useState(net.name);
  const [saving, setSaving] = useState(false);
  // Picked color draft: undefined = untouched, null = reset to default.
  const [colorDraft, setColorDraft] = useState<string | null | undefined>(undefined);

  // Another net opened in the same window → start over with its name.
  useEffect(() => {
    setName(net.name);
    setColorDraft(undefined);
  }, [net.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const trimmed = name.trim();
  const nameUnchanged = trimmed === net.name;
  const duplicate = !!trimmed && !nameUnchanged && nameTaken(trimmed);
  const colorChanged = colorDraft !== undefined && (colorDraft === null ? hasOverride : colorDraft !== color);
  const shownColor = colorDraft === undefined ? color : colorDraft ?? defaultColor;

  const handleSave = useCallback(async () => {
    if (!trimmed || saving) return;
    if (nameUnchanged && !colorChanged) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      if (await onSave(trimmed, colorChanged ? colorDraft : undefined)) onClose();
    } finally {
      setSaving(false);
    }
  }, [trimmed, saving, nameUnchanged, colorChanged, colorDraft, onSave, onClose]);

  // Click outside → close (same as the floorplan popover).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  const popW = 260;

  return (
    <div
      {...windowProps}
      ref={(el) => {
        popoverRef.current = el;
        windowProps.ref.current = el;
      }}
      style={{
        ...windowProps.style,
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
      <label style={{ display: "block", marginBottom: 10 }}>
        <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 2, display: "block" }}>
          Net name
        </span>
        <input
          className="input"
          value={name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSave();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
          placeholder="e.g. VDD"
          style={{ width: "100%", boxSizing: "border-box" }}
        />
      </label>

      <div style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 4, display: "block" }}>
          Color
        </span>
        <NetColorPickerBody currentColor={shownColor} onPick={setColorDraft} />
        {!customColorsEnabled && (
          <div style={{ fontSize: 10, color: "#888", marginTop: 6 }}>
            Custom net colors are turned off in the net settings, so the canvas shows layer colors.
          </div>
        )}
      </div>

      {duplicate && (
        <div
          style={{
            background: "#3a3100",
            border: "1px solid #665500",
            borderRadius: 6,
            padding: "6px 10px",
            marginBottom: 10,
            fontSize: 11,
            color: "#ffd43b",
            maxWidth: popW,
          }}
        >
          Another net is already named "{trimmed}". Netlists and exports identify nets by name, so the two may be
          treated as one.
        </div>
      )}

      <span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button className="btn sm plain" onClick={onClose}>
          Close
        </button>
        <button className="btn sm accent" onClick={() => void handleSave()} disabled={saving || !trimmed}>
          {saving ? "Saving…" : duplicate ? "Save anyway" : "Save"}
        </button>
      </span>
    </div>
  );
}
