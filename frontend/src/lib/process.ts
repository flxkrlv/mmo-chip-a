import {
  flipProcessConfig,
  planProcessFlip,
  type DieAnnotations,
  type ProcessConfig,
  type ProcessGroup
} from "shared";
import type { AnnotationAction } from "../api/actions";

/**
 * The polarity flip toggle as ONE undoable action: the process config flips
 * (substrate always; other layer groups unless unlinked) and every wire
 * segment, via (CT_ / TAP_) and floorplan layer tag on a linked layer is
 * relabelled to its opposite-polarity twin. Unlinked groups keep their data.
 */
export function buildFlipAction(annotations: DieAnnotations): AnnotationAction | null {
  const plan = planProcessFlip(annotations);
  if (!plan || !annotations.process) return null;
  const actions: AnnotationAction[] = [
    { kind: "setProcess", process: plan.process, prevProcess: annotations.process },
    ...plan.nets.map(({ prev, next }): AnnotationAction => ({ kind: "upsertNet", net: next, prevNet: prev })),
    ...plan.vias.map(({ prev, next }): AnnotationAction => ({ kind: "upsertAnnotation", annotation: next, prevAnnotation: prev })),
    ...plan.floorplans.map(({ prev, next }): AnnotationAction => ({ kind: "upsertFloorplan", region: next, prevRegion: prev }))
  ];
  return { kind: "batch", actions };
}

/** Toggle a group's link to the flip toggle. */
export function toggleGroupLink(process: ProcessConfig, group: ProcessGroup): ProcessConfig {
  const unlinked = new Set(process.unlinked ?? []);
  if (unlinked.has(group)) unlinked.delete(group);
  else unlinked.add(group);
  return { ...process, unlinked: [...unlinked] };
}

export { flipProcessConfig };
