/**
 * Typed hover entity that drives "what is the user currently pointing at?"
 * across the cellRE page. One entity is in flight at a time; every consumer
 * (image canvas dim+halo, right-panel row highlight, schematic narrow
 * highlight) resolves the entity into its own concrete representation.
 *
 * Why a typed entity instead of a `Set<shapeKey>`?
 *   Earlier we routed hovers as the union of shape keys touched by the
 *   thing (a net's wires, a transistor's S/D pads, …). The right panel +
 *   image canvas folded sub-region ids to their parent diffusion id, and
 *   because a parent diffusion can host sub-regions belonging to *different*
 *   nets, two unrelated nets ended up sharing a shape-key — hovering one
 *   net would light up every other net row sharing a diffusion. With the
 *   typed entity each row matches only its own entity (plus narrow related
 *   entities per `rowMatchesEntity` below).
 */

import type { LayerType } from "shared";
import type { CellExtraction, ExtractedShape } from "../../lib/extraction";
import { shapeKey } from "../../state/cellRE";

export type HoverEntity =
  | { kind: "net"; netId: number }
  | { kind: "transistor"; transistorId: string }
  | { kind: "diffusion"; diffusionShapeId: string }
  | { kind: "domain"; domainId: string }
  | { kind: "tg"; tgId: string }
  | { kind: "warning"; shapeIds: ReadonlyArray<string> }
  | null;

/** Subset of `CanvasHoverTarget` we actually use here — kept inline so this
 *  module doesn't depend on the canvas component. */
interface CanvasHoverLite {
  layer: LayerType;
  shape: { id: string };
  subRegionId?: string;
}

/**
 * Resolve a hover entity to the user-drawn shape keys (`layer:id`) that
 * should be highlighted on the image canvas. Sub-region ids fold to their
 * parent diffusion (sub-regions aren't user-drawn shapes — they're a
 * post-pass concept from the extraction). The image canvas uses this set
 * both to dim everything else and to outline the highlighted shapes at
 * full alpha.
 *
 * Returns an empty set for `null` / non-inferred extractions.
 */
export function entityToImageShapeKeys(
  entity: HoverEntity,
  extraction: CellExtraction | null,
): Set<string> {
  if (!entity || !extraction || extraction.kind !== "inferred") {
    return new Set();
  }
  const shapeById = new Map(extraction.shapes.map((s) => [s.id, s]));
  const out = new Set<string>();
  const addShape = (s: ExtractedShape) => {
    if (s.parentDiffId) {
      out.add(shapeKey("diffusion" as LayerType, s.parentDiffId));
    } else {
      out.add(shapeKey(s.layer, s.id));
    }
  };
  const addTransistorShapes = (transistorId: string) => {
    const t = extraction.transistors.find((x) => x.id === transistorId);
    if (!t) return;
    for (const sid of [t.gate.shapeId, t.source.shapeId, t.drain.shapeId]) {
      const s = shapeById.get(sid);
      if (s) addShape(s);
    }
  };

  switch (entity.kind) {
    case "net": {
      const net = extraction.nets.find((n) => n.id === entity.netId);
      if (!net) return out;
      for (const sid of net.shapeIds) {
        const s = shapeById.get(sid);
        if (s) addShape(s);
      }
      return out;
    }
    case "transistor": {
      addTransistorShapes(entity.transistorId);
      return out;
    }
    case "diffusion": {
      out.add(shapeKey("diffusion" as LayerType, entity.diffusionShapeId));
      return out;
    }
    case "domain": {
      const d = extraction.domains.find((x) => x.id === entity.domainId);
      if (!d) return out;
      for (const id of [...d.pmosTransistorIds, ...d.nmosTransistorIds]) {
        addTransistorShapes(id);
      }
      return out;
    }
    case "tg": {
      const tg = extraction.transmissionGates.find((x) => x.id === entity.tgId);
      if (!tg) return out;
      addTransistorShapes(tg.pmosTransistorId);
      addTransistorShapes(tg.nmosTransistorId);
      return out;
    }
    case "warning": {
      // Warning shape ids may point at either extraction shapes (we fold via
      // parentDiffId then) or raw user-drawn shapes the extractor flagged
      // without going through `shapes` (e.g. the cellType layers directly).
      // For the latter we can't recover a layer here — those callers must
      // already have a layer-prefixed key. Skip them quietly.
      for (const sid of entity.shapeIds) {
        const s = shapeById.get(sid);
        if (s) addShape(s);
      }
      return out;
    }
  }
}

/**
 * Per-row "should I be highlighted?" check. Each row passes its own typed
 * entity (e.g. a NetRow passes `{kind:"net", netId: ...}`); we return true
 * when the hover entity matches that row OR is a closely related entity:
 *
 *  - hover net N: matches only "net N" — net is the narrowest entity, no
 *    transitive spread. Avoids the original over-highlight where hovering
 *    one net lit up every other net that touched the same diffusion.
 *  - hover transistor T: matches "transistor T", T's g/s/d nets,
 *    T's source/drain parent diffusions, the domain that contains T,
 *    the TG that contains T (if any). (Hovering a transistor is a "show
 *    me what it's connected to" gesture, so the relations help.)
 *  - hover diffusion D: matches only "diffusion D".
 *  - hover domain DD: matches "domain DD" + transistors in DD.
 *  - hover tg TG: matches "tg TG" + transistors in TG.
 *  - hover warning W: matches by shape-key overlap — warnings carry a
 *    set of offending shapes, so any row whose own shapes intersect the
 *    warning's set highlights. Folded to parent diffusion keys to be
 *    comparable with `selectionKeys`.
 *
 *  Symmetric note: the "related" mapping is intentionally one-way (hover
 *  transistor → highlight related nets; hover net does NOT highlight
 *  transistors). The user wants nets to be a sharp pinpoint while
 *  transistors get a richer "what it's wired to" view.
 */
export function rowMatchesEntity(
  rowEntity: HoverEntity,
  hover: HoverEntity,
  extraction: CellExtraction | null,
): boolean {
  if (!rowEntity || !hover) return false;
  if (!extraction || extraction.kind !== "inferred") return false;

  // Same-kind matches — direct id equality.
  if (rowEntity.kind === hover.kind) {
    switch (hover.kind) {
      case "net":
        return rowEntity.kind === "net" && rowEntity.netId === hover.netId;
      case "transistor":
        return (
          rowEntity.kind === "transistor" &&
          rowEntity.transistorId === hover.transistorId
        );
      case "diffusion":
        return (
          rowEntity.kind === "diffusion" &&
          rowEntity.diffusionShapeId === hover.diffusionShapeId
        );
      case "domain":
        return (
          rowEntity.kind === "domain" && rowEntity.domainId === hover.domainId
        );
      case "tg":
        return rowEntity.kind === "tg" && rowEntity.tgId === hover.tgId;
      case "warning":
        // Warnings don't carry an id we can compare; treat each as distinct
        // (the row's own onMouseEnter is the only source of warning hover).
        return false;
    }
  }

  // Related-row spread from hovering a net — light up the diffusion rows
  // whose sub-regions belong to that net. This is the inverse of "hover
  // diffusion → its sub-regions' nets" and stays narrow (a net usually
  // touches at most 1-2 diffusions), so it doesn't re-introduce the
  // cross-net bleed the typed hover was designed to fix.
  if (hover.kind === "net") {
    if (rowEntity.kind === "diffusion") {
      for (const s of extraction.shapes) {
        if (!s.parentDiffId) continue;
        if (s.parentDiffId !== rowEntity.diffusionShapeId) continue;
        if (s.netId === hover.netId) return true;
      }
      return false;
    }
    return false;
  }

  // Related-row spread from hovering a transistor — light up its g/s/d
  // nets, the diffusions that own its source/drain pads, and the
  // domain / TG it belongs to.
  if (hover.kind === "transistor") {
    const t = extraction.transistors.find((x) => x.id === hover.transistorId);
    if (!t) return false;
    if (rowEntity.kind === "net") {
      return (
        rowEntity.netId === t.gate.netId ||
        rowEntity.netId === t.source.netId ||
        rowEntity.netId === t.drain.netId
      );
    }
    if (rowEntity.kind === "diffusion") {
      const shapeById = new Map(extraction.shapes.map((s) => [s.id, s]));
      const sShape = shapeById.get(t.source.shapeId);
      const dShape = shapeById.get(t.drain.shapeId);
      const sParent = sShape?.parentDiffId ?? sShape?.id;
      const dParent = dShape?.parentDiffId ?? dShape?.id;
      return (
        rowEntity.diffusionShapeId === sParent ||
        rowEntity.diffusionShapeId === dParent
      );
    }
    if (rowEntity.kind === "domain") {
      const d = extraction.domains.find((x) => x.id === rowEntity.domainId);
      if (!d) return false;
      return (
        d.pmosTransistorIds.includes(t.id) ||
        d.nmosTransistorIds.includes(t.id)
      );
    }
    if (rowEntity.kind === "tg") {
      const tg = extraction.transmissionGates.find(
        (x) => x.id === rowEntity.tgId,
      );
      if (!tg) return false;
      return tg.pmosTransistorId === t.id || tg.nmosTransistorId === t.id;
    }
    return false;
  }

  // Related-row spread from hovering a domain — light up its transistors.
  if (hover.kind === "domain") {
    if (rowEntity.kind !== "transistor") return false;
    const d = extraction.domains.find((x) => x.id === hover.domainId);
    if (!d) return false;
    return (
      d.pmosTransistorIds.includes(rowEntity.transistorId) ||
      d.nmosTransistorIds.includes(rowEntity.transistorId)
    );
  }

  // Related-row spread from hovering a TG — light up its transistors.
  if (hover.kind === "tg") {
    if (rowEntity.kind !== "transistor") return false;
    const tg = extraction.transmissionGates.find((x) => x.id === hover.tgId);
    if (!tg) return false;
    return (
      tg.pmosTransistorId === rowEntity.transistorId ||
      tg.nmosTransistorId === rowEntity.transistorId
    );
  }

  return false;
}

/**
 * Resolve a cursor-over-shape canvas hover into a HoverEntity so the
 * right panel + schematic light up the matching row / element.
 *
 * For diffusion: prefers the specific sub-region's net (more precise S/D
 * pad highlight) when the cursor lands inside a sub-region; falls back to
 * the diffusion entity when the cursor is on the diffusion body outside
 * any sub-region (rare — usually the body IS one of the sub-regions).
 */
export function canvasHoverToEntity(
  hover: CanvasHoverLite | null,
  extraction: CellExtraction | null,
): HoverEntity {
  if (!hover) return null;
  if (!extraction || extraction.kind !== "inferred") return null;
  if (hover.layer === "diffusion") {
    if (hover.subRegionId) {
      const sub = extraction.shapes.find((s) => s.id === hover.subRegionId);
      if (sub) return { kind: "net", netId: sub.netId };
    }
    return { kind: "diffusion", diffusionShapeId: hover.shape.id };
  }
  const shape = extraction.shapes.find(
    (s) => s.layer === hover.layer && s.id === hover.shape.id,
  );
  if (shape) return { kind: "net", netId: shape.netId };
  return null;
}
