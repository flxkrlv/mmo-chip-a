/**
 * Full-die netlist inference: stitch many cell instances together through the
 * die-level wires they touch.
 *
 * Inputs:
 *   - `DieAnnotations`        — cell types, placements, die wires, pins
 *   - per-cell-type extractions (precomputed; `extractCell` is the producer)
 *
 * A `wire_hitbox` shape on a cell type becomes a `CellPort` after extraction.
 * Each port carries hitbox geometry (cell-local) + a connecting layer. To
 * netlist, we transform every instance's port geometry into die/world space
 * and test it against every die wire (`AnnotationNet`, a node/edge polyline).
 * A port and a wire connect when the geometry intersects AND the layers are
 * compatible. Two ports resolving to the same wire are electrically joined.
 *
 * `DieNetlist` is the output data structure the Verilog emitter consumes.
 */

import type {
  AnnotationNet,
  Cell,
  CellType,
  DieAnnotations,
  IOPin,
} from "shared";
import type { CellExtraction, CellPort, ConnectingLayer } from "./cell";
import { shapeToPolygon } from "./common";
import type { Point, Rect } from "../geometry";
import {
  applyOrientation,
  pointInPolygon,
  pointInRect,
  polygonBounds,
  rectsIntersect,
  segmentsIntersect,
} from "../geometry";

// Direction inferred for a die wire that reaches the chip boundary.
// Each I/O pad can have multiple wires going/coming from it, since it can be a
// simple input/output, but also a bidirectional pin with output enable.
//   - io_input   — signal comes in from the pad.
//   - io_output  — chip drives the pad.
//   - io_bidir   — true bidirectional (a cell `inout` pin sits on it).
//   - io_control — output-enable control reaching the boundary.
//   - io_unknown — a placed pin forces port-hood but the direction is unclear.
export type WireIoRole =
  | "io_input"
  | "io_output"
  | "io_bidir"
  | "io_control"
  | "io_unknown";

/** One placed cell, paired with its connections to nets. */
export interface NetlistCellInstance {
  id: string;
  cellTypeId: string;
  /** Cell port name → wire id in `DieNetlist.wires`. */
  portToWire: Map<string, string>;
}

/** A die-level wire, named and (if a pad) direction-tagged. */
export interface NetlistWire {
  id: string; // same as id from `DieAnnotations.nets`
  name: string; // human-friendly name (pin-derived for promoted I/O wires)
  /** Pin number, if a placed I/O pin promoted this wire to the boundary. */
  pinNumber?: number;
  ioRole?: WireIoRole;
}

/**
 * A placed cell that is treated as an I/O pad because a pin point sits inside
 * its footprint. Such cells are NOT instantiated; the nets their ports touch
 * are promoted to top-level ports instead.
 */
export interface NetlistIoCell {
  cellId: string;
  cellTypeId: string;
  /** Name of the pin that identifies this pad (lowest pin number wins). */
  pinName: string;
  pinNumber: number;
  /** Wire ids this pad promoted to top-level ports. */
  promotedWireIds: string[];
}

export interface DieNetlist {
  moduleName: string;
  wires: NetlistWire[];
  cellInstances: NetlistCellInstance[];
  /** Placed pads (pin-inside-cell); excluded from `cellInstances`. */
  ioCells: NetlistIoCell[];
  /** Per cell-type extraction, keyed by cellTypeId (deduped). */
  extractions: Map<string, CellExtraction>;
  warnings: string[];
}

// ── Geometry helpers ──────────────────────────────────────────────

/** Two connecting layers are compatible if equal, or either is `"unknown"`. */
function layersCompatible(a: ConnectingLayer, b: ConnectingLayer): boolean {
  return a === "unknown" || b === "unknown" || a === b;
}

// `AnnotationNet` does not carry a layer yet, so every die wire is treated as
// `"unknown"` — i.e. it matches a hitbox on any layer. Once wires gain a layer
// in `shared`, swap this for the wire's real layer.
const WIRE_LAYER: ConnectingLayer = "unknown";

/**
 * True if the wire polyline touches `poly`: either a node sits inside the
 * polygon, or an edge segment crosses the polygon boundary.
 */
function wireTouchesPolygon(
  wire: AnnotationNet,
  poly: ReadonlyArray<Point>,
): boolean {
  const pb = polygonBounds(poly);
  if (!pb || wire.nodes.length === 0) return false;

  // Broad-phase: reject wires whose node bbox cannot reach the polygon.
  const wb = polygonBounds(wire.nodes);
  if (!wb || !rectsIntersect(pb, wb)) return false;

  for (const node of wire.nodes) {
    if (pointInPolygon(node, poly)) return true;
  }

  const nodeById = new Map(wire.nodes.map((n) => [n.id, n]));
  for (const edge of wire.edges) {
    const a = nodeById.get(edge.from);
    const b = nodeById.get(edge.to);
    if (!a || !b) continue;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (segmentsIntersect(a, b, poly[j], poly[i])) return true;
    }
  }
  return false;
}

// ── Top-level I/O inference ───────────────────────────────────────

/**
 * World-space axis-aligned footprint of a placed cell (its oriented cropRect).
 * Used to decide which placed pins land inside which cell. 90°-step rotations
 * keep the box axis-aligned, so a bbox of the transformed corners is exact.
 */
function cellFootprint(cell: Cell, cropW: number, cropH: number): Rect | null {
  const corners = [
    { x: 0, y: 0 },
    { x: cropW, y: 0 },
    { x: cropW, y: cropH },
    { x: 0, y: cropH },
  ].map((p) => {
    const o = applyOrientation(p, cell, cropW, cropH);
    return { x: cell.x + o.x, y: cell.y + o.y };
  });
  return polygonBounds(corners);
}

/**
 * Group placed I/O pins by the cell instance whose footprint contains them
 * (first containing cell wins — cells rarely overlap). Cells with ≥1 pin
 * inside are "I/O cells": pads whose nets get promoted to top-level ports
 * instead of the cell being instantiated.
 */
function pinsByCell(
  pins: ReadonlyArray<IOPin>,
  cells: ReadonlyArray<Cell>,
  cellTypeById: Map<string, CellType>,
): Map<string, IOPin[]> {
  const footprints = cells.map((cell) => {
    const ct = cellTypeById.get(cell.cellTypeId);
    return {
      cell,
      fp: ct ? cellFootprint(cell, ct.cropRect.width, ct.cropRect.height) : null,
    };
  });
  const out = new Map<string, IOPin[]>();
  for (const pin of pins) {
    for (const { cell, fp } of footprints) {
      if (fp && pointInRect(pin, fp)) {
        const list = out.get(cell.id);
        if (list) list.push(pin);
        else out.set(cell.id, [pin]);
        break;
      }
    }
  }
  return out;
}

/** The pin that names an I/O cell: lowest pin number wins (deterministic, and
 *  consistent with the "lowest pin wins" rule for nets shared across pads). */
function ownerPin(pins: ReadonlyArray<IOPin>): IOPin {
  return pins.reduce((a, b) => (b.pin < a.pin ? b : a));
}

/** Suffix for a promoted wire: the hitbox's own label, else its port index. */
function portSuffix(port: CellPort, index: number): string {
  return port.shape.label ?? String(index);
}

/**
 * Classify a die wire as a chip boundary port from the directions of the
 * (non-I/O-cell) pins that touch it. Returns the `WireIoRole` for a boundary
 * net, or `undefined` for a purely internal net (driven and consumed on-chip)
 * that no pad forces to the boundary.
 *
 * Rules, in order:
 *   - any `inout` core pin → io_bidir (a true bidirectional signal);
 *   - consumed but never driven on-chip → io_input (driven from outside);
 *   - driven but never consumed on-chip → io_output (goes off-chip);
 *   - `forcePort` (a promoted pad net) forces port-hood even when the net
 *     looks internal: io_bidir if also driven+consumed, else io_unknown;
 *   - otherwise not a port.
 */
function classifyWireIo(
  portDirections: ReadonlyArray<CellPort["direction"]>,
  forcePort: boolean,
): WireIoRole | undefined {
  let driver = false;
  let consumer = false;
  let bidir = false;
  for (const d of portDirections) {
    if (d === "output") driver = true;
    else if (d === "input") consumer = true;
    else if (d === "inout") bidir = true;
  }

  if (bidir) return "io_bidir";
  if (consumer && !driver) return "io_input";
  if (driver && !consumer) return "io_output";
  if (forcePort) return driver && consumer ? "io_bidir" : "io_unknown";
  return undefined;
}

// ── Netlist construction ──────────────────────────────────────────

/**
 * World-space hitbox polygon for one instance's port. Applies the cell
 * instance's full placement orientation (flipH / flipV / rotation) so the
 * hitbox lands where the cell is actually drawn on the die.
 */
function portWorldPolygon(
  port: CellPort,
  cell: Cell,
  cropW: number,
  cropH: number,
): Point[] {
  return shapeToPolygon(port.shape).map((p) => {
    const o = applyOrientation(p, cell, cropW, cropH);
    return { x: cell.x + o.x, y: cell.y + o.y };
  });
}

/**
 * Build the die netlist. A missing/failed cell-type extraction is non-fatal:
 * the instance is left unconnected and a warning is recorded.
 *
 * Note: this step is pure geometry — it does NOT require Clipper2. (Wires are
 * zero-width polylines, so polygon/segment tests are exact and sufficient.)
 */
export function inferDieNetlist(
  annotations: DieAnnotations,
  cellExtractions: Map<string, CellExtraction>,
  moduleName: string,
): DieNetlist {
  const warnings: string[] = [];

  const wires: NetlistWire[] = annotations.nets.map((net) => ({
    id: net.id,
    name: net.name,
  }));

  const cellTypeById = new Map(
    annotations.cellTypes.map((ct) => [ct.id, ct]),
  );

  // Pins placed inside a cell footprint mark that cell as an I/O pad.
  const pinsInCell = pinsByCell(
    annotations.pins ?? [],
    annotations.cells,
    cellTypeById,
  );

  // wire id → CORE (non-I/O-cell) ports connected to it. I/O-cell ports are
  // NOT recorded here: their connection becomes a promotion claim instead, so
  // a promoted net's direction is decided purely by the core logic on it.
  const connectionsByWire = new Map<
    string,
    { instanceId: string; port: CellPort }[]
  >();
  const recordConnection = (
    wireId: string,
    instanceId: string,
    port: CellPort,
  ) => {
    let list = connectionsByWire.get(wireId);
    if (!list) connectionsByWire.set(wireId, (list = []));
    list.push({ instanceId, port });
  };

  // wire id → promotion claims (one per I/O-cell port that touches the net).
  interface IoClaim {
    pinNumber: number;
    pinName: string;
    suffix: string;
  }
  const claimsByWire = new Map<string, IoClaim[]>();

  const cellInstances: NetlistCellInstance[] = [];
  const ioCells: NetlistIoCell[] = [];

  // Pre-pass: how many distinct I/O cells does each net touch? A pad hitbox
  // that overlaps several nets resolves to its lowest-fan-out net below, so a
  // pad's own signal wins over a wire threaded through the whole bus (e.g. a
  // shared output-enable / direction line). Counted over I/O-cell ports only.
  const ioFanout = new Map<string, number>();
  for (const cell of annotations.cells) {
    const pinsHere = pinsInCell.get(cell.id);
    if (!pinsHere || pinsHere.length === 0) continue;
    const cellType = cellTypeById.get(cell.cellTypeId);
    const extraction = cellExtractions.get(cell.cellTypeId);
    if (!cellType || !extraction) continue;
    const { width: cw, height: ch } = cellType.cropRect;
    const touched = new Set<string>();
    for (const port of extraction.ports) {
      const poly = portWorldPolygon(port, cell, cw, ch);
      for (const wire of annotations.nets) {
        if (
          layersCompatible(port.layer, WIRE_LAYER) &&
          wireTouchesPolygon(wire, poly)
        ) {
          touched.add(wire.id);
        }
      }
    }
    for (const id of touched) ioFanout.set(id, (ioFanout.get(id) ?? 0) + 1);
  }

  for (const cell of annotations.cells) {
    const cellType = cellTypeById.get(cell.cellTypeId);
    if (!cellType) {
      warnings.push(
        `cell instance "${cell.id}" references unknown cell type "${cell.cellTypeId}"`,
      );
      continue;
    }
    const extraction = cellExtractions.get(cell.cellTypeId);
    if (!extraction) {
      warnings.push(
        `cell instance "${cell.id}" (type "${cellType.name}") has no extraction — left unconnected`,
      );
      continue;
    }

    const cropW = cellType.cropRect.width;
    const cropH = cellType.cropRect.height;

    const pinsHere = pinsInCell.get(cell.id);
    const isIoCell = pinsHere != null && pinsHere.length > 0;
    const owner = isIoCell ? ownerPin(pinsHere) : null;

    const instance: NetlistCellInstance = {
      id: cell.id,
      cellTypeId: cell.cellTypeId,
      portToWire: new Map(),
    };
    const promotedWireIds: string[] = [];

    extraction.ports.forEach((port, portIndex) => {
      const worldPoly = portWorldPolygon(port, cell, cropW, cropH);
      const matched = annotations.nets.filter(
        (wire) =>
          layersCompatible(port.layer, WIRE_LAYER) &&
          wireTouchesPolygon(wire, worldPoly),
      );

      if (matched.length === 0) {
        warnings.push(
          `cell "${cell.id}" (${cellType.name}): hitbox "${port.name}" is not connected to any net`,
        );
        return;
      }
      // For an I/O-cell hitbox overlapping several nets, prefer the one touched
      // by the fewest pads (the pad's own signal beats a shared bus/OE wire).
      // Ties keep annotation order, matching the core-cell `matched[0]` pick.
      const chosen = owner
        ? matched.reduce((best, w) =>
            (ioFanout.get(w.id) ?? 0) < (ioFanout.get(best.id) ?? 0) ? w : best,
          )
        : matched[0];
      if (matched.length > 1) {
        warnings.push(
          `cell "${cell.id}" (${cellType.name}): hitbox "${port.name}" connects to ${matched.length} nets ` +
            `(${matched.map((w) => w.name).join(", ")}); using "${chosen.name}"`,
        );
      }

      if (owner) {
        // I/O cell: promote the net rather than wiring the (un-instantiated)
        // pad to it.
        const claim: IoClaim = {
          pinNumber: owner.pin,
          pinName: owner.name,
          suffix: portSuffix(port, portIndex),
        };
        const list = claimsByWire.get(chosen.id);
        if (list) list.push(claim);
        else claimsByWire.set(chosen.id, [claim]);
        promotedWireIds.push(chosen.id);
      } else {
        instance.portToWire.set(port.name, chosen.id);
        recordConnection(chosen.id, cell.id, port);
      }
    });

    if (owner) {
      ioCells.push({
        cellId: cell.id,
        cellTypeId: cell.cellTypeId,
        pinName: owner.name,
        pinNumber: owner.pin,
        promotedWireIds,
      });
    } else {
      cellInstances.push(instance);
    }
  }

  // Resolve each promoted net's name: lowest pin number wins (then pin name,
  // then suffix, for determinism). Wire name becomes "<pin>_<suffix>".
  const promoted = new Map<string, { name: string; pinNumber: number }>();
  for (const [wireId, claims] of claimsByWire) {
    claims.sort(
      (a, b) =>
        a.pinNumber - b.pinNumber ||
        a.pinName.localeCompare(b.pinName) ||
        a.suffix.localeCompare(b.suffix),
    );
    const winner = claims[0];
    promoted.set(wireId, {
      name: `${winner.pinName}_${winner.suffix}`,
      pinNumber: winner.pinNumber,
    });
  }

  // Per-wire I/O classification + driver checks.
  for (const wire of wires) {
    const conns = connectionsByWire.get(wire.id) ?? [];
    const promo = promoted.get(wire.id);

    // Direction comes from the core pins; a promoted net is forced to a port.
    const ioRole = classifyWireIo(
      conns.map((c) => c.port.direction),
      promo != null,
    );
    if (ioRole) wire.ioRole = ioRole;
    if (promo) {
      wire.name = promo.name;
      wire.pinNumber = promo.pinNumber;
    }

    // Driver checks apply to internal nets a cell actually drives. A promoted
    // net legitimately has no on-chip driver (it's a pad), so skip that case.
    if (conns.length === 0) continue;
    const drivers = conns.filter((c) => c.port.direction === "output");
    if (drivers.length === 0 && !promo) {
      warnings.push(
        `net "${wire.name}" has no driving (output) cell pin connected`,
      );
    } else if (drivers.length > 1) {
      warnings.push(
        `net "${wire.name}" has ${drivers.length} output drivers ` +
          `(${drivers.map((d) => `${d.instanceId}.${d.port.name}`).join(", ")})`,
      );
    }
  }

  return {
    moduleName,
    wires,
    cellInstances,
    ioCells,
    extractions: cellExtractions,
    warnings,
  };
}
