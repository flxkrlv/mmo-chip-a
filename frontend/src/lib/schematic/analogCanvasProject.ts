/**
 * analogCanvasProject.ts — neutral layout → analog-canvas project.
 *
 * This is the pure half of `tools/analog-canvas/convert.mjs`: no filesystem,
 * no CLI, no Node APIs. The same code therefore runs in the browser (the
 * canvas "Export to analog-canvas" button writes a ready `.icproj.json`) and
 * from the command line for batch conversion of saved neutral layouts.
 *
 * The project names **the stock analog-canvas library symbols** — `resistor`,
 * `capacitor`, `npn`, `diode`, `ground`, `port`, … — and carries no artwork of
 * its own. That matters for three reasons:
 *
 *   - the editor's netlist knows every one of those symbols, so no instance
 *     is reported as "no reviewed netlist definition";
 *   - a part placed by this export is the same size as the same part placed
 *     by hand, so imported and drawn parts combine on one grid;
 *   - no symbol data is copied from analog-canvas (AGPL-3.0-only) into this
 *     MIT repository.
 *
 * Everything below that names a library symbol is *interoperability data*:
 * the pin names the netlist prints and the pin offsets wires must land on.
 *
 * Wires are re-anchored to the real stock pins: every bend keeps the mmo
 * route's shape, and the segments next to a pin leave that pin along its
 * facing axis, so the drawing has no stray diagonals and every wire ends on a
 * terminal.
 */

import type {
  ExchangeDirection,
  ExchangeInstance,
  ExchangeSymbol,
  LayoutExchangeDocument,
} from "./layoutExchange";

export const ANALOG_CANVAS_SCHEMA_VERSION = 58;

export interface ConvertOptions {
  /** Document grid; defaults to the document hint (10). */
  grid?: number | null;
  /** Coordinate scale; defaults to the document hint (1). */
  scale?: number | null;
  /** Project name override. */
  name?: string | null;
  /** Emit wire routes (default true). */
  routes?: boolean;
  /** Emit the hierarchy Cells carried by the layout (default true). */
  hierarchy?: boolean;
}

export interface ConvertStats {
  symbols: number;
  instances: number;
  nets: number;
  routes: number;
  ports: number;
  /** Documents in the project: the top Cell plus one per hierarchy Cell. */
  documents: number;
  /** Hierarchy Cells emitted as subcircuit documents. */
  cells: number;
}

export interface ConvertResult {
  project: Record<string, unknown>;
  warnings: string[];
  stats: ConvertStats;
}

// ── Small helpers ───────────────────────────────────────────────

const roundTo = (value: number, step: number) => {
  const rounded = Math.round(value / step) * step;
  return Object.is(rounded, -0) ? 0 : rounded;
};

function gcd(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right !== 0) [left, right] = [right, left % right];
  return left || 1;
}
const num = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function sanitizeId(raw: unknown, fallback = "node"): string {
  const cleaned = String(raw ?? "")
    .replace(/[^A-Za-z0-9_.$-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 200) : fallback;
}

function cellName(raw: unknown): string {
  const cleaned = sanitizeId(raw, "Schematic").replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned.slice(0, 128) : `_${cleaned}`.slice(0, 128);
}

/** A SPICE identifier: what a Cell pin or an instance reference may print. */
function netlistName(raw: unknown, fallback: string): string {
  const cleaned = String(raw ?? "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned.length === 0) return fallback;
  const prefixed = /^[A-Za-z_]/.test(cleaned) ? cleaned : `n_${cleaned}`;
  return prefixed.slice(0, 128);
}

/**
 * The block symbol a Cell's callers draw, keyed by its name without case.
 * This is the editor's stable-id rule (FNV-1a 64 of a length-framed name);
 * the converter only computes the identifier, never the artwork.
 */
export function hierarchicalSymbolId(cellName: string): string {
  const folded = cellName.toLowerCase();
  const framed = `${folded.length}:${folded}`;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(framed)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `hierarchical-symbol-${hash.toString(16).padStart(16, "0")}`;
}

// ── Orientation ─────────────────────────────────────────────────

type Mirror = "none" | "horizontal" | "vertical" | "both";
type Rotation = 0 | 90 | 180 | 270;
interface Point {
  x: number;
  y: number;
}

/** Clockwise rotation in screen coordinates (y down), then axis mirroring. */
function orientPoint(point: Point, rotation: number, mirror: Mirror): Point {
  let { x, y } = point;
  switch (((rotation % 360) + 360) % 360) {
    case 90: {
      const nx = -y;
      y = x;
      x = nx;
      break;
    }
    case 180: {
      x = -x;
      y = -y;
      break;
    }
    case 270: {
      const nx = y;
      y = -x;
      x = nx;
      break;
    }
    default:
      break;
  }
  if (mirror === "horizontal" || mirror === "both") x = -x;
  if (mirror === "vertical" || mirror === "both") y = -y;
  return { x, y };
}

function swapMirror(mirror: Mirror): Mirror {
  if (mirror === "horizontal") return "vertical";
  if (mirror === "vertical") return "horizontal";
  return mirror;
}

/** Inverse of `orientPoint`: world offset → the instance's local offset. */
function inverseOrientPoint(point: Point, rotation: number, mirror: Mirror): Point {
  let { x, y } = point;
  if (mirror === "horizontal" || mirror === "both") x = -x;
  if (mirror === "vertical" || mirror === "both") y = -y;
  switch (((rotation % 360) + 360) % 360) {
    case 90: {
      const nx = y;
      y = -x;
      x = nx;
      break;
    }
    case 180: {
      x = -x;
      y = -y;
      break;
    }
    case 270: {
      const nx = -y;
      y = x;
      x = nx;
      break;
    }
    default:
      break;
  }
  return { x, y };
}

// ── Stock symbol contract ───────────────────────────────────────

interface StockPin {
  name: string;
  at: Point;
  direction: ExchangeDirection;
}

interface StockSymbol {
  /** Reviewed symbol id in the editor's built-in library. */
  id: string;
  /** viewBox centre; instance origins are placed so this lands on the box. */
  center: Point;
  pins: StockPin[];
  /** mmo terminal name → stock pin name. */
  aliases: Record<string, string>;
  /** Rotation that turns the stock art into the mmo template's orientation. */
  base: Rotation;
  /** Instance parameter the symbol needs, when it is a netlist device. */
  valueParameter?: "value" | "dc";
  /** Device class a model-bound instance declares. */
  modelClass?: "bjt" | "diode" | "mos";
  /** Supply marker semantics. */
  marker?: "ground" | "vdd" | "supply";
}

const PASSIVE_ALIASES = {
  PLUS: "1",
  MINUS: "2",
  A: "1",
  B: "2",
  "1": "1",
  "2": "2",
};

const DIODE_ALIASES = {
  PLUS: "A",
  MINUS: "K",
  "+": "A",
  "-": "K",
  A: "A",
  K: "K",
};

const MARKER_ALIASES = { PLUS: "P", A: "P", Y: "P", P: "P" };
const GROUND_ALIASES = { PLUS: "0", A: "0", "0": "0" };
const SOURCE_ALIASES = { PLUS: "+", MINUS: "-", "+": "+", "-": "-" };

const STOCK: Record<string, StockSymbol> = {
  resistor: {
    id: "resistor",
    center: { x: 0, y: 0 },
    pins: [
      { name: "1", at: { x: 0, y: -20 }, direction: "north" },
      { name: "2", at: { x: 0, y: 20 }, direction: "south" },
    ],
    aliases: PASSIVE_ALIASES,
    base: 0,
    valueParameter: "value",
  },
  capacitor: {
    id: "capacitor",
    center: { x: 0, y: 0 },
    pins: [
      { name: "1", at: { x: 0, y: -20 }, direction: "north" },
      { name: "2", at: { x: 0, y: 20 }, direction: "south" },
    ],
    aliases: PASSIVE_ALIASES,
    base: 0,
    valueParameter: "value",
  },
  inductor: {
    id: "inductor",
    center: { x: 0, y: 0 },
    pins: [
      { name: "1", at: { x: 0, y: -30 }, direction: "north" },
      { name: "2", at: { x: 0, y: 30 }, direction: "south" },
    ],
    aliases: PASSIVE_ALIASES,
    base: 0,
    valueParameter: "value",
  },
  npn: {
    id: "npn",
    center: { x: -13, y: 0 },
    pins: [
      { name: "C", at: { x: 0, y: -20 }, direction: "north" },
      { name: "B", at: { x: -30, y: 0 }, direction: "west" },
      { name: "E", at: { x: 0, y: 20 }, direction: "south" },
    ],
    aliases: { C: "C", B: "B", E: "E" },
    base: 0,
    modelClass: "bjt",
  },
  pnp: {
    id: "pnp",
    center: { x: -13, y: 0 },
    pins: [
      { name: "C", at: { x: 0, y: 20 }, direction: "south" },
      { name: "B", at: { x: -30, y: 0 }, direction: "west" },
      { name: "E", at: { x: 0, y: -20 }, direction: "north" },
    ],
    aliases: { C: "C", B: "B", E: "E" },
    base: 0,
    modelClass: "bjt",
  },
  diode: {
    id: "diode",
    center: { x: 0, y: 0 },
    pins: [
      { name: "A", at: { x: -20, y: 0 }, direction: "west" },
      { name: "K", at: { x: 20, y: 0 }, direction: "east" },
    ],
    aliases: DIODE_ALIASES,
    base: 0,
    modelClass: "diode",
  },
  "schottky-diode": {
    id: "schottky-diode",
    center: { x: 0, y: 0 },
    pins: [
      { name: "A", at: { x: -20, y: 0 }, direction: "west" },
      { name: "K", at: { x: 20, y: 0 }, direction: "east" },
    ],
    aliases: DIODE_ALIASES,
    base: 0,
    modelClass: "diode",
  },
  "zener-diode": {
    id: "zener-diode",
    center: { x: 0, y: 0 },
    pins: [
      { name: "A", at: { x: -20, y: 0 }, direction: "west" },
      { name: "K", at: { x: 20, y: 0 }, direction: "east" },
    ],
    aliases: DIODE_ALIASES,
    base: 0,
    modelClass: "diode",
  },
  nmos: {
    id: "nmos",
    center: { x: 0, y: 0 },
    pins: [
      { name: "D", at: { x: 10, y: -20 }, direction: "north" },
      { name: "G", at: { x: -20, y: 0 }, direction: "west" },
      { name: "S", at: { x: 10, y: 20 }, direction: "south" },
      { name: "B", at: { x: 20, y: 0 }, direction: "east" },
    ],
    aliases: { D: "D", G: "G", S: "S", B: "B" },
    base: 0,
    modelClass: "mos",
  },
  pmos: {
    id: "pmos",
    center: { x: 0, y: 0 },
    pins: [
      { name: "D", at: { x: 10, y: 20 }, direction: "south" },
      { name: "G", at: { x: -20, y: 0 }, direction: "west" },
      { name: "S", at: { x: 10, y: -20 }, direction: "north" },
      { name: "B", at: { x: 20, y: 0 }, direction: "east" },
    ],
    aliases: { D: "D", G: "G", S: "S", B: "B" },
    base: 0,
    modelClass: "mos",
  },
  ground: {
    id: "ground",
    center: { x: 0, y: 1.5 },
    pins: [{ name: "0", at: { x: 0, y: -10 }, direction: "north" }],
    aliases: GROUND_ALIASES,
    base: 0,
    marker: "ground",
  },
  "vdd-port": {
    id: "vdd-port",
    center: { x: 0, y: 11 },
    pins: [{ name: "P", at: { x: 0, y: 20 }, direction: "south" }],
    aliases: MARKER_ALIASES,
    base: 0,
    marker: "vdd",
  },
  "named-ground": {
    id: "named-ground",
    center: { x: 0, y: 1.5 },
    pins: [{ name: "P", at: { x: 0, y: -10 }, direction: "north" }],
    aliases: MARKER_ALIASES,
    base: 0,
    marker: "supply",
  },
  port: {
    id: "port",
    center: { x: -5, y: 0 },
    pins: [{ name: "P", at: { x: 0, y: 0 }, direction: "east" }],
    aliases: MARKER_ALIASES,
    base: 0,
  },
  "voltage-source": {
    id: "voltage-source",
    center: { x: -4.5, y: 0 },
    pins: [
      { name: "+", at: { x: 0, y: -20 }, direction: "north" },
      { name: "-", at: { x: 0, y: 20 }, direction: "south" },
    ],
    aliases: SOURCE_ALIASES,
    base: 0,
    valueParameter: "dc",
  },
  "current-source": {
    id: "current-source",
    center: { x: 0, y: 0 },
    pins: [
      { name: "+", at: { x: 0, y: -20 }, direction: "north" },
      { name: "-", at: { x: 0, y: 20 }, direction: "south" },
    ],
    aliases: SOURCE_ALIASES,
    base: 0,
    valueParameter: "dc",
  },
};

interface TemplateMapping {
  stock: string;
  base: Rotation;
}

/** mmo skin template → stock symbol, plus the rotation that aligns the art. */
const TEMPLATES: Record<string, TemplateMapping> = {
  resistor_v: { stock: "resistor", base: 0 },
  resistor_h: { stock: "resistor", base: 270 },
  capacitor_v: { stock: "capacitor", base: 0 },
  capacitor_h: { stock: "capacitor", base: 270 },
  inductor_v: { stock: "inductor", base: 0 },
  inductor_h: { stock: "inductor", base: 270 },
  diode_v: { stock: "diode", base: 90 },
  diode_h: { stock: "diode", base: 0 },
  diode_schottky_v: { stock: "schottky-diode", base: 90 },
  diode_schottky_h: { stock: "schottky-diode", base: 0 },
  transistor_npn: { stock: "npn", base: 0 },
  transistor_pnp: { stock: "pnp", base: 0 },
  transistor_nmos: { stock: "nmos", base: 0 },
  transistor_pmos: { stock: "pmos", base: 0 },
  vcc: { stock: "vdd-port", base: 0 },
  vee: { stock: "named-ground", base: 0 },
  gnd: { stock: "ground", base: 0 },
  inputExt: { stock: "port", base: 0 },
  outputExt: { stock: "port", base: 180 },
  voltage_source: { stock: "voltage-source", base: 0 },
  current_source: { stock: "current-source", base: 0 },
};

// ── Hierarchy block geometry ────────────────────────────────────

/**
 * The editor derives a block symbol from the child Cell's interface: one pin
 * per Cell terminal, input Pins on the west side and output Pins on the east,
 * on 20-unit rows. The converter lays the same geometry out itself so the
 * parent's wires land on the pins the editor will draw.
 */
const HIER_PIN_LEAD = 10;
const HIER_MIN_WIDTH = 80;
const HIER_MIN_HEIGHT = 40;
const HIER_BODY_PADDING = 20;
const HIER_NAME_WIDTH = 10;

interface CellInterfaceTerminal {
  id: string;
  name: string;
  direction: "input" | "output" | "inout" | string;
  netId: string;
}

interface CellGeometry {
  width: number;
  height: number;
  /** Symbol-local pin anchors; the block's viewBox centre is (0, 0). */
  pins: Array<{ name: string; at: Point; direction: ExchangeDirection }>;
  presentation: {
    /** Same arithmetic as the editor's derived block body, so it matches. */
    minimumBodySize: { width: number; height: number };
    pinPlacements: Array<{
      terminalId: string;
      side: "west" | "east";
      offset: number;
    }>;
  };
}

function roundUp20(value: number): number {
  return Math.ceil(value / 20) * 20;
}

function cellGeometry(terminals: CellInterfaceTerminal[]): CellGeometry {
  const occupied = new Set<string>();
  const counts = { west: 0, east: 0 };
  const placements = terminals.map((terminal) => {
    const side =
      terminal.direction === "input"
        ? "west"
        : terminal.direction === "output"
          ? "east"
          : counts.west <= counts.east
            ? "west"
            : "east";
    let offset = 0;
    for (let step = 1; occupied.has(`${side}:${offset}`); step += 1)
      offset = (step % 2 ? -1 : 1) * Math.ceil(step / 2) * 20;
    occupied.add(`${side}:${offset}`);
    counts[side] += 1;
    return { terminalId: terminal.id, side, offset } as const;
  });

  const labelWidth = (name: string) =>
    Math.max(20, name.length * HIER_NAME_WIDTH);
  const nameOf = new Map(terminals.map((terminal) => [terminal.id, terminal.name]));
  const westLabels = placements
    .filter((slot) => slot.side === "west")
    .map((slot) => labelWidth(nameOf.get(slot.terminalId) ?? ""));
  const eastLabels = placements
    .filter((slot) => slot.side === "east")
    .map((slot) => labelWidth(nameOf.get(slot.terminalId) ?? ""));
  const maxOffset = Math.max(0, ...placements.map((slot) => Math.abs(slot.offset)));
  const width = roundUp20(
    Math.max(
      HIER_MIN_WIDTH,
      Math.max(0, ...westLabels) + Math.max(0, ...eastLabels) + HIER_BODY_PADDING,
    ),
  );
  const height = roundUp20(
    Math.max(HIER_MIN_HEIGHT, maxOffset * 2 + HIER_BODY_PADDING * 2),
  );

  // Symbol-local coordinates; bodyBounds are centred so the viewBox centre,
  // and therefore the instance origin, is (0, 0).
  const left = -width / 2;
  const right = width / 2;
  const top = -height / 2;
  const bottom = height / 2;
  const pins = terminals.map((terminal) => {
    const slot = placements.find((item) => item.terminalId === terminal.id)!;
    return slot.side === "west"
      ? {
          name: terminal.name,
          at: { x: left - HIER_PIN_LEAD, y: slot.offset },
          direction: "west" as ExchangeDirection,
        }
      : {
          name: terminal.name,
          at: { x: right + HIER_PIN_LEAD, y: slot.offset },
          direction: "east" as ExchangeDirection,
        };
  });

  return {
    width,
    height,
    pins,
    presentation: {
      // `bodyBounds` needs Project schema 74; `minimumBodySize` plus explicit
      // pin rows is the same geometry and stays valid for schema 58.
      minimumBodySize: { width, height },
      pinPlacements: placements.map((slot) => ({ ...slot })),
    },
  };
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let suffix = 2;
  while (used.has(name.toLowerCase())) {
    name = `${base.slice(0, 120)}_${suffix}`;
    suffix += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

// ── Placement ───────────────────────────────────────────────────

interface PlacedInstance {
  neutral: ExchangeInstance;
  stock: StockSymbol;
  symbolId: string;
  origin: Point;
  rotation: Rotation;
  mirror: Mirror;
  /** World position of every stock pin, keyed by stock pin name. */
  pins: Map<string, Point>;
  /** World facing of every stock pin, keyed by stock pin name. */
  pinDirections: Map<string, ExchangeDirection>;
}

function placedPins(
  origin: Point,
  rotation: Rotation,
  mirror: Mirror,
  stock: StockSymbol,
): { pins: Map<string, Point>; directions: Map<string, ExchangeDirection> } {
  const pins = new Map<string, Point>();
  const directions = new Map<string, ExchangeDirection>();
  for (const pin of stock.pins) {
    const offset = orientPoint(pin.at, rotation, mirror);
    pins.set(pin.name, { x: origin.x + offset.x, y: origin.y + offset.y });
    const vector = orientPoint(
      directionVector(pin.direction),
      rotation,
      mirror,
    );
    directions.set(pin.name, vectorDirection(vector));
  }
  return { pins, directions };
}

function directionVector(direction: ExchangeDirection): Point {
  switch (direction) {
    case "north":
      return { x: 0, y: -1 };
    case "east":
      return { x: 1, y: 0 };
    case "south":
      return { x: 0, y: 1 };
    default:
      return { x: -1, y: 0 };
  }
}

function vectorDirection(vector: Point): ExchangeDirection {
  if (Math.abs(vector.x) >= Math.abs(vector.y))
    return vector.x >= 0 ? "east" : "west";
  return vector.y >= 0 ? "south" : "north";
}

/** The axis a wire leaves a pin along. */
function pinAxis(direction: ExchangeDirection): "h" | "v" {
  return direction === "east" || direction === "west" ? "h" : "v";
}

// ── Wire geometry ───────────────────────────────────────────────

/**
 * Follow the mmo route's bends but start and end on the *stock* pins: each
 * segment is axis-aligned, and the first/last segment leaves the pin along
 * the axis the pin faces. Without this, a stock pin a few units off the mmo
 * bend would draw a short diagonal that only snaps straight after the first
 * drag in the editor.
 */
function orthogonalPath(
  from: Point,
  to: Point,
  bends: Point[],
  fromDirection: ExchangeDirection,
  toDirection: ExchangeDirection,
  connectionGrid: number,
): Point[] {
  const points: Point[] = [{ ...from }];
  const push = (point: Point) => {
    const last = points[points.length - 1]!;
    if (last.x === point.x && last.y === point.y) return;
    points.push(point);
  };
  const step = (target: Point, firstAxis: "h" | "v") => {
    const last = points[points.length - 1]!;
    if (last.x === target.x || last.y === target.y) {
      push(target);
      return;
    }
    push(
      firstAxis === "v"
        ? { x: last.x, y: target.y }
        : { x: target.x, y: last.y },
    );
    push(target);
  };

  let axis = pinAxis(fromDirection);
  for (const bend of bends) {
    step(bend, axis);
    const last = points[points.length - 1]!;
    const previous = points[points.length - 2]!;
    axis = previous.x !== last.x ? "h" : "v";
  }

  // Approach the destination along the axis its pin faces.
  const required = pinAxis(toDirection);
  const last = points[points.length - 1]!;
  if (required === "v" && last.x !== to.x) {
    push({ x: to.x, y: last.y });
    push(to);
  } else if (required === "h" && last.y !== to.y) {
    push({ x: last.x, y: to.y });
    push(to);
  } else if (last.x === to.x || last.y === to.y) {
    push(to);
  } else {
    step(to, required);
  }

  return simplifyPath(
    snapPoints(points, connectionGrid),
  );
}

/**
 * The editor validates wire bends on the *electrical* lattice — the common
 * divisor of the document grid and the Symbol connection grid (grid 10 → 2).
 * mmo routes are integers but not necessarily even, so snap every coordinate;
 * a shared axis snaps identically on both points, so segments stay aligned.
 */
function snapPoints(points: Point[], grid: number): Point[] {
  if (grid <= 1) return points;
  return points.map((point) => ({
    x: snapCoordinate(point.x, grid),
    y: snapCoordinate(point.y, grid),
  }));
}

function snapCoordinate(value: number, grid: number): number {
  const snapped = Math.round(value / grid) * grid;
  return Object.is(snapped, -0) ? 0 : snapped;
}

function simplifyPath(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    out.push(point);
  }
  for (let i = out.length - 2; i > 0; i -= 1) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const c = out[i + 1]!;
    // A point on the same axis as both neighbours adds nothing: dropping it
    // draws the identical line and removes pin-offset jogs of a few units.
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y))
      out.splice(i, 1);
  }
  return out;
}

// ── Project assembly ────────────────────────────────────────────

/**
 * Layouts written before the neutral document carried `kind` still say what a
 * node is through its symbol id, so an older export converts unchanged.
 */
function normalizeInstance(instance: ExchangeInstance): ExchangeInstance {
  const symbol = String(instance.symbolId ?? "");
  const kind =
    instance.kind ??
    (symbol.startsWith("mmo:block:")
      ? "block"
      : /^mmo:(vcc|vee|gnd)$/.test(symbol)
        ? "power"
        : /^mmo:(inputExt|outputExt)$/.test(symbol)
          ? "io"
          : "device");
  const powerKind =
    instance.powerKind ??
    (kind === "power"
      ? symbol === "mmo:gnd"
        ? "gnd"
        : symbol === "mmo:vee"
          ? "vee"
          : "vcc"
      : undefined);
  const ioDirection =
    instance.ioDirection ??
    (kind === "io"
      ? symbol === "mmo:outputExt"
        ? "output"
        : "input"
      : undefined);
  return {
    ...instance,
    kind,
    ...(powerKind ? { powerKind } : {}),
    ...(ioDirection ? { ioDirection } : {}),
  };
}

export function convertLayoutToProject(
  layout: LayoutExchangeDocument,
  options: ConvertOptions = {},
): ConvertResult {
  if (!layout || layout.format !== "mmo.schematic-layout") {
    throw new Error(
      `not an mmo.schematic-layout document (got ${JSON.stringify(
        (layout as { format?: unknown } | null)?.format,
      )})`,
    );
  }
  if (Number(layout.version) > 1) {
    throw new Error(
      `layout version ${layout.version} is newer than this converter supports (1)`,
    );
  }

  const warnings = [...(layout.warnings ?? [])];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const grid = Math.max(1, Math.round(num(options.grid ?? layout.grid, 10)));
  const scale = Math.max(0.1, num(options.scale ?? layout.scale, 1));
  /** Wire bends live on gcd(documentGrid, SYMBOL_CONNECTION_GRID) = 2. */
  const connectionGrid = gcd(Math.round(grid), 2);
  const title =
    options.name ?? layout.source?.title ?? layout.source?.scope ?? "mmo schematic";

  const symbolById = new Map<string, ExchangeSymbol>(
    (layout.symbols ?? []).map((symbol) => [symbol.id, symbol]),
  );

  // ── Hierarchy Cells ───────────────────────────────────────────
  // A block's child Cell becomes a document of its own. Converting it first
  // lets the parent place the block with the exact pin geometry the editor
  // derives from that Cell's interface.
  interface ConvertedCell {
    id: string;
    name: string;
    netlistName: string;
    document: Record<string, unknown>;
    terminals: CellInterfaceTerminal[];
    geometry: CellGeometry;
  }
  const convertedCells = new Map<string, ConvertedCell>();
  const usedCellNames = new Set<string>([cellName(title).toLowerCase()]);
  if (options.hierarchy !== false) {
    let cellIndex = 0;
    for (const cell of layout.cells ?? []) {
      if (!cell?.document) continue;
      if (cell.document.format !== "mmo.schematic-layout") {
        warn(
          `hierarchy cell "${cell.name || cell.id}" is not an mmo.schematic-layout document — left out`,
        );
        continue;
      }
      cellIndex += 1;
      const sub = convertLayoutToProject(
        { ...cell.document, cells: [] },
        {
          ...options,
          name: cell.name || cell.document.source?.title || cell.netlistName,
          hierarchy: false,
        },
      );
      for (const message of sub.warnings)
        if (!warnings.includes(message)) warnings.push(message);
      const document = (
        sub.project.documents as Array<Record<string, unknown>>
      )[0]!;
      const name = uniqueName(
        netlistName(cell.netlistName || cell.name, `CELL${cellIndex}`),
        usedCellNames,
      );
      document.id = `document-cell-${cellIndex}`;
      document.name = String(cell.name || name);
      const netlist: Record<string, unknown> = {
        ...((document.netlist as Record<string, unknown> | undefined) ?? {}),
        name,
      };
      document.netlist = netlist;
      const terminals = (netlist.terminals ?? []) as CellInterfaceTerminal[];
      const geometry = cellGeometry(terminals);
      document.presentation = {
        ...((document.presentation as Record<string, unknown> | undefined) ?? {}),
        cellSymbol: geometry.presentation,
      };
      convertedCells.set(cell.id, {
        id: `document-cell-${cellIndex}`,
        name: document.name as string,
        netlistName: name,
        document,
        terminals,
        geometry,
      });
    }
  }

  /** Numeric mmo net behind each block pin, so a block pin can find its
   *  child Cell terminal (both documents keep the mmo net id). */
  const blockPinNet = new Map<string, number>();
  for (const net of layout.nets ?? []) {
    const match = /^net-(-?\d+)$/.exec(String(net.id));
    if (!match) continue;
    for (const terminal of net.terminals ?? [])
      blockPinNet.set(`${terminal.instance}\u0000${terminal.pin}`, Number(match[1]));
  }

  // ── Instances ─────────────────────────────────────────────────
  const instanceIds = new Set<string>();
  const idByNeutral = new Map<string, string>();
  const placed: PlacedInstance[] = [];
  const instances: Record<string, unknown>[] = [];
  const usedSymbols = new Set<string>();
  const blocks: string[] = [];
  const valueGaps = new Map<string, number>();
  const modelGaps = new Map<string, number>();
  const usedReferences = new Set<string>();
  const uniqueReference = (raw: string): string => {
    let reference = raw;
    let suffix = 2;
    while (usedReferences.has(reference.toLowerCase())) {
      reference = `${raw.slice(0, 120)}_${suffix}`;
      suffix += 1;
    }
    usedReferences.add(reference.toLowerCase());
    return reference;
  };

  for (const rawInstance of layout.instances ?? []) {
    const instance = normalizeInstance(rawInstance);
    const base = sanitizeId(instance.id, "I");
    let id = base;
    let n = 2;
    while (instanceIds.has(id)) id = `${base}_${n++}`;
    instanceIds.add(id);
    idByNeutral.set(instance.id, id);

    if (instance.kind === "block") {
      const cell = instance.cellId
        ? convertedCells.get(instance.cellId)
        : undefined;
      if (!cell) {
        // Without the child Cell there is no honest symbol: a block instance
        // must name a Document the project carries. The block's nets stay
        // intact because every one of them also reaches a device here.
        blocks.push(instance.reference || id);
        continue;
      }
      const symbol = symbolById.get(instance.symbolId);
      const box = { w: symbol?.width ?? 90, h: symbol?.height ?? 48 };
      // The block art is centred on the symbol origin, so the mmo box centre
      // is the instance origin directly.
      const centre = {
        x: instance.position.x * scale,
        y: instance.position.y * scale,
      };
      const mmoCentreOffset = orientPoint(
        { x: box.w / 2, y: box.h / 2 },
        instance.rotation,
        instance.mirror,
      );
      centre.x += mmoCentreOffset.x * scale;
      centre.y += mmoCentreOffset.y * scale;
      const origin = { x: roundTo(centre.x, grid), y: roundTo(centre.y, grid) };
      const rotation = instance.rotation;
      const mirror = instance.mirror;

      // Neutral block pins (`in_<net>`) → child Cell terminals on the same
      // mmo net. The netlist's pin order comes from the Cell, not this list.
      const aliases: Record<string, string> = {};
      for (const pin of symbol?.pins ?? []) {
        const netNumber = blockPinNet.get(`${instance.id}\u0000${pin.name}`);
        const terminal =
          netNumber === undefined
            ? undefined
            : cell.terminals.find(
                (item) => item.netId === `net-${netNumber}`,
              );
        if (!terminal) {
          warn(
            `hierarchy block ${instance.reference || id}: pin "${pin.name}" has no Cell terminal in ${cell.netlistName}`,
          );
          continue;
        }
        aliases[pin.name] = terminal.name;
      }
      const stock: StockSymbol = {
        id: hierarchicalSymbolId(cell.netlistName),
        center: { x: 0, y: 0 },
        pins: cell.geometry.pins,
        aliases,
        base: 0,
      };
      const { pins, directions } = placedPins(origin, rotation, mirror, stock);
      const rawReference = netlistName(instance.reference, `X${id}`);
      const reference = uniqueReference(
        /^[Xx]/.test(rawReference) ? rawReference : `X${rawReference}`,
      );
      instances.push({
        id,
        reference,
        symbolId: stock.id,
        placement: { position: origin, rotation, mirror },
        netlist: {
          binding: { kind: "subcircuit", childDocumentId: cell.id },
          parameters: {},
        },
      });
      placed.push({
        neutral: instance,
        stock,
        symbolId: stock.id,
        origin,
        rotation,
        mirror,
        pins,
        pinDirections: directions,
      });
      continue;
    }

    const templateName = instance.symbolId.replace(/^mmo:/, "");
    const mapping = TEMPLATES[templateName];
    if (!mapping) {
      warn(
        `left out ${instance.reference || id}: symbol "${templateName}" has no stock analog-canvas counterpart`,
      );
      continue;
    }
    const stock = STOCK[mapping.stock]!;
    const symbol = symbolById.get(instance.symbolId);
    const box = { w: symbol?.width ?? 40, h: symbol?.height ?? 40 };
    const rotation = ((((mapping.base + instance.rotation) % 360) + 360) %
      360) as Rotation;
    const mirror =
      mapping.base % 180 === 90 ? swapMirror(instance.mirror) : instance.mirror;

    // The neutral position is the mmo art origin; recover the box centre it
    // represents, then place the stock symbol so its own centre lands there.
    const centre = {
      x: instance.position.x * scale,
      y: instance.position.y * scale,
    };
    const mmoCentreOffset = orientPoint(
      { x: box.w / 2, y: box.h / 2 },
      instance.rotation,
      instance.mirror,
    );
    centre.x += mmoCentreOffset.x * scale;
    centre.y += mmoCentreOffset.y * scale;
    const stockCentreOffset = orientPoint(stock.center, rotation, mirror);
    const origin = {
      x: roundTo(centre.x - stockCentreOffset.x, grid),
      y: roundTo(centre.y - stockCentreOffset.y, grid),
    };
    const { pins, directions } = placedPins(origin, rotation, mirror, stock);

    const reference =
      instance.kind === "device"
        ? uniqueReference(netlistName(instance.reference, id))
        : undefined;
    if (instance.kind === "device" && !instance.reference)
      warn(`device ${id} had no reference; the netlist prints ${reference}`);

    const parameters = deviceParameters(instance, stock, valueGaps);
    const binding = deviceBinding(instance, stock, modelGaps);
    const entry: Record<string, unknown> = {
      id,
      ...(reference ? { reference } : {}),
      symbolId: stock.id,
      placement: { position: origin, rotation, mirror },
      ...(parameters || binding
        ? {
            netlist: {
              ...(binding ? { binding } : {}),
              parameters: parameters ?? {},
            },
          }
        : {}),
    };
    instances.push(entry);
    placed.push({
      neutral: instance,
      stock,
      symbolId: stock.id,
      origin,
      rotation,
      mirror,
      pins,
      pinDirections: directions,
    });
    usedSymbols.add(stock.id);
  }

  for (const name of blocks)
    warn(
      `hierarchy block "${name}" is not drawn: this layout carries no child Cell for it (re-export from the current build)`,
    );

  for (const [id, count] of valueGaps)
    warn(
      `${count} ${id} instance${count === 1 ? "" : "s"} carry no extracted value; the netlist prints ${id === "resistor" ? "1k" : id === "inductor" ? "1n" : "1p"}`,
    );
  for (const [model, count] of modelGaps)
    warn(
      `${count} transistor/diode instance${count === 1 ? "" : "s"} had no model name; bound to generic "${model}"`,
    );

  const placedById = new Map(placed.map((item) => [idByNeutral.get(item.neutral.id)!, item]));

  /** Map an mmo terminal name to the stock pin name of a placed instance. */
  const stockPin = (
    instanceId: string,
    mmoPin: string,
  ): { name: string; at: Point; direction: ExchangeDirection } | undefined => {
    const item = placedById.get(instanceId);
    if (!item) return undefined;
    const name = item.stock.aliases[mmoPin];
    const at = name ? item.pins.get(name) : undefined;
    if (!name || !at) {
      warn(
        `${item.neutral.reference || instanceId}: terminal "${mmoPin}" has no pin on ${item.symbolId}`,
      );
      return undefined;
    }
    return {
      name,
      at,
      direction: item.pinDirections.get(name) ?? "east",
    };
  };

  /** A pin already named in stock terms (Net membership stores those). */
  const placedPin = (
    instanceId: string,
    pinName: string,
  ): { name: string; at: Point; direction: ExchangeDirection } | undefined => {
    const item = placedById.get(instanceId);
    const at = item?.pins.get(pinName);
    if (!item || !at) return undefined;
    return {
      name: pinName,
      at,
      direction: item.pinDirections.get(pinName) ?? "east",
    };
  };

  // ── Nets ──────────────────────────────────────────────────────
  const netIds = new Set<string>();
  const netNameById = new Map<string, string>();
  const membership = new Map<string, Array<{ netId: string; pinName: string }>>();
  const nets: Record<string, unknown>[] = [];
  const netMembers = new Map<
    string,
    Array<{ instanceId: string; pinName: string }>
  >();
  const keptNeutral = new Set<string>();
  const terminalKey = (instanceId: string, pinName: string) =>
    `${instanceId}\u0000${pinName}`;

  for (const net of layout.nets ?? []) {
    if (netIds.has(net.id)) continue;
    const terminals: Array<{ instanceId: string; pinName: string }> = [];
    const seen = new Set<string>();
    for (const terminal of net.terminals ?? []) {
      const instanceId = idByNeutral.get(terminal.instance);
      if (!instanceId) continue;
      const pin = stockPin(instanceId, terminal.pin);
      if (!pin) continue;
      const key = terminalKey(instanceId, pin.name);
      if (seen.has(key)) continue;
      seen.add(key);
      terminals.push({ instanceId, pinName: pin.name });
    }
    if (terminals.length === 0) continue;
    netIds.add(net.id);
    netNameById.set(net.id, net.name ?? "");
    keptNeutral.add(net.id);
    netMembers.set(net.id, terminals);
    nets.push({ id: net.id, terminals });
    for (const terminal of terminals) {
      const list = membership.get(terminal.instanceId) ?? [];
      list.push({ netId: net.id, pinName: terminal.pinName });
      membership.set(terminal.instanceId, list);
    }
  }

  // ── Ports (Cell terminals) ────────────────────────────────────
  const portTerminals: Record<string, unknown>[] = [];
  const portNames = new Set<string>();
  let portIndex = 0;
  for (const item of placed) {
    if (item.neutral.kind !== "io") continue;
    const instanceId = idByNeutral.get(item.neutral.id)!;
    const memberships = membership.get(instanceId) ?? [];
    if (memberships.length === 0) {
      warn(
        `io pin "${item.neutral.reference}" is not connected to any Net — left out of the Cell interface`,
      );
      continue;
    }
    portIndex += 1;
    let name = netlistName(
      netNameById.get(memberships[0]!.netId) || item.neutral.reference,
      `IO${portIndex}`,
    );
    // Cell Pins are grouped by name without case, so uniqueness must be too.
    if (portNames.has(name.toLowerCase())) name = `${name}_${portIndex}`;
    portNames.add(name.toLowerCase());
    portTerminals.push({
      id: `terminal-${instanceId}`,
      name,
      netId: memberships[0]!.netId,
      direction: item.neutral.ioDirection ?? "inout",
      interfaceInstanceIds: [instanceId],
    });
  }

  // ── Power markers declare their Net name and domain ───────────
  const evidence: Record<string, unknown>[] = [];
  for (const item of placed) {
    const marker = item.stock.marker;
    if (!marker) continue;
    const instanceId = idByNeutral.get(item.neutral.id)!;
    const memberships = membership.get(instanceId) ?? [];
    if (memberships.length !== 1) {
      warn(
        `${item.neutral.reference || instanceId} is not tied to exactly one Net — its supply name is dropped`,
      );
      continue;
    }
    const netId = memberships[0]!.netId;
    const sourceName = netNameById.get(netId) ?? "";
    const named = netlistName(sourceName, "");
    if (marker === "ground") {
      if (named && named !== "0")
        warn(
          `ground Net "${sourceName}" exports as SPICE node 0 (the Ground symbol's own name)`,
        );
      evidence.push({
        id: `claim-${instanceId}`,
        kind: "name-claim",
        netId,
        name: "0",
        scope: "global",
        powerDomain: "ground",
        owner: { kind: "power-marker", objectId: instanceId },
      });
      continue;
    }
    const fallback = marker === "vdd" ? "VDD" : "VSS";
    evidence.push({
      id: `claim-${instanceId}`,
      kind: "name-claim",
      netId,
      name: named && named !== "0" ? named : fallback,
      scope: "global",
      powerDomain: "vdd",
      owner: { kind: "power-marker", objectId: instanceId },
    });
    if (!named)
      warn(
        `${item.neutral.reference || instanceId}: unnamed supply Net exported as ${fallback}`,
      );
  }

  // Preserve die-level net names for the editor's net list without drawing
  // extra text or claiming an electrical name. A name SPICE cannot spell
  // ("Net 5") would only produce a warning on export, so it stays out.
  const spiceIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const net of layout.nets ?? []) {
    if (!net.name || !keptNeutral.has(net.id)) continue;
    const sourceName = String(net.name).trim();
    if (!spiceIdentifier.test(sourceName) || sourceName === "0") continue;
    evidence.push({
      id: `hint-${net.id}`,
      kind: "net-name-hint",
      netId: net.id,
      sourceName: sourceName.slice(0, 256),
      origin: "legacy-explicit-net-property",
    });
  }

  // ── Routes ────────────────────────────────────────────────────
  const routes: Record<string, unknown>[] = [];
  let routeIndex = 0;
  const makeRoute = (
    netId: string,
    fromId: string,
    fromPin: string,
    toId: string,
    toPin: string,
    path: Point[],
  ): Record<string, unknown> => {
    routeIndex += 1;
    const legs: Record<string, unknown>[] = [];
    for (let i = 1; i < path.length - 1; i += 1) {
      legs.push({
        id: `route-${routeIndex}-leg-${i - 1}`,
        mode: "manual",
        to: {
          kind: "bend",
          bendId: `route-${routeIndex}-bend-${i - 1}`,
          position: path[i],
        },
      });
    }
    legs.push({
      id: `route-${routeIndex}-leg-end`,
      mode: "manual",
      to: {
        kind: "endpoint",
        endpoint: { kind: "terminal", instanceId: toId, pinName: toPin },
      },
    });
    return {
      id: `route-${routeIndex}`,
      netId,
      start: { kind: "terminal", instanceId: fromId, pinName: fromPin },
      legs,
    };
  };

  if (options.routes !== false) {
    const covered = new Set<string>();
    const seenRoutes = new Set<string>();
    for (const route of layout.routes ?? []) {
      if (!keptNeutral.has(route.netId)) continue;
      const fromId = idByNeutral.get(route.from?.instance);
      const toId = idByNeutral.get(route.to?.instance);
      if (!fromId || !toId) continue;
      const from = stockPin(fromId, String(route.from.pin));
      const to = stockPin(toId, String(route.to.pin));
      if (!from || !to) continue;
      const key = `${fromId}|${from.name}|${toId}|${to.name}`;
      if (seenRoutes.has(key)) continue;
      seenRoutes.add(key);
      const bends = (Array.isArray(route.bends) ? route.bends : []).map(
        (bend) => ({
          x: num(bend.x) * scale,
          y: num(bend.y) * scale,
        }),
      );
      const path = orthogonalPath(
        from.at,
        to.at,
        bends,
        from.direction,
        to.direction,
        connectionGrid,
      );
      if (path.length < 2) continue;
      routes.push(
        makeRoute(String(route.netId), fromId, from.name, toId, to.name, path),
      );
      covered.add(terminalKey(fromId, from.name));
      covered.add(terminalKey(toId, to.name));
    }

    // A Net member no route reaches would vanish when the editor re-saves
    // (schema 83 derives membership from wires). Link it to a covered member
    // so the netlist keeps it.
    for (const [netId, members] of netMembers) {
      if (members.length < 2) continue;
      for (const member of members) {
        if (covered.has(terminalKey(member.instanceId, member.pinName))) continue;
        const anchor =
          members.find(
            (candidate) =>
              candidate !== member &&
              covered.has(terminalKey(candidate.instanceId, candidate.pinName)),
          ) ?? members.find((candidate) => candidate !== member);
        if (!anchor) continue;
        // Net membership already carries stock pin names (the block's pin is
        // the child Cell terminal, which has no alias of its own).
        const from = placedPin(anchor.instanceId, anchor.pinName);
        const to = placedPin(member.instanceId, member.pinName);
        if (!from || !to) continue;
        const path = orthogonalPath(
          from.at,
          to.at,
          [],
          from.direction,
          to.direction,
          connectionGrid,
        );
        if (path.length < 2) continue;
        routes.push(
          makeRoute(
            netId,
            anchor.instanceId,
            anchor.pinName,
            member.instanceId,
            member.pinName,
            path,
          ),
        );
        covered.add(terminalKey(member.instanceId, member.pinName));
      }
    }
  }

  // ── Reference labels ──────────────────────────────────────────
  const annotations = placed
    .filter((item) => item.neutral.kind === "device")
    .map((item) => {
      const instanceId = idByNeutral.get(item.neutral.id)!;
      const top = Math.min(...[...item.pins.values()].map((pin) => pin.y));
      // The offset is local to the instance, so it must be the inverse of the
      // instance's own orientation to sit above the symbol on screen.
      const localOffset = inverseOrientPoint(
        { x: 10, y: top - 10 - item.origin.y },
        item.rotation,
        item.mirror,
      );
      return {
        id: `label-${instanceId}`,
        kind: "instance-label",
        binding: { kind: "instance-reference", instanceId },
        anchor: {
          kind: "object",
          objectId: instanceId,
          localOffset,
          fallbackPosition: {
            x: item.origin.x + localOffset.x,
            y: item.origin.y + localOffset.y,
          },
        },
        alignment: "middle",
        rotation: 0,
        locked: false,
      };
    });

  const document = {
    id: "document-main",
    name: String(title),
    netlist: {
      formalParameters: [],
      name: cellName(title),
      terminals: portTerminals,
    },
    presentation: {
      compactness: "normal",
      grid,
      styleProfileId: "razavi-textbook-v1",
    },
    instances,
    routes,
    nets,
    junctions: [],
    annotations,
    connectivityEvidence: evidence,
    constraints: [],
    layoutGroups: [],
    noConnects: [],
    drafting: { objects: [] },
    sourceStatus: "in-sync",
    revision: 0,
  };

  const project = {
    schemaVersion: ANALOG_CANVAS_SCHEMA_VERSION,
    id: `mmo-${sanitizeId(layout.source?.scope ?? "schematic", "schematic")}`,
    name: String(title),
    topDocumentId: document.id,
    documents: [
      document,
      ...[...convertedCells.values()].map((cell) => cell.document),
    ],
    // No `componentDefinitions`: every instance names a reviewed symbol of
    // the editor's built-in library. Copying that artwork here would be both
    // unnecessary and an AGPL-3.0 data import.
    externalSubcircuitDefinitions: [],
    simulationFolders: [],
    source: { dialect: "none", entry: null, files: [], sourcePolicy: "copy" },
    symbolLibrary: {
      hash: "razavi-reference-v1",
      id: "razavi-symbols",
      version: "1",
    },
    structureRevision: 0,
  };

  return {
    project,
    warnings,
    stats: {
      symbols: usedSymbols.size,
      instances: instances.length,
      nets: nets.length,
      routes: routes.length,
      ports: portTerminals.length,
      documents: 1 + convertedCells.size,
      cells: convertedCells.size,
    },
  };
}

// ── Netlist parameters and bindings ─────────────────────────────

function deviceParameters(
  instance: ExchangeInstance,
  stock: StockSymbol,
  gaps: Map<string, number>,
): Record<string, string> | undefined {
  if (instance.kind !== "device") return undefined;
  const parameters = { ...(instance.parameters ?? {}) };
  if (!stock.valueParameter) {
    return Object.keys(parameters).length > 0 ? parameters : undefined;
  }
  const raw = instance.value?.trim();
  if (stock.valueParameter === "dc") {
    // mmo keeps the source specification verbatim ("DC 5", "SINE(0 1 1k)").
    const dc = /^dc\s+(\S+)/i.exec(raw ?? "")?.[1] ?? raw;
    parameters.dc = dc && Number.isFinite(Number(dc)) ? dc : "0";
    return parameters;
  }
  parameters.value =
    raw ||
    (stock.id === "resistor" ? "1k" : stock.id === "inductor" ? "1n" : "1p");
  if (!raw) gaps.set(stock.id, (gaps.get(stock.id) ?? 0) + 1);
  return parameters;
}

function deviceBinding(
  instance: ExchangeInstance,
  stock: StockSymbol,
  gaps: Map<string, number>,
): Record<string, unknown> | undefined {
  if (!stock.modelClass || instance.kind !== "device") return undefined;
  const fallback =
    stock.id === "npn"
      ? "NPN"
      : stock.id === "pnp"
        ? "PNP"
        : stock.id === "nmos"
          ? "NMOS"
          : stock.id === "pmos"
            ? "PMOS"
            : "D";
  const model = instance.model?.trim() || fallback;
  if (!instance.model) gaps.set(model, (gaps.get(model) ?? 0) + 1);
  return { kind: "model", deviceClass: stock.modelClass, name: model };
}
