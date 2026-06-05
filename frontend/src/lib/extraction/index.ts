/**
 * Cell-annotation → cell-description extraction library.
 *
 *   annotations ──extractCell──▶ CellExtraction
 *               ──inferDieNetlist──▶ DieNetlist
 *               ──generateVerilog──▶ Verilog source
 *
 * Call `loadClipper()` once before any extraction (it needs the WASM module).
 */

export {
  loadClipper,
  loadClipperWithBinary,
  getClipper,
  isClipperLoaded,
} from "./clipper";

export {
  shapeToPolygon,
  shapeBounds,
  polygonBounds,
  polygonsOverlap,
  UnionFind,
  SpatialIndex,
} from "./common";

export { extractCell, isTrivialCell } from "./cell";
export { formatBoolExpr, simplifyAggressive } from "./logic";
export { recognizeGate, gateLabel, gateArity } from "./gates";
export type { GateMatch, GateLit } from "./gates";
export type {
  BoolExpr,
  DiffusionType,
  ShapeRef,
  ExtractedShape,
  InferredDiffusion,
  Transistor,
  TransistorRole,
  TransmissionGate,
  CmosDomain,
  NetRole,
  ExtractedNet,
  ConnectingLayer,
  PortDirection,
  CellPort,
  SequentialAnalysis,
  WarningSeverity,
  ExtractionWarning,
  CellExtraction,
  InferredCellExtraction,
  PlaceholderCellExtraction,
} from "./cell";

export { inferDieNetlist } from "./netlist";
export type {
  DieNetlist,
  NetlistCellInstance,
  NetlistIoCell,
  NetlistWire,
  WireIoRole,
} from "./netlist";

export {
  generateVerilog,
  inferVerilogAST,
  formatExpr,
  lowerExpr,
  simplifyExpr,
  inlineAssigns,
  pruneUnusedWires,
} from "./verilog";
export type {
  VExpr,
  VPort,
  VStatement,
  VModule,
  VerilogDesign,
} from "./verilog";
