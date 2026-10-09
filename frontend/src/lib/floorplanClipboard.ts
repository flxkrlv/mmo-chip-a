import type { FloorplanRegion } from "shared";
import type { AnnotationAction } from "../api/actions";
import { uuid } from "./uuid";

/**
 * Floorplan regions in the copy / paste clipboard. A pasted region keeps its
 * shape, name and color but gets a fresh id, the paster as creator and no
 * reservation. Port aliases are dropped: they are keyed by the nets inside
 * the original outline, which the copy no longer covers.
 */
export interface FloorplanClip {
  kind: FloorplanRegion["kind"];
  name: string;
  color: string;
  /** Geometry relative to the copy origin. */
  points: { x: number; y: number }[];
}

/** Regions selected as `floorplan:<id>`. */
export function selectedFloorplans(
  regions: readonly FloorplanRegion[] | undefined,
  selected: ReadonlySet<string>
): FloorplanRegion[] {
  return (regions ?? []).filter((r) => selected.has(`floorplan:${r.id}`));
}

/** Top-left of the regions' geometry, or null when there are none. */
export function floorplanBounds(regions: readonly FloorplanRegion[]): { minX: number; minY: number } | null {
  const pts = regions.flatMap((r) => r.geometry);
  if (pts.length === 0) return null;
  return { minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)) };
}

/** Clipboard entries for `regions`, relative to the copy origin. */
export function floorplanClips(regions: readonly FloorplanRegion[], originX: number, originY: number): FloorplanClip[] {
  return regions.map((r) => ({
    kind: r.kind,
    name: r.name,
    color: r.color,
    points: r.geometry.map((p) => ({ x: p.x - originX, y: p.y - originY }))
  }));
}

/** New regions (fresh ids) at `base` + each clip's geometry. */
export function pasteFloorplanActions(
  clips: readonly FloorplanClip[],
  base: { x: number; y: number },
  author: { userId: string | null; username: string | null },
  now = new Date().toISOString()
): AnnotationAction[] {
  return clips.map((c) => ({
    kind: "upsertFloorplan" as const,
    region: {
      id: uuid(),
      name: c.name,
      kind: c.kind,
      geometry: c.points.map((p) => ({ x: Math.round(base.x + p.x), y: Math.round(base.y + p.y) })),
      color: c.color,
      createdBy: author.userId,
      createdByName: author.username,
      createdAt: now,
      reservedBy: null,
      reservedByName: null,
      reservedAt: null
    },
    prevRegion: null
  }));
}
