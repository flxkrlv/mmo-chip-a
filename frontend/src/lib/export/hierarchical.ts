/**
 * hierarchical.ts — Shared utilities for hierarchical netlist generation.
 *
 * Extracted from spice.ts so that both the generator AND the floorplan
 * popover use exactly the same logic for:
 *   - point-in-polygon
 *   - device-in-region
 *   - boundary-net detection
 *   - port alias collision resolution
 *
 * This guarantees that what the user sees in the popover (ports) matches
 * what appears in the generated netlist.
 */

import type { AnalogDevice, FloorplanRegion } from "shared";

// ═════════════════════════════════════════════════════════════════
// Geometry helpers
// ═════════════════════════════════════════════════════════════════

/**
 * Point-in-polygon test (ray casting).
 */
export function pointInPoly(
  px: number,
  py: number,
  poly: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Compute the centre of a device bbox or outline.
 */
export function deviceCenter(d: AnalogDevice): { x: number; y: number } | null {
  if (d.bbox) {
    return {
      x: d.bbox.x + d.bbox.width / 2,
      y: d.bbox.y + d.bbox.height / 2,
    };
  }
  if (d.outline && d.outline.length > 0) {
    const cx = d.outline.reduce((s, p) => s + p.x, 0) / d.outline.length;
    const cy = d.outline.reduce((s, p) => s + p.y, 0) / d.outline.length;
    return { x: cx, y: cy };
  }
  return null;
}

/**
 * Build a polygon from a rect region (2 corner points → 4-vertex rect).
 */
export function regionToPolygon(
  region: FloorplanRegion,
): ReadonlyArray<{ x: number; y: number }> {
  if (region.kind === "rect" && region.geometry.length >= 2) {
    return [
      { x: Math.min(region.geometry[0].x, region.geometry[1].x), y: Math.min(region.geometry[0].y, region.geometry[1].y) },
      { x: Math.max(region.geometry[0].x, region.geometry[1].x), y: Math.min(region.geometry[0].y, region.geometry[1].y) },
      { x: Math.max(region.geometry[0].x, region.geometry[1].x), y: Math.max(region.geometry[0].y, region.geometry[1].y) },
      { x: Math.min(region.geometry[0].x, region.geometry[1].x), y: Math.max(region.geometry[0].y, region.geometry[1].y) },
    ];
  }
  return region.geometry;
}

/**
 * Check if the centre of a device falls inside a region polygon.
 */
export function deviceInRegion(
  d: AnalogDevice,
  region: FloorplanRegion,
): boolean {
  const center = deviceCenter(d);
  if (!center) return false;
  const poly = regionToPolygon(region);
  return pointInPoly(center.x, center.y, poly);
}

/**
 * Filter devices that fall inside a given region.
 */
export function devicesInRegion(
  devices: AnalogDevice[],
  region: FloorplanRegion,
): AnalogDevice[] {
  return devices.filter((d) => deviceInRegion(d, region));
}

// ═════════════════════════════════════════════════════════════════
// Boundary net detection
// ═════════════════════════════════════════════════════════════════

/**
 * Detect boundary nets for a set of devices inside a region.
 * A net is a boundary net if it connects to at least one device inside AND
 * at least one device outside the region.
 *
 * Uses instanceName for dedup (device.id may be duplicated across instances).
 *
 * @returns Set of netIds that are boundary nets for this region.
 */
export function detectBoundaryNets(
  insideDevices: AnalogDevice[],
  allDevices: AnalogDevice[],
): Set<number> {
  const insideNets = new Set<number>();
  const outsideNets = new Set<number>();

  const insideKeys = new Set(insideDevices.map((d) => d.instanceName ?? d.id));

  for (const d of allDevices) {
    for (const t of d.terminals) {
      if (t.netId >= 0) {
        if (insideKeys.has(d.instanceName ?? d.id)) {
          insideNets.add(t.netId);
        } else {
          outsideNets.add(t.netId);
        }
      }
    }
  }

  const boundary = new Set<number>();
  for (const n of insideNets) {
    if (outsideNets.has(n)) {
      boundary.add(n);
    }
  }
  return boundary;
}

/**
 * Get boundary net info for a single region, along with the inside devices.
 */
export function regionBoundaryInfo(
  region: FloorplanRegion,
  allDevices: AnalogDevice[],
): {
  insideDevices: AnalogDevice[];
  boundaryNets: Set<number>;
} {
  const insideDevices = devicesInRegion(allDevices, region);
  const boundaryNets = detectBoundaryNets(insideDevices, allDevices);
  return { insideDevices, boundaryNets };
}

// ═════════════════════════════════════════════════════════════════
// Port alias collision resolution
// ═════════════════════════════════════════════════════════════════

/**
 * Collect port aliases from all floorplan regions, resolve collisions,
 * and return a Map<netId, alias>.
 *
 * Collision rules:
 *   - Same name for two different netIds → auto-suffix (_1, _2, …)
 *   - Same netId aliased differently → last wins (warn logged)
 *
 * @returns {aliases, warnings} — the resolved alias map + any collision warnings
 */
export function resolveGlobalPortAliases(
  floorplanRegions: FloorplanRegion[] | undefined,
): { aliases: Map<number, string>; warnings: string[] } {
  const warnings: string[] = [];
  const netToAlias = new Map<number, string>(); // final alias per netId
  const aliasToNet = new Map<string, number>();  // reverse lookup for collision check

  if (!floorplanRegions) return { aliases: netToAlias, warnings };

  for (const region of floorplanRegions) {
    if (!region.portAliases) continue;
    for (const [netIdStr, alias] of Object.entries(region.portAliases)) {
      const netId = Number(netIdStr);
      if (isNaN(netId)) continue;
      if (!alias.trim()) continue;

      const cleanAlias = alias.trim().replace(/[^A-Za-z0-9_]/g, "_");
      if (!cleanAlias) continue;

      // Collision: same name already used for a different netId
      const existingNet = aliasToNet.get(cleanAlias);
      if (existingNet !== undefined && existingNet !== netId) {
        let suffix = 1;
        let deduped = `${cleanAlias}_${suffix}`;
        while (aliasToNet.has(deduped)) {
          suffix++;
          deduped = `${cleanAlias}_${suffix}`;
        }
        warnings.push(
          `Port alias "${cleanAlias}" used by net ${existingNet} and net ${netId}` +
          ` — renamed to "${deduped}" for net ${netId}`
        );
        aliasToNet.set(deduped, netId);
        netToAlias.set(netId, deduped);
        continue;
      }

      // Same netId already has a different alias — last wins
      const existingAlias = [...aliasToNet.entries()].find(([, n]) => n === netId);
      if (existingAlias && existingAlias[0] !== cleanAlias) {
        warnings.push(
          `Port alias for net ${netId} changed from "${existingAlias[0]}" to "${cleanAlias}"`
        );
        aliasToNet.delete(existingAlias[0]);
      }

      aliasToNet.set(cleanAlias, netId);
      netToAlias.set(netId, cleanAlias);
    }
  }

  return { aliases: netToAlias, warnings };
}
