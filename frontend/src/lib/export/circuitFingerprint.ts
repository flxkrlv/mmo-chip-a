import type { AnalogDevice } from "shared";

/**
 * A stable fingerprint of the analog circuit's connectivity: instances,
 * terminals and named nets, independent of the output dialect and of
 * calculated values (W/L, ohms, fF). Values depend on preferences that load
 * asynchronously and do not change the RNL drawing, so including them made
 * the saved drawing look stale right after a reload. A rename, a moved
 * terminal or a new device does change the hash.
 */

/** 32-bit FNV-1a, rendered as eight hex digits. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function circuitFingerprint(
  devices: AnalogDevice[],
  namedNets: Map<number, string> | Record<string, number> | undefined,
): string {
  const rows = devices.map((device) => {
    const terminals = [...device.terminals]
      .map((terminal) => `${terminal.name}:${terminal.netId}`)
      .sort()
      .join(",");
    return [device.instanceName ?? device.id, device.kind, terminals].join("|");
  });
  rows.sort();
  const nets =
    namedNets instanceof Map
      ? [...namedNets.entries()]
          .sort(([left], [right]) => left - right)
          .map(([id, name]) => `${id}:${name}`)
      : Object.entries(namedNets ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, id]) => `${name}:${id}`);
  return fnv1a([...rows, "nets", ...nets].join("\n"));
}
