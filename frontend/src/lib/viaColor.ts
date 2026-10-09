/**
 * viaColor.ts — per-via color overrides (HumanAnnotation.color) for placed
 * via annotations (point_via / irregular_via). Shared by the canvas
 * double-click window (ViaColorPopover) and the Inspector, so both pick the
 * same targets and produce the same undoable batch.
 *
 * Shown color = the via's own color, else its via layer color (per-user
 * override, then the metal stack), else the global via color.
 */

import type { DieAnnotations, HumanAnnotation, ViaLevel } from "shared";
import type { AnnotationAction } from "../api/actions";

export const isViaAnnotation = (a: HumanAnnotation): boolean =>
  a.class === "point_via" || a.class === "irregular_via";

/** Placed via annotation behind a selection id (`anno:<id>`), or null. */
export function viaFromSelectionId(ann: DieAnnotations, id: string): HumanAnnotation | null {
  if (!id.startsWith("anno:")) return null;
  const a = ann.annotations?.find((x) => x.id === id.slice(5));
  return a && isViaAnnotation(a) ? a : null;
}

/** Placed via annotations among the selection ids (ML vias, nets… skipped). */
export function selectedVias(ann: DieAnnotations, ids: Iterable<string>): HumanAnnotation[] {
  const out: HumanAnnotation[] = [];
  for (const id of ids) {
    const a = viaFromSelectionId(ann, id);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Selection ids a color change on `clickedId` applies to: every placed via
 * in the selection when the clicked via is part of it, else just that via.
 */
export function viaColorTargets(
  ann: DieAnnotations,
  selectedIds: ReadonlySet<string>,
  clickedId: string
): string[] {
  if (!viaFromSelectionId(ann, clickedId)) return [];
  if (!selectedIds.has(clickedId)) return [clickedId];
  return selectedVias(ann, selectedIds).map((a) => `anno:${a.id}`);
}

/** Color a via shows without its own override. */
export function viaBaseColor(
  a: HumanAnnotation,
  viaLayerColors: Record<string, string>,
  stackVias: ViaLevel[],
  globalViaColor: string
): string {
  if (a.layer) {
    const layerColor = viaLayerColors[a.layer] ?? stackVias.find((v) => v.id === a.layer)?.color;
    if (layerColor) return layerColor;
  }
  return globalViaColor;
}

/**
 * Actions setting `color` on every via (`null` removes the override). Vias
 * already showing that state are skipped; wrap in a batch for one undo step.
 */
export function viaColorActions(vias: HumanAnnotation[], color: string | null): AnnotationAction[] {
  const actions: AnnotationAction[] = [];
  for (const a of vias) {
    if ((a.color ?? null) === color) continue;
    let next: HumanAnnotation;
    if (color === null) {
      const { color: _drop, ...rest } = a;
      next = rest;
    } else {
      next = { ...a, color };
    }
    actions.push({ kind: "upsertAnnotation", annotation: next, prevAnnotation: a });
  }
  return actions;
}

/** One action for `viaColorActions` (single or batch), or null if nothing changes. */
export function viaColorAction(vias: HumanAnnotation[], color: string | null): AnnotationAction | null {
  const actions = viaColorActions(vias, color);
  if (actions.length === 0) return null;
  return actions.length === 1 ? actions[0] : { kind: "batch", actions };
}
