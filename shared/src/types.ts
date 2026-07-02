// ── Die metadata ──────────────────────────────────────────────────

export interface DieLevelMetadata {
  z: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  scale: number;
}

export interface DieTileProgress {
  totalTiles: number;
  completedTiles: number;
  percentage: number;
}

export interface DieSummary {
  id: string;
  name: string;
  originalFilename: string;
  width: number;
  height: number;
  tileSize: number;
  maxZoomLevel: number;
  createdAt: string;
  updatedAt: string;
  tileProgress?: DieTileProgress;
}

export interface DieMetadata extends DieSummary {
  tileFormat: "jpg" | "png";
  levels: DieLevelMetadata[];
}

// ── Annotations ───────────────────────────────────────────────────

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface AnnotationNetNode {
  id: string;
  x: number;
  y: number;
}

/** Conductor layer of a wire segment. Absent ⇒ "unknown" (the default).
 *  RE/verilog metadata only - ML trace derivation ignores material. */
export type WireLayer =
  | "poly"
  | "metal1" | "metal2" | "metal3" | "metal4" | "metal5" | "metal6";

export interface AnnotationNetEdge {
  id: string;
  from: string;
  to: string;
  /** Absent ⇒ unknown layer. Stamped per-segment at draw time; editable
   *  later from the inspector. Persisted verbatim inside the net. */
  layer?: WireLayer;
}

export interface AnnotationNet {
  id: string;
  name: string;
  nodes: AnnotationNetNode[];
  edges: AnnotationNetEdge[];
}

export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Cell layer annotations ────────────────────────────────────────

export type LayerType =
  | "diffusion"
  | "polysilicon"
  | "metal1"
  | "metal2"
  | "contact"
  | "via1"
  | "wire_hitbox"
  // ── Analog/BiCMOS extension layers ────────
  | "nwell"
  | "pwell"
  | "deep_nwell"
  | "buried_layer"
  | "base"
  | "emitter"
  | "collector_sinker"
  | "jfet_gate"
  | "jfet_channel"
  | "resistor_body"
  | "capacitor_bottom"
  | "capacitor_top"
  // Extended metal stack
  | "metal3"
  | "metal4"
  | "metal5"
  | "metal6"
  // Compound: user-drawn device boundary box
  | "device_box"
  // Resistor body: material-specific layers for type detection
  | "hsr"
  | "film"
  // Analog marker layers (simple RE mode)
  | "npn_id"
  | "pnp_id"
  | "lpnp_id"
  | "vpnp"
  | "res_id"
  | "cap_id"
  | "diode_id"
  // BJT terminal layers
  | "collector"
  // Bulk/well marker (used in BJT + MOS terminal defs)
  | "bulk";

/**
 * User-set role tag on a layer shape, scoped to interconnect (metals, polys,
 * contacts, vias). Propagates through extraction so the whole electrical net
 * the shape sits in gets this role (vcc / gnd / io / input / output) instead
 * of whatever the structural inference would have picked. `input` / `output`
 * exist as a manual escape hatch for cells the bridge-rule classifies wrong
 * (pass-transistor logic, transmission gates, unusual cells).
 *
 * NOT used on diffusion. Diffusion uses `forcedType` instead - historically
 * we conflated the two by reading `label === "vcc" / "gnd"` on diffusion as
 * a P/N override, but that confused the net-propagation step into shorting
 * the diffusion's whole sub-region net to a power rail.
 */
export type ShapeLabel = "vcc" | "gnd" | "io" | "input" | "output";

/**
 * Diffusion-only manual override for the body type. Bypasses the auto-
 * inference in step 3 of the cell extractor (which looks at which rail each
 * sub-region's contacts touch). Independent of `label` so a forced type
 * doesn't accidentally propagate as a net role.
 */
export type ForcedDiffusionType = "p" | "n";

/**
 * Arbitrary user-supplied name for the net this shape participates in
 * (e.g. "CLK", "Qbar", "STORAGE_NODE"). Lives on the shape so it
 * persists in the cellType document; propagates to the net at
 * extraction time exactly like `label` does. Distinct from `label` so
 * a custom name can coexist with a role assignment (e.g. label "vcc"
 * tags the net as a power rail for inference, customName "VDD_int"
 * controls how it's displayed in the schematic).
 */

export interface LayerRect {
  id: string;
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export interface LayerLine {
  id: string;
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export interface LayerPoint {
  id: string;
  kind: "point";
  x: number;
  y: number;
  size: number;
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export interface LayerCircle {
  id: string;
  kind: "circle";
  x: number;
  y: number;
  radius: number;
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export interface LayerPolygon {
  id: string;
  kind: "polygon";
  points: { x: number; y: number }[];
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export type LayerShape = LayerRect | LayerLine | LayerPoint | LayerCircle | LayerPolygon;

export type CellLayers = Partial<Record<LayerType, LayerShape[]>>;

export interface CellType {
  id: string;
  name: string;
  cropRect: AnnotationRect;
  layers?: CellLayers;
  /** True once promoted to a real, human-confirmed type via the merge-cells
   *  tool. Absent/false ⇒ an auto-created singleton placeholder (a cell that
   *  has only been labelled, not yet classified) - grouped under "Unmatched". */
  matched?: boolean;
  /** Contact shape IDs explicitly forced to be SOURCE terminals.
   *  When a MOS device's D terminal touches one of these contacts,
   *  D and S are swapped so the forced contact shows "S".
   *  Empty/absent = no overrides. */
  forcedSourceContacts?: string[];
}

export interface Cell {
  id: string;
  cellTypeId: string;
  x: number;
  y: number;
  /** Vertical mirror (existing). */
  flippedV?: boolean;
  /** Horizontal mirror, applied for display + ML export. Set while aligning
   *  a candidate in the merge-cells tool. */
  flippedH?: boolean;
  /** Orientation in degrees clockwise. Absent ⇒ 0. */
  rotation?: 0 | 90 | 180 | 270;
  /** Set true once this instance has been classified & confirmed by the user
   *  via the merge-cells tool (drives the candidate "done" checkmark). */
  merged?: boolean;
}

// ── Grid definitions ──────────────────────────────────────────────

export interface GridColumn {
  x: number;
  width: number;
}

export interface GridDefinition {
  id: string;
  name: string;
  columns: GridColumn[];
  rowHeight: number;
  columnOffsets: number[];
}

/**
 * Cell-placement guides. RE/layout aid only (not ML): the cell-rectangle
 * tool can snap its edges to these. A `line` is infinite (axis = the fixed
 * coordinate: "x" ⇒ vertical line at x=`pos`, "y" ⇒ horizontal at y=`pos`);
 * a `segment` is a finite axis-aligned span that only snaps when near.
 */
export type Guide =
  | { id: string; kind: "line"; axis: "x" | "y"; pos: number }
  | {
      id: string;
      kind: "segment";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    };

export interface IOPin {
  id: string;
  x: number;
  y: number;
  pin: number;
  name: string;
}

// ── ML annotations  ───────

export type GeometryKind = "point" | "polyline" | "rectangle" | "polygon";

export interface PointGeometry {
  kind: "point";
  x: number;
  y: number;
}
/** Trace width is chip-global (DieMLConfig.traceWidth), never per-segment. */
export interface PolylineGeometry {
  kind: "polyline";
  points: { x: number; y: number }[];
}
export interface RectangleGeometry {
  kind: "rectangle";
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PolygonGeometry {
  kind: "polygon";
  points: { x: number; y: number }[];
}
export type Geometry =
  | PointGeometry
  | PolylineGeometry
  | RectangleGeometry
  | PolygonGeometry;

export type AnnotationClass = "point_via" | "irregular_via" | "trace";
export type DecoderKind = "peak" | "region" | "skeleton";

export interface ClassDef {
  id: AnnotationClass;
  decoderKind: DecoderKind;
  /** Model output channel index. */
  channel: number;
  allowedGeometry: GeometryKind[];
  sizeSource: "pointViaSize" | "traceWidth" | null;
}

/** The shared contract. Both ends import this - never hardcode channel
 *  indices or class→geometry rules anywhere else. */
export const CLASS_REGISTRY: Record<AnnotationClass, ClassDef> = {
  point_via: {
    id: "point_via",
    decoderKind: "peak",
    channel: 0,
    allowedGeometry: ["point"],
    sizeSource: "pointViaSize"
  },
  irregular_via: {
    id: "irregular_via",
    decoderKind: "region",
    channel: 1,
    allowedGeometry: ["rectangle", "polygon"],
    sizeSource: null
  },
  trace: {
    id: "trace",
    decoderKind: "skeleton",
    channel: 2,
    allowedGeometry: ["polyline"],
    sizeSource: "traceWidth"
  }
};
export const NUM_CLASSES = 3;

/** Persisted classes are point_via | irregular_via only; `trace` is
 *  materialized from `nets` by the exporter, never stored here. */
export interface HumanAnnotation {
  id: string;
  class: AnnotationClass;
  geometry: Geometry;
  /** "approved" = a model prediction the user verified; default "human". */
  source?: "human" | "approved";
}

export interface ROIRectangle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Which classes this ROI fully labels (absent ⇒ all). Drives the
   *  per-channel loss mask so net-derived traces can't poison via-only ROIs. */
  classes?: AnnotationClass[];
}

/** Region the model must not score (any class) during training. */
export interface IgnoreRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DieMLConfig {
  /** Via radius in source px → Gaussian sigma = radius * 0.5. Chip-global. */
  pointViaSize: number;
  /** Default trace stroke width in source px. Chip-global. */
  traceWidth: number;
}

/** A ruler/measurement line drawn on the die image. Stores raw pixel start/end
 *  plus the μm length computed at draw time (cached so it survives zoom). */
// ── Floorplan Regions (Phase 2.1) ────────────────────────────────

export interface FloorplanRegion {
  id: string;
  /** User-assigned name, e.g. "VCC_UVLO" */
  name: string;
  kind: "rect" | "polygon";
  /** 2 points for rect, N points for polygon */
  geometry: { x: number; y: number }[];
  /** Stroke color */
  color: string;
  /** Who created this region (userId) */
  createdBy: string | null;
  /** Human-readable name of the creator */
  createdByName: string | null;
  createdAt: string | null;
  /** Optional: who reserved this region (userId) */
  reservedBy: string | null;
  /** Human-readable name of who reserved it */
  reservedByName: string | null;
  reservedAt: string | null;
  /** User-visible port name overrides: netId → alias */
  portAliases?: Record<number, string>;
}

// ── Comments (Phase 2.2) ────────────────────────────────────────

export interface CommentReply {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export interface CommentAnnotation {
  id: string;
  x: number;
  y: number;
  text: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  replies: CommentReply[];
}

export interface RulerMeasurement {
  id: string;
  name?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Pixel length at the time of drawing (cached). */
  lengthPx: number;
  /** μm length computed from umPerPx at draw time (cached). */
  lengthUm: number;
}

export interface DieAnnotations {
  version: 2;
  /** Monotonically incremented every time the annotations are written.
   *  Clients use it to spot stale caches when a WS notification arrives. */
  rev: number;
  nets: AnnotationNet[];
  cellTypes: CellType[];
  cells: Cell[];
  grids: GridDefinition[];
  pins?: IOPin[];
  mlConfig?: DieMLConfig;
  annotations?: HumanAnnotation[];
  rois?: ROIRectangle[];
  ignores?: IgnoreRect[];
  /** Cell-placement guides (RE aid, not ML). Absent ⇒ none. */
  guides?: Guide[];
  /** Die-level analog/mixed-signal layer annotations (Phase 1).
   *  Shapes drawn directly on the die image (not inside a cell type) for
   *  analog device detection. Same LayerType keys as CellType.layers:
   *  nwell, pwell, base, emitter, resistor_body, etc. */
  analogLayers?: CellLayers;
  /** Scale factor: micrometres per source-image pixel. Populated by the ruler
   *  tool's "Set scale" workflow. When set, measurements and device geometry
   *  calculations can report physical (μm) dimensions. */
  umPerPx?: number;
  /** Ruler measurements - persistent lines with annotated pixel length. */
  rulers?: RulerMeasurement[];
  /** User comments pinned to locations on the die (Phase 2.2). */
  comments?: CommentAnnotation[];
  /** Floorplan regions — functional block outlines (Phase 2.1). */
  floorplanRegions?: FloorplanRegion[];
}

export interface MLExportRequest {
  approxViaRadiusPx: number;
}

export interface MLExportResponse {
  exportDir: string;
  totalRois: number;
}

export interface MLVia {
  /** Source-image pixel coordinates (Node translates from crop-local). */
  x: number;
  y: number;
  /** Heatmap probability at the peak, in (threshold, 1]. */
  score: number;
}

/** irregular_via instance (ch1 connected component), source-image coords. */
export interface MLRegion {
  bbox: [number, number, number, number]; // x, y, w, h
  centroid: [number, number];
  area: number;
  score: number;
}

/** trace decode (ch2). Source-image coords. v1 = contour polyline; a true
 *  skeleton→graph is the later assisted-tracing phase. */
export interface MLTracePolyline {
  points: [number, number][];
}

export interface MLPrediction {
  pointVias: MLVia[];
  irregularVias: MLRegion[];
  traces: MLTracePolyline[];
  /** [x0, y0, x1, y1] in source-image pixels - the region this covers. */
  bbox: [number, number, number, number];
  /** Checkpoint the prediction came from; changes invalidate caches. */
  checkpointHash: string | null;
}

/** One native tile's cached prediction inside a batched range response. */
export interface MLViasTileResult {
  /** Native-level tile column / row. */
  x: number;
  y: number;
  prediction: MLPrediction;
}

/**
 * Batched ML-vias response: every *cached* tile in a native-tile range, in
 * one round-trip. Tiles with no cached prediction are simply omitted (the
 * client treats them as not-yet-computed). Replaces N per-tile requests.
 */
export interface MLViasTilesResponse {
  z: number;
  checkpointHash: string | null;
  tiles: MLViasTileResult[];
}

export interface MLTrainRequest {
  /** Dir containing rois/ (recursively). Relative paths resolve under the data root. */
  dataDir: string;
  epochs?: number;
  encoder?: string;
  lr?: number;
  cropSize?: number;
  stepsPerEpoch?: number;
  batchSize?: number;
  /** Checkpoint output path; defaults to the sidecar's resident checkpoint. */
  output?: string;
}

export interface MLTrainResponse {
  jobId: string;
}

export interface MLJobStatus {
  jobId: string;
  kind: "train" | "predict_die";
  status: "running" | "done" | "error";
  epoch?: number;
  epochs?: number;
  loss?: number | null;
  checkpointPath?: string | null;
  error?: string | null;
  startedAt?: string;
  updatedAt?: string;
}

/** Mirror of the Python sidecar's GET /health, surfaced via Node /api/ml/status. */
export interface MLServiceStatus {
  /** false when the sidecar is unreachable; the rest of the fields are then absent. */
  reachable: boolean;
  status?: string;
  device?: string;
  checkpoint?: string | null;
  checkpointHash?: string | null;
  encoder?: string;
  modelLoaded?: boolean;
  trainingActive?: boolean;
}

// ── ML inference jobs (Node-managed, per-die tile sweep) ──────────

export type MLInferenceJobStatus =
  | "running"
  | "stopped"
  | "completed"
  | "failed";

/**
 * A die-wide inference sweep. Node walks every native-zoom tile, runs the
 * sidecar, and caches each prediction. There is at most one job per die, so
 * the die id doubles as the job key. Stopping leaves the cache intact, so a
 * later start resumes from where it left off.
 */
export interface MLInferenceJob {
  dieId: string;
  status: MLInferenceJobStatus;
  /** Native-zoom tile grid total (columns × rows). */
  totalTiles: number;
  /** Tiles whose prediction JSON is cached on disk for `checkpointHash`. */
  completedTiles: number;
  /** 0-100, completedTiles / totalTiles. */
  percentage: number;
  /** Checkpoint hash the cached predictions belong to. */
  checkpointHash: string | null;
  /** Sidecar checkpoint filename in use when the job last ran. */
  model: string | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
}

/** A checkpoint file the sidecar can load. */
export interface MLModelInfo {
  /** Checkpoint filename, relative to the sidecar's checkpoints dir. */
  name: string;
  /** 12-char checkpoint hash, or null if unreadable. */
  hash: string | null;
  /** File size in bytes. */
  sizeBytes: number;
  /** True for the model currently resident in the sidecar. */
  resident: boolean;
}

export interface MLModelsResponse {
  models: MLModelInfo[];
}

export interface MLSelectModelRequest {
  /** Checkpoint name from MLModelInfo.name. */
  name: string;
}

// ── Import jobs ───────────────────────────────────────────────────

export type ImportJobStatus = "queued" | "running" | "completed" | "failed";

export type ImportJobPhase =
  | "queued"
  | "analyzing"
  | "tiling"
  | "persisting"
  | "completed"
  | "failed";

export interface ImportJob {
  id: string;
  type: "import-die";
  status: ImportJobStatus;
  originalFilename: string;
  mimeType: string;
  dieId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: ImportJobProgress;
}

export interface ImportJobProgress {
  phase: ImportJobPhase;
  message: string;
  totalLevels: number;
  completedLevels: number;
  currentLevel: number | null;
  currentLevelTiles: number;
  currentLevelProcessedTiles: number;
  totalTiles: number;
  processedTiles: number;
  percentage: number;
}

// ════════════════════════════════════════════════════════════════
// Analog / Mixed-Signal Extension (Phase 1 - MM0-CHIP fork)
// ════════════════════════════════════════════════════════════════

// ── Device kind ─────────────────────────────────────────────────

export type DeviceKind =
  | "mos"
  | "bjt_npn"
  | "bjt_pnp"
  | "jfet_n"
  | "jfet_p"
  | "resistor"
  | "capacitor"
  | "diode"
  | "zener"
  | "schottky"
  | "inductor"
  | "unknown";

// ── Device geometry parameters ──────────────────────────────────

export interface DeviceGeometryMOS {
  /** Physical gate length (poly width crossing diffusion) [μm] */
  L_um: number;
  /** Physical gate width (diffusion edge along poly) [μm] */
  W_um: number;
  /** Number of parallel gate fingers */
  fingers: number;
  /** Multiplier - number of cell repeats */
  multiplier: number;
  /** Effective total width = W × fingers × multiplier [μm] */
  totalW_um: number;
  /** Transistor type */
  mosType: "pmos" | "nmos" | "unknown";
}

export interface DeviceGeometryBJT {
  /** Emitter area [μm2] */
  AE_um2: number;
  /** Emitter perimeter [μm] */
  PE_um: number;
  /** Multiplier */
  multiplier: number;
  /** Total AE = AE × multiplier [μm2] */
  totalAE_um2: number;
  /** Number of emitter stripes */
  emitterFingers: number;
  /** Transistor type */
  bjtType: "npn" | "pnp" | "unknown";
}

export interface DeviceGeometryJFET {
  /** Channel width [μm] */
  W_um: number;
  /** Channel length [μm] */
  L_um: number;
  /** Fingers */
  fingers: number;
  /** Multiplier */
  multiplier: number;
  /** JFET type */
  jfetType: "njf" | "pjf" | "unknown";
}

/** Resistor material type - determines default sheetR. */
export type ResistorType = "poly" | "hsr" | "pb" | "npl" | "film";

export interface DeviceGeometryResistor {
  /** Physical body length [μm] */
  L_um: number;
  /** Physical body width [μm] */
  W_um: number;
  /** Number of squares = L / W */
  squares: number;
  /** User-supplied sheet resistance [Ω/□] */
  sheetR_ohms?: number;
  /** Resistance = squares × sheetR [Ω] */
  resistance_ohms?: number;
  /** Fingers (parallel segments) */
  fingers: number;
  /** Multiplier */
  multiplier: number;
  /** Body shape */
  shape?: "straight" | "meander" | "serpentine" | "unknown";
  /** Resistor material type. Defaults to "poly" (polysilicon). */
  resistorType?: ResistorType;
}

export interface DeviceGeometryCapacitor {
  /** Plate overlap area [μm2] */
  area_um2: number;
  /** Perimeter of bottom plate [μm] */
  perimeter_um: number;
  /** User-supplied capacitance density [fF/μm2] */
  capDensity_fF?: number;
  /** Capacitance = area × capDensity [fF] */
  capacitance_fF?: number;
  /** Multiplier */
  multiplier: number;
  /** Capacitor type */
  capType?: "mim" | "pip" | "mos" | "metal_metal" | "unknown";
}

export interface DeviceGeometryDiode {
  /** Junction area [μm2] */
  area_um2: number;
  /** Junction perimeter [μm] */
  perimeter_um: number;
  /** Multiplier */
  multiplier: number;
  /** Diode type */
  diodeType?: "pn" | "schottky" | "zener" | "unknown";
}

export type DeviceGeometry =
  | DeviceGeometryMOS
  | DeviceGeometryBJT
  | DeviceGeometryJFET
  | DeviceGeometryResistor
  | DeviceGeometryCapacitor
  | DeviceGeometryDiode;

// ── Terminal connection ─────────────────────────────────────────

export interface DeviceTerminal {
  /** Terminal name (e.g. "D", "G", "S", "B" for MOS) */
  name: string;
  /** Die-level net id this terminal connects to */
  netId: number;
  /**
   * IDs of cell-type layer shapes that belong to this terminal.
   * Used by resolveDeviceContacts to only match contacts that physically
   * sit inside this device's shapes, not another device's shapes in the
   * same cell type.
   */
  shapeIds?: string[];
}

// ── Analog device ───────────────────────────────────────────────

export interface AnalogDevice {
  id: string;
  /** Type of device */
  kind: DeviceKind;
  /** Extracted geometry parameters */
  geometry: DeviceGeometry;
  /** Cell-type this device belongs to (empty string = die-level) */
  cellTypeId: string;
  /** Instance name for SPICE netlist (e.g. M1, Q12, R34) */
  instanceName?: string;
  /** SPICE model name */
  modelName?: string;
  /** Terminal connections */
  terminals: DeviceTerminal[];
  /** Outline polygon in cell-local coordinates */
  outline?: { x: number; y: number }[];
  /** Bounding box */
  bbox?: AnnotationRect;
  /** User comment */
  comment?: string;
}

// ── SPICE configuration ─────────────────────────────────────────

export interface SpiceConfig {
  /** Technology name for .MODEL cards */
  technology?: string;
  /** Sheet resistance per layer [Ω/□] */
  sheetR_ohms?: Record<string, number>;
  /** Capacitance density per layer pair [fF/μm2] */
  capDensity_fF?: Record<string, number>;
  /** SPICE model definitions (modelName → .MODEL card) */
  models?: Record<string, string>;
  /** Default VDD net name */
  vdd?: string;
  /** Default GND net name */
  gnd?: string;
  /** Scale factor - μm per pixel */
  umPerPx?: number;
  /** Resistor value format.
   *  - "ohms":  r=2500       (resolved resistance)
   *  - "sqRs":  r=10*250     (squares × sheetR, as expression)
   *  Default: "ohms". */
  resistorFormat?: "ohms" | "sqRs";
  /**
   * Device geometry matching tolerance in percent.
   * Devices with similar W/L/AE/PE within this tolerance get their
   * geometry averaged to produce consistent instance parameters.
   * 0 = disabled (default).
   */
  matchTolerancePercent?: number;
}

// ── Export request / response ───────────────────────────────────

export type SpiceDialect = "cdl" | "spectre" | "hspice";

export interface AnalogExportRequest {
  /** SPICE dialect */
  dialect: SpiceDialect;
  /** Generate hierarchical subcircuits */
  hierarchical: boolean;
  /** Override SPICE config */
  spiceConfig?: SpiceConfig;
}

export interface AnalogExportResponse {
  /** Path to the generated netlist file */
  netlistPath: string;
  /** Number of devices extracted */
  deviceCount: number;
  /** Count per device kind */
  byKind: Record<string, number>;
  /** Extraction/export warnings */
  warnings: string[];
}

// ── Analog device detection job ─────────────────────────────────

export interface AnalogDetectionJob {
  dieId: string;
  status: "running" | "completed" | "failed";
  progress: number; // 0-100
  deviceCount: number;
  warnings: string[];
  startedAt: string | null;
  finishedAt: string | null;
}
