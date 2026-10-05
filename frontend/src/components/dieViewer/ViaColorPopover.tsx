/**
 * ViaColorPopover.tsx — Non-modal window for recoloring placed vias, styled
 * like FloorplanRegionPopover / NetRenamePopover. Opens on a double-click on a
 * via (select tool) beside the click, or where it was last dragged to
 * (re-anchored to the clicked via — see useElementWindow), and follows
 * pan / zoom.
 *
 * Applies to every placed via in the selection when the double-clicked via is
 * part of it (lib/viaColor.viaColorTargets), else to that via. The color is a
 * draft applied on Save as one undoable step; "default" removes the per-via
 * override (back to the via layer / global via color).
 *
 * Enter saves, Escape / Close / clicking outside closes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { HumanAnnotation } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import { viaAnchorPoints, windowAnchorKey } from "../../lib/windowAnchor";
import type { Viewport } from "../../renderer/types";
import { NetColorPickerBody } from "./NetColorPickerBody";
import { useElementWindow } from "./useElementWindow";

interface Props {
  dieId: string;
  /** The double-clicked via (live) — the window anchors to it. */
  via: HumanAnnotation;
  /** Every via the color applies to (live), incl. `via`. */
  targets: HumanAnnotation[];
  /** World point of the double-click. */
  anchor: { x: number; y: number };
  viewportStore: LiveValue<Viewport | null>;
  /** Color a via shows without its own override. */
  baseColorOf: (via: HumanAnnotation) => string;
  /** Persist (`null` = remove the overrides); resolves false if rejected. */
  onSave: (color: string | null) => Promise<boolean>;
  onClose: () => void;
}

export function ViaColorPopover({ dieId, via, targets, anchor, viewportStore, baseColorOf, onSave, onClose }: Props) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const { points, sig } = viaAnchorPoints(via);
  const { windowProps } = useElementWindow({
    anchorKey: windowAnchorKey(dieId, "via", via.id),
    points,
    sig,
    fallback: { ...anchor, dx: 12, dy: 12 },
    viewportStore
  });
  const [saving, setSaving] = useState(false);
  // Picked color draft: undefined = untouched, null = back to default.
  const [colorDraft, setColorDraft] = useState<string | null | undefined>(undefined);

  // Another via opened in the same window → start over.
  const targetKey = targets.map((t) => t.id).join(",");
  useEffect(() => setColorDraft(undefined), [via.id, targetKey]);

  const shown = targets.map((t) => t.color ?? baseColorOf(t));
  const mixed = shown.some((c) => c !== shown[0]);
  const currentColor = colorDraft === undefined ? (mixed ? "" : shown[0] ?? "") : colorDraft ?? baseColorOf(via);
  const changed =
    colorDraft !== undefined &&
    targets.some((t) => (t.color ?? null) !== colorDraft);

  const handleSave = useCallback(async () => {
    if (saving) return;
    if (!changed || colorDraft === undefined) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      if (await onSave(colorDraft)) onClose();
    } finally {
      setSaving(false);
    }
  }, [saving, changed, colorDraft, onSave, onClose]);

  // Click outside → close; Enter → save, Escape → close (no input to focus).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !popoverRef.current?.contains(t)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void handleSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, handleSave]);

  const overridden = targets.filter((t) => t.color).length;

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
        minWidth: 220,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        color: "#ddd",
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 2 }}>
        {targets.length > 1 ? `${targets.length} vias` : via.layer ? `Via · ${via.layer}` : "Via"}
      </div>
      <div style={{ fontSize: 11, color: "#888", marginBottom: 10 }}>
        {mixed && colorDraft === undefined
          ? "Mixed colors"
          : overridden > 0
            ? targets.length > 1
              ? `${overridden} with their own color`
              : "Own color"
            : "Default color (via layer)"}
      </div>

      <div style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 4, display: "block" }}>
          Color
        </span>
        <NetColorPickerBody currentColor={currentColor} onPick={setColorDraft} />
      </div>

      <span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button className="btn sm plain" onClick={onClose}>
          Close
        </button>
        <button className="btn sm accent" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </span>
    </div>
  );
}
