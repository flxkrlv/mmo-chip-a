import type { DieAnnotations } from "shared";
import { InputError } from "./result.js";
import { cellRect, type Rect } from "./footprint.js";

/** Kinds the summary indexes; the rest are full-mode only. */
export const SUMMARY_KINDS = [
  "nets",
  "cells",
  "cellTypes",
  "grids",
  "pins",
  "rulers",
  "comments",
  "floorplan",
  "annotations",
  "rois",
  "ignores",
  "guides"
] as const;

/** Everything get_annotations can hand back per kind. */
export const ALL_KINDS = [
  ...SUMMARY_KINDS,
  "mlConfig",
  "analogLayers",
  "icPackage"
] as const;

export type SummaryKind = (typeof SUMMARY_KINDS)[number];
export type AnyKind = (typeof ALL_KINDS)[number];

export const DEFAULT_LIMIT = 500;
export const MAX_FULL_BYTES = 4_000_000;

export interface SummaryOptions {
  /** Restrict which indexes appear; counts always cover every summary kind. */
  kinds?: readonly string[];
  limit?: number;
}

export function isAnyKind(value: string): value is AnyKind {
  return (ALL_KINDS as readonly string[]).includes(value);
}

export function parseKinds(
  kinds: readonly string[] | undefined,
  allowed: readonly string[]
): AnyKind[] {
  if (!kinds || kinds.length === 0) {
    throw new InputError(
      `kinds is required here: pass one or more of ${allowed.join(", ")}`
    );
  }
  const invalid = kinds.filter((kind) => !(allowed as readonly string[]).includes(kind));
  if (invalid.length > 0) {
    throw new InputError(
      `Unknown kind(s): ${invalid.join(", ")}. Valid kinds: ${allowed.join(", ")}`
    );
  }
  return kinds as AnyKind[];
}

export function countOf(annotations: DieAnnotations, kind: AnyKind): number {
  switch (kind) {
    case "nets":
      return annotations.nets.length;
    case "cells":
      return annotations.cells.length;
    case "cellTypes":
      return annotations.cellTypes.length;
    case "grids":
      return annotations.grids.length;
    case "pins":
      return annotations.pins?.length ?? 0;
    case "rulers":
      return annotations.rulers?.length ?? 0;
    case "comments":
      return annotations.comments?.length ?? 0;
    case "floorplan":
      return annotations.floorplanRegions?.length ?? 0;
    case "annotations":
      return annotations.annotations?.length ?? 0;
    case "rois":
      return annotations.rois?.length ?? 0;
    case "ignores":
      return annotations.ignores?.length ?? 0;
    case "guides":
      return annotations.guides?.length ?? 0;
    default:
      return 1;
  }
}

/**
 * Read back with `mode: "summary"`: identity + revision + per-kind counts,
 * and a truncated index (default 500 rows per kind) that is cheap enough to
 * read before every write.
 */
export function buildSummary(
  annotations: DieAnnotations,
  options: SummaryOptions,
  boxes: Map<string, Rect> = new Map()
): Record<string, unknown> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const selected = options.kinds
    ? parseKinds(options.kinds, SUMMARY_KINDS)
    : (SUMMARY_KINDS as readonly AnyKind[]);
  const out: Record<string, unknown> = {
    version: annotations.version,
    rev: annotations.rev,
    umPerPx: annotations.umPerPx ?? null,
    counts: {} as Record<string, number>,
    limited: limit
  };
  const counts = out.counts as Record<string, number>;
  const truncated: Record<string, number> = {};
  const wanted = (kind: AnyKind): boolean => selected.includes(kind);
  const add = (kind: AnyKind, rows: unknown[]): void => {
    if (!wanted(kind)) return;
    out[kind] = rows.slice(0, limit);
    if (rows.length > limit) truncated[kind] = rows.length;
  };

  for (const kind of SUMMARY_KINDS) counts[kind] = countOf(annotations, kind);

  add(
    "nets",
    annotations.nets.map((net) => ({
      id: net.id,
      name: net.name,
      nodeCount: net.nodes.length,
      edgeCount: net.edges.length
    }))
  );

  add(
    "cells",
    annotations.cells.map((cell) => {
      const rect = cellRect(cell, boxes);
      return {
        id: cell.id,
        cellTypeId: cell.cellTypeId,
        ...(cell.cellTypeDieId ? { cellTypeDieId: cell.cellTypeDieId } : {}),
        x: cell.x,
        y: cell.y,
        ...(cell.rotation ? { rotation: cell.rotation } : {}),
        ...(cell.flippedH ? { flippedH: true } : {}),
        ...(cell.flippedV ? { flippedV: true } : {}),
        ...(rect ? { rect } : {})
      };
    })
  );

  add(
    "cellTypes",
    annotations.cellTypes.map((type) => ({
      id: type.id,
      name: type.name,
      w: type.cropRect.width,
      h: type.cropRect.height,
      ...(type.matched === undefined ? {} : { matched: type.matched })
    }))
  );

  add(
    "grids",
    annotations.grids.map((grid) => ({
      id: grid.id,
      name: grid.name,
      columnCount: grid.columns.length,
      rowHeight: grid.rowHeight
    }))
  );

  add(
    "pins",
    (annotations.pins ?? []).map((pin) => ({
      id: pin.id,
      name: pin.name,
      pin: pin.pin,
      x: pin.x,
      y: pin.y
    }))
  );

  add(
    "rulers",
    (annotations.rulers ?? []).map((ruler) => ({ ...ruler }))
  );

  add(
    "comments",
    (annotations.comments ?? []).map((comment) => ({
      id: comment.id,
      x: comment.x,
      y: comment.y,
      text: comment.text.length > 160 ? `${comment.text.slice(0, 157)}...` : comment.text,
      authorName: comment.authorName,
      replyCount: comment.replies?.length ?? 0,
      createdAt: comment.createdAt
    }))
  );

  add(
    "floorplan",
    (annotations.floorplanRegions ?? []).map((region) => ({
      id: region.id,
      name: region.name,
      kind: region.kind,
      color: region.color,
      points: region.geometry.length
    }))
  );

  add(
    "annotations",
    (annotations.annotations ?? []).map((item) => ({
      id: item.id,
      class: item.class,
      geometryKind: item.geometry.kind,
      ...(item.layer ? { layer: item.layer } : {})
    }))
  );

  add(
    "rois",
    (annotations.rois ?? []).map((roi) => ({
      id: roi.id,
      x: roi.x,
      y: roi.y,
      width: roi.width,
      height: roi.height
    }))
  );

  add(
    "ignores",
    (annotations.ignores ?? []).map((ignore) => ({ ...ignore }))
  );

  add(
    "guides",
    (annotations.guides ?? []).map((guide) => ({ ...guide }))
  );

  if (Object.keys(truncated).length > 0) {
    out.truncated = truncated;
    out.limitHint = `raise limit (max 5000) or use mode:"full" with kinds to read the rest`;
  }
  return out;
}

/** The raw collections of `kinds`, for `mode: "full"`. */
export function pickKinds(
  annotations: DieAnnotations,
  kinds: readonly AnyKind[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kind of kinds) {
    switch (kind) {
      case "nets":
        out.nets = annotations.nets;
        break;
      case "cells":
        out.cells = annotations.cells;
        break;
      case "cellTypes":
        out.cellTypes = annotations.cellTypes;
        break;
      case "grids":
        out.grids = annotations.grids;
        break;
      case "pins":
        out.pins = annotations.pins ?? [];
        break;
      case "rulers":
        out.rulers = annotations.rulers ?? [];
        break;
      case "comments":
        out.comments = annotations.comments ?? [];
        break;
      case "floorplan":
        out.floorplan = annotations.floorplanRegions ?? [];
        break;
      case "annotations":
        out.annotations = annotations.annotations ?? [];
        break;
      case "rois":
        out.rois = annotations.rois ?? [];
        break;
      case "ignores":
        out.ignores = annotations.ignores ?? [];
        break;
      case "guides":
        out.guides = annotations.guides ?? [];
        break;
      case "mlConfig":
        out.mlConfig = annotations.mlConfig ?? null;
        break;
      case "analogLayers":
        out.analogLayers = annotations.analogLayers ?? {};
        break;
      case "icPackage":
        out.icPackage = annotations.icPackage ?? null;
        break;
    }
  }
  return out;
}

export function assertSize(payload: unknown, label: string): void {
  const size = JSON.stringify(payload).length;
  if (size > MAX_FULL_BYTES) {
    throw new InputError(
      `${label} serialises to ${size} bytes, over the ${MAX_FULL_BYTES} byte cap. ` +
        `Narrow the response: pass fewer kinds, or a smaller limit.`
    );
  }
}
