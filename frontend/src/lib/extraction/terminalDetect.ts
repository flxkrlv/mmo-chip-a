/**
 * terminalDetect.ts — Auto-detect cell terminal positions for wire snapping.
 *
 * Instead of requiring the user to draw `wire_hitbox` on every cell type,
 * this module derives terminal positions directly from the cell type's
 * layer geometry:
 *
 *   A terminal = a `metal1` shape that overlaps a `contact` shape.
 *   (The contact proves the metal1 connects to diffusion/poly beneath.)
 *
 * These terminal positions are consumed by the die-viewer wire tool
 * (`useWireTool.ts`) so a drawn wire automatically snaps to the nearest
 * cell-instance terminal.
 */

import type { CellLayers, LayerShape, LayerType, Cell, CellType } from "shared";

// ── Exported types ───────────────────────────────────────────────

/** One discovered terminal on a cell instance, in die-world coordinates. */
export interface InstanceTerminal {
  /** Instance id + port name — unique across the die. */
  id: string;
  /** Die-world X position (terminal center). */
  worldX: number;
  /** Die-world Y position (terminal center). */
  worldY: number;
  /** Cell instance this terminal belongs to. */
  cell: Cell;
  /** Cell type this terminal belongs to. */
  cellType: CellType;
  /** Human-readable port name, e.g. "VDD", "GND", "port_0". */
  portName: string;
  /** The metal1 shape that defines this terminal (for hit-testing). */
  shape: LayerShape;
}

// ── Helpers ──────────────────────────────────────────────────────

type SimpleRect = { x: number; y: number; width: number; height: number };

function shapeBounds(s: LayerShape): SimpleRect | null {
  switch (s.kind) {
    case "rect":
      return { x: s.x, y: s.y, width: s.width, height: s.height };
    case "point":
      return { x: s.x - s.size, y: s.y - s.size, width: s.size * 2, height: s.size * 2 };
    case "circle":
      return { x: s.x - s.radius, y: s.y - s.radius, width: s.radius * 2, height: s.radius * 2 };
    case "polygon":
      if (s.points.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of s.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    case "line":
      return {
        x: Math.min(s.x1, s.x2),
        y: Math.min(s.y1, s.y2),
        width: Math.abs(s.x2 - s.x1),
        height: Math.abs(s.y2 - s.y1),
      };
    default:
      return null;
  }
}

function rectsOverlap(a: SimpleRect, b: SimpleRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function shapeCenter(s: LayerShape): { x: number; y: number } | null {
  const b = shapeBounds(s);
  if (!b) return null;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// ── Terminal extraction ──────────────────────────────────────────

/**
 * Find all terminal positions for a single cell type.
 * A terminal = any metal1 shape that overlaps ≥1 contact shape.
 * Returns positions in cell-local coordinates.
 */
export function detectCellTypeTerminals(
  layers: CellLayers | undefined,
  cellTypeId: string,
): InstanceTerminal[] {
  if (!layers) return [];

  const metal1Shapes = layers["metal1"] ?? [];
  const contactShapes = layers["contact"] ?? [];

  if (metal1Shapes.length === 0 || contactShapes.length === 0) return [];

  const fakeCell: Cell = { id: "", cellTypeId, x: 0, y: 0 };
  const fakeCellType: CellType = { id: cellTypeId, name: "", cropRect: { x: 0, y: 0, width: 0, height: 0 }, layers };

  const terminals: InstanceTerminal[] = [];
  let portIdx = 0;

  // Build a terminal for EACH contact that overlaps metal1.
  // One metal1 polygon with 4 contacts → 4 snap targets, all at contact centres.
  for (const cs of contactShapes) {
    const cb = shapeBounds(cs);
    if (!cb) continue;

    // Does this contact overlap any metal1?
    const overlapsM1 = metal1Shapes.some((m1) => {
      const mb = shapeBounds(m1);
      return mb && rectsOverlap(cb, mb);
    });
    if (!overlapsM1) continue;

    const center = shapeCenter(cs);
    if (!center) continue;

    const label = cs.label ?? `terminal_${portIdx}`;
    terminals.push({
      id: `${cellTypeId}:${label}:${cs.id}`,
      worldX: center.x,
      worldY: center.y,
      cell: fakeCell,
      cellType: fakeCellType,
      portName: label,
      shape: cs,
    });
    portIdx++;
  }

  return terminals;
}

/**
 * Build a flat map of all instance terminals across all cell types
 * on a die, in die-world coordinates.
 *
 *   candidateNets: existing die-level nets — if a terminal position
 *   is within tolerance of an existing net vertex, the terminal is
 *   already connected (used to decide snap priority).
 */
export function buildInstanceTerminalMap(
  cellTypes: CellType[],
  cells: Cell[],
): InstanceTerminal[] {
  // Pre-compute per cell-type terminals (cell-local coords).
  const perType = new Map<string, InstanceTerminal[]>();
  for (const ct of cellTypes) {
    perType.set(ct.id, detectCellTypeTerminals(ct.layers, ct.id));
  }

  const result: InstanceTerminal[] = [];

  for (const cell of cells) {
    const typeTerminals = perType.get(cell.cellTypeId);
    if (!typeTerminals || typeTerminals.length === 0) continue;

    const ct = cellTypes.find((t) => t.id === cell.cellTypeId);
    if (!ct) continue;

    for (const t of typeTerminals) {
      result.push({
        ...t,
        id: `${cell.id}:${t.portName}`,
        worldX: cell.x + t.worldX,  // worldX in cell-local is actually the local offset
        worldY: cell.y + t.worldY,
        cell,
        cellType: ct,
      });
    }
  }

  return result;
}
