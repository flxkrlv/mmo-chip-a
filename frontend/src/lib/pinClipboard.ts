import type { IOPin } from "shared";
import type { AnnotationAction } from "../api/actions";
import { uuid } from "./uuid";

/**
 * I/O pads in the copy / paste clipboard. A pasted pad keeps its pin number
 * and name but gets its own id and place: several pads may share one package
 * pin (e.g. two VDD pads bonded to the same pin). Pads sharing a number are
 * one external pin, so their names are kept in sync (`renamePinActions`) —
 * the netlisters merge same-named pad nets into one port / node.
 */
export interface PinClip {
  pin: number;
  name: string;
  offsetX: number;
  offsetY: number;
}

/** Pads selected as `pin:<id>`. */
export function selectedPins(pins: readonly IOPin[] | undefined, selected: ReadonlySet<string>): IOPin[] {
  return (pins ?? []).filter((p) => selected.has(`pin:${p.id}`));
}

/** Clipboard entries for `pins`, relative to the copy origin. */
export function pinClips(pins: readonly IOPin[], originX: number, originY: number): PinClip[] {
  return pins.map((p) => ({ pin: p.pin, name: p.name, offsetX: p.x - originX, offsetY: p.y - originY }));
}

/** New pads (fresh ids, same number + name) at `base` + each offset. */
export function pastePinActions(clips: readonly PinClip[], base: { x: number; y: number }): AnnotationAction[] {
  return clips.map((c) => ({
    kind: "addPin" as const,
    pin: {
      id: uuid(),
      x: Math.round(base.x + c.offsetX),
      y: Math.round(base.y + c.offsetY),
      pin: c.pin,
      name: c.name
    }
  }));
}

/** Rename every pad of pin `pinNumber` (the copies stay one pin). */
export function renamePinActions(
  pins: readonly IOPin[] | undefined,
  pinNumber: number,
  name: string
): AnnotationAction[] {
  return (pins ?? [])
    .filter((p) => p.pin === pinNumber && p.name !== name)
    .map((p) => ({ kind: "upsertPin" as const, pin: { ...p, name }, prevPin: p }));
}

/** How many pads share each pin number. */
export function padCountByPin(pins: readonly IOPin[] | undefined): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of pins ?? []) out.set(p.pin, (out.get(p.pin) ?? 0) + 1);
  return out;
}
