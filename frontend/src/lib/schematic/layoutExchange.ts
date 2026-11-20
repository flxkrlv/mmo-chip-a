/**
 * layoutExchange.ts — neutral, tool-agnostic schematic layout interchange.
 *
 * The interactive analog canvas owns a rich, ELK-produced layout plus the
 * user's manual edits (positions, orientations, wire re-routes). This module
 * serialises that state into a *plain JSON document* — the
 * `mmo.schematic-layout` format — with no reference to any external editor.
 *
 * `tools/analog-canvas/convert.mjs` turns the neutral document into an
 * analog-canvas `.icproj.json` project. Keeping the contract here (and the
 * converter outside the frontend bundle) means:
 *
 *   - mmo-chip-a never depends on analog-canvas;
 *   - no AGPL-3.0 source or symbol data crosses into this MIT repository;
 *   - the neutral file is inspectable and can feed other consumers later.
 *
 * Coordinate system: the neutral document stays in *mmo canvas units* —
 * unrotated symbol box, top-left origin of `positions`, y down. Scaling to a
 * target editor's grid is the converter's job.
 *
 * A hierarchy block does not flatten into a rectangle: `cells` carries the
 * block's region as a child document, and the parent instance names it via
 * `cellId`. The converter turns that into a real analog-canvas subcircuit.
 */

import type { AnalogDevice } from "shared";
import type {
  DeviceOrientationLike,
  Point,
  WireData,
} from "./interactiveAnalogLayout";
import type { SymbolPin, SymbolTable, SymbolTemplate } from "./interactiveSymbols";
import { templateForDevice } from "./interactiveSymbols";
import { effectiveSheetR } from "../export/resistorDefaults";
import { effectiveCapacitance } from "../export/capacitorDefaults";

// ── Neutral document shape ───────────────────────────────────────

export type ExchangeDirection = "north" | "east" | "south" | "west";

/** A primitive the converter can emit without parsing SVG. */
export type ExchangePrimitive =
  | { kind: "polyline"; points: Point[]; filled?: boolean }
  | { kind: "polygon"; points: Point[] }
  | { kind: "circle"; cx: number; cy: number; r: number; filled?: boolean }
  | {
      kind: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      rx?: number;
      filled?: boolean;
    }
  /** Escape hatch: raw SVG path data the converter scales numerically. */
  | { kind: "path"; d: string; filled?: boolean };

export interface ExchangePin {
  name: string;
  x: number;
  y: number;
  direction: ExchangeDirection;
  role: string;
}

export interface ExchangeSymbol {
  /** Converter-local symbol id, e.g. `mmo:nmos_v`. */
  id: string;
  /** Human name (skin template type or block name). */
  name: string;
  /** Declared symbol box (mmo units). */
  width: number;
  height: number;
  pins: ExchangePin[];
  primitives: ExchangePrimitive[];
}

export interface ExchangeInstance {
  /** Editor-side instance id (unique, sanitised from the node key). */
  id: string;
  /** Displayed reference (device key, net name or block name). */
  reference: string;
  symbolId: string;
  /** What the node is in the mmo scene; the converter maps each kind. */
  kind: "device" | "power" | "io" | "block";
  /** For `kind: "block"`: the child Cell this instance stands for. */
  cellId?: string;
  /** Symbol origin in mmo canvas units (not the box top-left when rotated). */
  position: Point;
  rotation: 0 | 90 | 180 | 270;
  mirror: "none" | "horizontal" | "vertical" | "both";
  /** The mmo node key this instance came from (audit trail). */
  sourceKey: string;
  /** mmo device kind (`resistor`, `bjt_npn`, …), when the node is a device. */
  deviceKind?: string;
  /** SPICE value carried by the extracted device geometry, when it has one. */
  value?: string;
  /** Model/master name the source netlist used, when known. */
  model?: string;
  /** Device parameters the layout already knows (W/L/fingers/multiplier). */
  parameters?: Record<string, string>;
  /** Supply polarity of a power marker. */
  powerKind?: "vcc" | "vee" | "gnd";
  /** Port direction of an io node. */
  ioDirection?: "input" | "output";
}

export interface ExchangeTerminalRef {
  instance: string;
  pin: string;
}

export interface ExchangeNet {
  /** Stable neutral net id, e.g. `net-12`. */
  id: string;
  /** Die-level name when the net has one (`VDD`, `INP`, …). */
  name?: string;
  terminals: ExchangeTerminalRef[];
}

export interface ExchangeRoute {
  netId: string;
  from: ExchangeTerminalRef;
  to: ExchangeTerminalRef;
  /** Interior bend points in mmo canvas units (endpoints excluded). */
  bends: Point[];
}

/**
 * A hierarchy block's child Cell. The region keeps its own devices, nets and
 * ports, so the converter can emit a real subcircuit document instead of a
 * flat drawing with the block dropped.
 */
export interface LayoutExchangeCell {
  /** Neutral id the parent's block instances name via `cellId`. */
  id: string;
  /** Display name (the block label). */
  name: string;
  /** Subcircuit/Cell name the netlist prints; made unique by the converter. */
  netlistName: string;
  /** The Cell drawing, in the same neutral format (no nested cells). */
  document: LayoutExchangeDocument;
}

export interface LayoutExchangeDocument {
  format: "mmo.schematic-layout";
  version: 1;
  generatedAt: string;
  source: { tool: "mmo-chip"; scope: string; title: string };
  /** Target document grid hint for the converter. */
  grid: number;
  /** Recommended scale factor (keeps symbol pin anchors on even units). */
  scale: number;
  symbols: ExchangeSymbol[];
  instances: ExchangeInstance[];
  nets: ExchangeNet[];
  routes: ExchangeRoute[];
  /** Child Cells of the hierarchy blocks this document places. */
  cells?: LayoutExchangeCell[];
  /** Things that were dropped or approximated, for the user to review. */
  warnings: string[];
}

// ── Inputs ──────────────────────────────────────────────────────

/**
 * The canvas render node, reduced to what the exporter needs. Structurally
 * compatible with the component's private `RenderNode`, plus `terminals`
 * for synthetic nodes (hierarchy blocks).
 */
export interface LayoutExchangeNode {
  key: string;
  kind: "device" | "power" | "io" | "block";
  template?: SymbolTemplate;
  size: { w: number; h: number };
  device?: AnalogDevice;
  /** Display label for io pins and hierarchy blocks. */
  label?: string;
  /** Explicit Cell-pin direction of an io node; wins over the template. */
  ioDirection?: "input" | "output";
  /** Only used by `kind: "block"` — the block's port terminals. */
  terminals?: Array<{ name: string; netId: number }>;
  /** Only used by `kind: "block"` — the child Cell the block stands for. */
  cellId?: string;
  blockPorts?: Array<{
    terminal: string;
    netName: string;
    dx: number;
    dy: number;
    isInput: boolean;
  }>;
}

export interface LayoutExchangeValues {
  /** Sheet resistance per resistor type [Ω/□], as the canvas labels it. */
  sheetR?: Record<string, number>;
  /** Specific capacitance [fF/μm²], as the canvas labels it. */
  capDensity?: number;
}

export interface LayoutExchangeInput {
  scopeKey: string;
  title?: string;
  table: SymbolTable;
  nodes: LayoutExchangeNode[];
  positions: Record<string, Point>;
  orientations: Record<string, DeviceOrientationLike>;
  wires: Map<number, WireData>;
  namedNets: Map<number, string>;
  /** Child Cells referenced by this document's hierarchy blocks. */
  cells?: LayoutExchangeCell[];
  /** Technology values the canvas already uses for R/C labels. */
  values?: LayoutExchangeValues;
  /** Default 10 — matches the analog-canvas document grid. */
  grid?: number;
  /** Default 1 — stock symbols already sit on that grid. */
  scale?: number;
  /** Default true. Disable to export topology only (no wires). */
  includeRoutes?: boolean;
  /** Default 0.9098875 — fixed so tests are deterministic. */
  now?: () => Date;
}

// ── SVG path → polyline conversion ──────────────────────────────

interface SubPath {
  points: Point[];
  closed: boolean;
}

const PATH_TOKEN_RE =
  /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

/**
 * Parse an SVG path into open/closed polygons. Only the straight-line
 * subset used by `CUSTOM_ANALOG_SKIN` is handled; curves and arcs return
 * `null` so the caller can fall back to raw path data.
 */
export function parseSvgPath(d: string): SubPath[] | null {
  const tokens: Array<{ cmd?: string; num?: number }> = [];
  let match: RegExpExecArray | null;
  PATH_TOKEN_RE.lastIndex = 0;
  while ((match = PATH_TOKEN_RE.exec(d))) {
    if (match[1]) tokens.push({ cmd: match[1] });
    else tokens.push({ num: Number(match[2]) });
  }

  const subpaths: SubPath[] = [];
  let current: Point = { x: 0, y: 0 };
  let sub: Point[] | null = null;
  let closed = false;
  let i = 0;

  const finish = () => {
    if (sub && sub.length > 0) subpaths.push({ points: sub, closed });
    sub = null;
    closed = false;
  };
  const ensure = (): Point[] => {
    if (!sub) {
      sub = [{ ...current }];
      closed = false;
    }
    return sub;
  };

  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.cmd) return null;
    i += 1;
    const cmd = token.cmd;
    const upper = cmd.toUpperCase();
    const relative = cmd !== upper;
    if (!"MLHVZ".includes(upper)) return null;

    if (upper === "Z") {
      if (sub) {
        closed = true;
        finish();
      }
      continue;
    }

    const take = (count: number): number[] | null => {
      const out: number[] = [];
      for (let k = 0; k < count; k += 1) {
        const next = tokens[i + k];
        if (!next || next.num === undefined) return null;
        out.push(next.num);
      }
      i += count;
      return out;
    };

    if (upper === "M") {
      const pair = take(2);
      if (!pair) return null;
      finish();
      current = relative
        ? { x: current.x + pair[0]!, y: current.y + pair[1]! }
        : { x: pair[0]!, y: pair[1]! };
      sub = [{ ...current }];
      closed = false;
      // Implicit line-to after a moveto.
      for (;;) {
        const next = tokens[i];
        if (!next || next.cmd || next.num === undefined) break;
        const p = take(2);
        if (!p) return null;
        current = relative
          ? { x: current.x + p[0]!, y: current.y + p[1]! }
          : { x: p[0]!, y: p[1]! };
        ensure().push({ ...current });
      }
      continue;
    }

    if (upper === "L") {
      for (;;) {
        const next = tokens[i];
        if (!next || next.cmd || next.num === undefined) break;
        const p = take(2);
        if (!p) return null;
        current = relative
          ? { x: current.x + p[0]!, y: current.y + p[1]! }
          : { x: p[0]!, y: p[1]! };
        ensure().push({ ...current });
      }
      continue;
    }

    if (upper === "H") {
      for (;;) {
        const next = tokens[i];
        if (!next || next.cmd || next.num === undefined) break;
        const p = take(1);
        if (!p) return null;
        current = {
          x: relative ? current.x + p[0]! : p[0]!,
          y: current.y,
        };
        ensure().push({ ...current });
      }
      continue;
    }

    // V
    for (;;) {
      const next = tokens[i];
      if (!next || next.cmd || next.num === undefined) break;
      const p = take(1);
      if (!p) return null;
      current = {
        x: current.x,
        y: relative ? current.y + p[0]! : p[0]!,
      };
      ensure().push({ ...current });
    }
  }

  finish();
  return subpaths.length > 0 ? subpaths : null;
}

// ── Skin markup → exchange primitives ────────────────────────────

function attrOf(tag: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

const ELEMENT_RE = /<(path|circle|rect)\b([^>]*?)\/?>/g;

/**
 * Convert the sanitized `SymbolTemplate.body` markup (paths, circles,
 * rectangles — that is all `CUSTOM_ANALOG_SKIN` uses) into neutral
 * primitives. Filled art (“detail” class) becomes polygons so the target
 * editor can render arrow heads without understanding SVG path syntax.
 */
export function primitivesFromBody(
  body: string,
  warn: (message: string) => void,
): ExchangePrimitive[] {
  const out: ExchangePrimitive[] = [];
  let match: RegExpExecArray | null;
  ELEMENT_RE.lastIndex = 0;
  while ((match = ELEMENT_RE.exec(body))) {
    const tag = match[1]!;
    const attrs = match[2] ?? "";
    const cls = attrOf(attrs, "class") ?? "";
    // `parseSymbolSkin` bakes `fill="#ffffff"` for filled art ("detail" class
    // and skin paths authored with `style="fill:#000000"`); everything else
    // is explicitly `fill="none"`.
    const filled = /\bdetail\b/.test(cls) || /fill="#ffffff"/i.test(attrs);

    if (tag === "circle") {
      out.push({
        kind: "circle",
        cx: Number(attrOf(attrs, "cx") ?? 0),
        cy: Number(attrOf(attrs, "cy") ?? 0),
        r: Number(attrOf(attrs, "r") ?? 0),
        filled: false,
      });
      continue;
    }

    if (tag === "rect") {
      out.push({
        kind: "rect",
        x: Number(attrOf(attrs, "x") ?? 0),
        y: Number(attrOf(attrs, "y") ?? 0),
        w: Number(attrOf(attrs, "width") ?? 0),
        h: Number(attrOf(attrs, "height") ?? 0),
        ...(attrOf(attrs, "rx") ? { rx: Number(attrOf(attrs, "rx")) } : {}),
        filled: false,
      });
      continue;
    }

    const d = attrOf(attrs, "d");
    if (!d) continue;
    const subpaths = parseSvgPath(d);
    if (!subpaths) {
      warn(`kept raw path data (unsupported commands): ${d}`);
      out.push({ kind: "path", d, filled });
      continue;
    }
    for (const subpath of subpaths) {
      if (subpath.closed && filled && subpath.points.length >= 3) {
        out.push({ kind: "polygon", points: subpath.points });
        continue;
      }
      const points = subpath.closed
        ? [...subpath.points, subpath.points[0]!]
        : subpath.points;
      if (points.length >= 2) out.push({ kind: "polyline", points });
    }
  }
  if (out.length === 0) warn("symbol body has no drawable primitives");
  return out;
}

// ── Orientation helpers ─────────────────────────────────────────

/**
 * Symbol origin such that the target editor's `translate(pos) scale(mirror)
 * rotate(deg)` reproduces mmo's rotate/flip-about-the-box-centre art
 * transform. Derived from:
 *   mmo:    pos + c + F(R(p - c))
 *   target: pos' + F(R(p))
 * ⇒ pos' = pos + c - F(R(c)).
 */
export function orientedOrigin(
  pos: Point,
  size: { w: number; h: number },
  orient: DeviceOrientationLike | undefined,
): Point {
  if (!orient || (orient.rot === 0 && orient.flip === "none")) return { ...pos };
  const c = { x: size.w / 2, y: size.h / 2 };
  let { x, y } = c;
  switch (orient.rot) {
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
  if (orient.flip === "h") x = -x;
  if (orient.flip === "v") y = -y;
  return { x: pos.x + c.x - x, y: pos.y + c.y - y };
}

function mirrorOf(flip: DeviceOrientationLike["flip"] | undefined) {
  return flip === "h" ? "horizontal" : flip === "v" ? "vertical" : "none";
}

function directionOf(pin: SymbolPin, template: SymbolTemplate): ExchangeDirection {
  switch (pin.position) {
    case "top":
      return "north";
    case "bottom":
      return "south";
    case "left":
      return "west";
    case "right":
      return "east";
    default:
      return pin.dx <= template.width / 2 ? "west" : "east";
  }
}

function roleOf(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith("d")) return "drain";
  if (n.startsWith("g")) return "gate";
  if (n.startsWith("s")) return "source";
  if (n.startsWith("b")) return "bulk";
  if (n.startsWith("c")) return "collector";
  if (n.startsWith("e")) return "emitter";
  if (n.startsWith("in")) return "input";
  if (n.startsWith("out")) return "output";
  return "passive";
}

/** Terminals of a node, in neutral (mmo) names. */
function nodeTerminals(
  node: LayoutExchangeNode,
): Array<{ name: string; netId: number }> {
  if (node.device) return node.device.terminals;
  if (node.kind === "block") return node.terminals ?? [];
  const netId = Number(node.key.slice(node.key.indexOf(":") + 1));
  const pin = node.template?.pins[0];
  if (!pin || !Number.isFinite(netId)) return [];
  return [{ name: pin.pid, netId }];
}

function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_.$-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "node";
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * The SPICE value an extracted device carries. The canvas labels a resistor
 * with its squares × the user's sheet resistance and a capacitor with its
 * plate area × the user's density, so the export uses the same numbers; the
 * measured value is the fallback for a layout converted outside the app.
 */
function valueOfDevice(
  device: AnalogDevice,
  values?: LayoutExchangeValues,
): string | undefined {
  if (device.kind === "resistor") {
    const geometry = device.geometry as {
      squares?: number;
      resistorType?: string;
      resistance_ohms?: number;
    };
    if (Number.isFinite(geometry.squares) && geometry.squares! > 0) {
      const sheet = effectiveSheetR(
        geometry.resistorType as Parameters<typeof effectiveSheetR>[0],
        values?.sheetR,
      );
      const ohms = Math.round(geometry.squares! * sheet);
      if (Number.isFinite(ohms) && ohms > 0) return String(ohms);
    }
    if (Number.isFinite(geometry.resistance_ohms) && geometry.resistance_ohms! > 0)
      return String(geometry.resistance_ohms);
  }
  if (device.kind === "capacitor") {
    const fF = effectiveCapacitance(
      device.geometry as { area_um2?: number; capacitance_fF?: number },
      values?.capDensity,
    );
    if (Number.isFinite(fF) && fF! > 0)
      return fF! >= 1000 ? `${fF! / 1000}p` : `${fF}f`;
  }
  if (device.kind === "voltage_source" || device.kind === "current_source") {
    const raw = (device.geometry as { sourceValue?: string }).sourceValue;
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  }
  return undefined;
}

/** Device parameters the layout itself already knows, in SPICE spelling. */
function parametersOfDevice(device: AnalogDevice): Record<string, string> | undefined {
  if (device.kind !== "mos") return undefined;
  const geometry = device.geometry as {
    W_um?: number;
    L_um?: number;
    fingers?: number;
    multiplier?: number;
  };
  const parameters: Record<string, string> = {};
  if (Number.isFinite(geometry.W_um) && geometry.W_um! > 0)
    parameters.w = `${geometry.W_um}u`;
  if (Number.isFinite(geometry.L_um) && geometry.L_um! > 0)
    parameters.l = `${geometry.L_um}u`;
  if (Number.isFinite(geometry.fingers) && geometry.fingers! > 0)
    parameters.nf = String(geometry.fingers);
  if (Number.isFinite(geometry.multiplier) && geometry.multiplier! > 0)
    parameters.m = String(geometry.multiplier);
  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

// ── Builder ─────────────────────────────────────────────────────

export function buildLayoutExchange(
  input: LayoutExchangeInput,
): LayoutExchangeDocument {
  const { table, nodes, positions, orientations, wires, namedNets } = input;
  const cells = input.cells ?? [];
  const cellIds = new Set(cells.map((cell) => cell.id));
  const grid = input.grid ?? 10;
  const scale = input.scale ?? 1;
  const now = input.now ?? (() => new Date());
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  /** Respect the caller's resolved template, but allow a bare device node. */
  const templateOf = (node: LayoutExchangeNode): SymbolTemplate | undefined =>
    node.template ?? (node.device ? templateForDevice(table, node.device) : undefined);

  // ── Symbols ───────────────────────────────────────────────────
  // Device symbols are keyed by skin template type; each collects the
  // union of terminal names seen across the instances that use it.
  const symbols = new Map<string, ExchangeSymbol>();
  const pinNamesBySymbol = new Map<string, Set<string>>();
  const termPinByNode = new Map<
    string,
    Map<string, { dx: number; dy: number; direction: ExchangeDirection; pid: string }>
  >();

  const symbolForTemplate = (template: SymbolTemplate): ExchangeSymbol => {
    const id = `mmo:${template.type}`;
    let symbol = symbols.get(id);
    if (!symbol) {
      symbol = {
        id,
        name: template.type,
        width: template.width,
        height: template.height,
        pins: [],
        primitives: primitivesFromBody(template.body, warn),
      };
      symbols.set(id, symbol);
      pinNamesBySymbol.set(id, new Set());
    }
    return symbol;
  };

  for (const node of nodes) {
    const pos = positions[node.key];
    if (!pos) {
      warn(`node ${node.key} has no position — left out`);
      continue;
    }
    const terminals = nodeTerminals(node);

    if (node.kind === "block") {
      if (node.cellId && !cellIds.has(node.cellId))
        warn(
          `hierarchy block ${node.key} names cell "${node.cellId}" that this document does not carry — the block is left out of the project`,
        );
      const id = `mmo:block:${sanitizeId(node.key.replace(/^blk:/, ""))}`;
      const symbol: ExchangeSymbol = {
        id,
        name: node.key.replace(/^blk:/, ""),
        width: node.size.w,
        height: node.size.h,
        pins: [],
        primitives: [
          {
            kind: "rect",
            x: 0,
            y: 0,
            w: node.size.w,
            h: node.size.h,
          },
        ],
      };
      const map = new Map<
        string,
        { dx: number; dy: number; direction: ExchangeDirection; pid: string }
      >();
      for (const stub of node.blockPorts ?? []) {
        symbol.pins.push({
          name: stub.terminal,
          x: round(stub.dx),
          y: round(stub.dy),
          direction: stub.isInput ? "west" : "east",
          role: stub.isInput ? "input" : "output",
        });
        map.set(stub.terminal, {
          dx: stub.dx,
          dy: stub.dy,
          direction: stub.isInput ? "west" : "east",
          pid: stub.terminal,
        });
      }
      // Only ports with a real terminal membership are usable.
      const names = new Set(terminals.map((t) => t.name));
      symbol.pins = symbol.pins.filter((p) => names.has(p.name));
      symbols.set(id, symbol);
      pinNamesBySymbol.set(id, new Set(symbol.pins.map((p) => p.name)));
      termPinByNode.set(node.key, map);
      continue;
    }

    const template = templateOf(node);
    if (!template) {
      warn(`node ${node.key} has no symbol template — left out`);
      continue;
    }
    const symbol = symbolForTemplate(template);
    const known = pinNamesBySymbol.get(symbol.id)!;
    const map =
      termPinByNode.get(node.key) ??
      new Map<
        string,
        { dx: number; dy: number; direction: ExchangeDirection; pid: string }
      >();

    for (const term of terminals) {
      const skinPin = node.device
        ? template.pins.find(
            (p) =>
              p.pid ===
              (DEVICE_PORT_MAP_SAFE(node.device!.kind)[term.name] ?? term.name),
          )
        : template.pins[0];
      if (!skinPin) {
        warn(
          `terminal ${term.name} of ${node.key} has no symbol pin — it is unwired in the export`,
        );
        continue;
      }
      const direction = directionOf(skinPin, template);
      map.set(term.name, {
        dx: skinPin.dx,
        dy: skinPin.dy,
        direction,
        pid: skinPin.pid,
      });
      if (!known.has(term.name)) {
        known.add(term.name);
        symbol.pins.push({
          name: term.name,
          x: round(skinPin.dx),
          y: round(skinPin.dy),
          direction,
          role: roleOf(term.name),
        });
      }
    }
    termPinByNode.set(node.key, map);
  }

  // ── Instances ─────────────────────────────────────────────────
  const instances: ExchangeInstance[] = [];
  const usedIds = new Set<string>();
  const instanceByNode = new Map<string, string>();
  const pinByInstance = new Map<string, Set<string>>();

  for (const node of nodes) {
    const pos = positions[node.key];
    if (!pos) continue;
    const template = templateOf(node);
    const symbolId =
      node.kind === "block"
        ? `mmo:block:${sanitizeId(node.key.replace(/^blk:/, ""))}`
        : template
          ? `mmo:${template.type}`
          : null;
    if (!symbolId || !symbols.has(symbolId)) continue;

    const base = sanitizeId(node.key);
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}_${n++}`;
    usedIds.add(id);
    instanceByNode.set(node.key, id);

    const orient = orientations[node.key];
    const size = node.size ?? {
      w: symbols.get(symbolId)!.width,
      h: symbols.get(symbolId)!.height,
    };
    const origin = orientedOrigin(pos, size, orient);
    const reference =
      node.kind === "io"
        ? node.label ?? node.key
        : node.kind === "block"
          ? node.label ?? node.key.replace(/^blk:/, "")
          : node.device?.instanceName ?? node.device?.id ?? node.key;
    const powerKind =
      node.kind !== "power"
        ? undefined
        : template?.type === "gnd"
          ? "gnd"
          : template?.type === "vee"
            ? "vee"
            : "vcc";
    const ioDirection =
      node.kind !== "io"
        ? undefined
        : node.ioDirection ??
          (template?.type === "outputExt" ? "output" : "input");

    instances.push({
      id,
      reference,
      symbolId,
      kind: node.kind,
      ...(node.kind === "block" && node.cellId && cellIds.has(node.cellId)
        ? { cellId: node.cellId }
        : {}),
      position: { x: round(origin.x), y: round(origin.y) },
      rotation: (orient?.rot ?? 0) as 0 | 90 | 180 | 270,
      mirror: mirrorOf(orient?.flip),
      sourceKey: node.key,
      ...(node.kind === "device"
        ? {
            ...(node.device ? { deviceKind: node.device.kind } : {}),
            ...(node.device && valueOfDevice(node.device, input.values)
              ? { value: valueOfDevice(node.device, input.values) }
              : {}),
            ...(node.device?.modelName ? { model: node.device.modelName } : {}),
            ...(node.device && parametersOfDevice(node.device)
              ? { parameters: parametersOfDevice(node.device) }
              : {}),
          }
        : {}),
      ...(powerKind ? { powerKind } : {}),
      ...(ioDirection ? { ioDirection } : {}),
    });

    const pins = pinNamesBySymbol.get(symbolId)!;
    pinByInstance.set(
      id,
      new Set([...pins].filter((p) => termPinByNode.get(node.key)?.has(p))),
    );
  }

  // ── Nets ──────────────────────────────────────────────────────
  const netMembers = new Map<number, ExchangeTerminalRef[]>();
  for (const node of nodes) {
    const instanceId = instanceByNode.get(node.key);
    if (!instanceId) continue;
    const pins = pinByInstance.get(instanceId)!;
    for (const term of nodeTerminals(node)) {
      if (term.netId < 0 || !pins.has(term.name)) continue;
      const list = netMembers.get(term.netId) ?? [];
      if (!list.some((r) => r.instance === instanceId && r.pin === term.name)) {
        list.push({ instance: instanceId, pin: term.name });
      }
      netMembers.set(term.netId, list);
    }
  }

  const nets: ExchangeNet[] = [];
  const netIdByNumber = new Map<number, string>();
  for (const netId of [...netMembers.keys()].sort((a, b) => a - b)) {
    const terminals = netMembers.get(netId)!;
    if (terminals.length === 0) continue;
    const name = namedNets.get(netId);
    const id = `net-${netId}`;
    netIdByNumber.set(netId, id);
    nets.push({ id, ...(name ? { name } : {}), terminals });
  }

  // ── Routes (one per routed, non-branched edge) ────────────────
  const resolvePinName = (nodeKey: string, raw: string): string | undefined => {
    const map = termPinByNode.get(nodeKey);
    if (!map) return undefined;
    if (map.has(raw)) return raw;
    for (const [term, info] of map) if (info.pid === raw) return term;
    return undefined;
  };
  const routes: ExchangeRoute[] = [];
  if (input.includeRoutes !== false) {
    const seen = new Set<string>();
    for (const [netId, wireData] of wires) {
      const neutralNet = netIdByNumber.get(netId);
      if (!neutralNet) continue;
      for (const edge of wireData.edges ?? []) {
        if (edge.fromKey === "__hub__" || edge.toKey === "__hub__") continue;
        const fromInstance = instanceByNode.get(edge.fromKey);
        const toInstance = instanceByNode.get(edge.toKey);
        if (!fromInstance || !toInstance) continue;
        // ELK edges carry skin port ids; drag-time re-routes carry mmo
        // terminal names. Accept either and normalise to the pin name.
        const fromPin = resolvePinName(edge.fromKey, edge.fromTerminal);
        const toPin = resolvePinName(edge.toKey, edge.toTerminal);
        if (!fromPin || !toPin) continue;
        if (!pinByInstance.get(fromInstance)?.has(fromPin)) continue;
        if (!pinByInstance.get(toInstance)?.has(toPin)) continue;
        const key = `${netId}|${fromInstance}|${fromPin}|${toInstance}|${toPin}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const line = edge.polylines[0] ?? [];
        if (edge.polylines.length > 1) {
          warn(`net ${netId}: kept the first polyline of a multi-segment edge`);
        }
        const bends =
          line.length > 2
            ? line.slice(1, -1).map((p) => ({ x: round(p.x), y: round(p.y) }))
            : [];
        routes.push({
          netId: neutralNet,
          from: { instance: fromInstance, pin: fromPin },
          to: { instance: toInstance, pin: toPin },
          bends,
        });
      }
    }
  }

  // ── Final tidy-up ─────────────────────────────────────────────
  // A symbol without pins is not loadable outside mmo; drop it (and its
  // instances) rather than emitting an invalid project.
  const dropped = new Set<string>();
  for (const symbol of symbols.values()) {
    if (symbol.pins.length > 0) continue;
    dropped.add(symbol.id);
    warn(`symbol ${symbol.name} has no resolvable pins — dropped`);
  }
  const keptInstances = instances.filter((i) => !dropped.has(i.symbolId));
  const keptIds = new Set(keptInstances.map((i) => i.id));
  const keptNets = nets
    .map((net) => ({
      ...net,
      terminals: net.terminals.filter((t) => keptIds.has(t.instance)),
    }))
    .filter((net) => net.terminals.length > 0);
  const keptNetIds = new Set(keptNets.map((n) => n.id));

  return {
    format: "mmo.schematic-layout",
    version: 1,
    generatedAt: now().toISOString(),
    source: {
      tool: "mmo-chip",
      scope: input.scopeKey,
      title: input.title ?? input.scopeKey,
    },
    grid,
    scale,
    symbols: [...symbols.values()].filter((s) => !dropped.has(s.id)),
    instances: keptInstances,
    nets: keptNets,
    routes: routes.filter(
      (r) =>
        keptNetIds.has(r.netId) &&
        keptIds.has(r.from.instance) &&
        keptIds.has(r.to.instance),
    ),
    ...(cells.length > 0 ? { cells } : {}),
    warnings,
  };
}

// ── Terminal → skin port mapping ────────────────────────────────

/**
 * Mirrors `DEVICE_PORT_MAP` in `netlist2svgFormat.ts`, duplicated here to
 * keep this module free of the export-only formatting helpers.
 */
function DEVICE_PORT_MAP_SAFE(kind: string): Record<string, string> {
  const map: Record<string, Record<string, string>> = {
    mos: { D: "D", G: "G", S: "S", B: "B" },
    bjt_npn: { C: "C", B: "B", E: "E", S: "S" },
    bjt_pnp: { C: "C", B: "B", E: "E", S: "S" },
    jfet_n: { D: "D", G: "G", S: "S" },
    jfet_p: { D: "D", G: "G", S: "S" },
    resistor: { PLUS: "A", MINUS: "B" },
    capacitor: { PLUS: "A", MINUS: "B" },
    diode: { PLUS: "+", MINUS: "-" },
    zener: { PLUS: "+", MINUS: "-" },
    schottky: { PLUS: "+", MINUS: "-" },
    inductor: { PLUS: "A", MINUS: "B" },
    voltage_source: { PLUS: "+", MINUS: "-" },
    current_source: { PLUS: "+", MINUS: "-" },
    power: { PLUS: "A" },
    __io: { Y: "Y" },
    __blockpin: { A: "A", Y: "Y" },
  };
  return map[kind] ?? {};
}
