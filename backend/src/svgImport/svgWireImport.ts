import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import {
  listDieRecords,
  readAnnotations,
  readDieRecord,
  writeAnnotations
} from "../store.js";
import type {
  AnnotationNet,
  AnnotationNetEdge,
  AnnotationNetNode,
  AnnotationPoint,
  Cell,
  CellType,
  DieAnnotations,
  DieRecord
} from "../types.js";

export type SvgImportMode = "wires" | "cells" | "all";

interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}

interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

interface BackgroundImage {
  href: string | null;
  width: number;
  height: number;
  placement: Matrix2D;
}

interface CellGridPreset {
  cellsStartX: number;
  cellsStartY: number;
  cellWidthWithMargin: number;
  cellHeight: number;
}

interface CellClassification {
  chip: string;
  preset: CellGridPreset;
  typeByInstanceKey: Map<string, string>;
}

interface ImportedWireNet {
  name: string;
  nodes: AnnotationNetNode[];
  edges: AnnotationNetEdge[];
  pathCount: number;
}

interface ImportedCellTypePlan {
  key: string;
  baseName: string;
  name: string;
  width: number;
  height: number;
  instanceCount: number;
  sourceIds: string[];
}

interface ImportedCellPlan {
  sourceId: string;
  typeKey: string;
  baseTypeName: string;
  typeName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  column: string | null;
  row: number | null;
  snappedColumn: number | null;
  snappedRow: number | null;
}

export interface SvgImportPlan {
  die: DieRecord;
  svgPath: string;
  backgroundImage: BackgroundImage;
  mode: SvgImportMode;
  nets: ImportedWireNet[];
  cellTypes: ImportedCellTypePlan[];
  cells: ImportedCellPlan[];
  warnings: string[];
}

export async function importSvgData(params: {
  dataRoot: string;
  dieSelector: string;
  svgPath: string;
  mode: SvgImportMode;
  dryRun?: boolean;
  namePrefix?: string;
  chip?: string;
  identCellsPath?: string;
}) {
  const die = await resolveDie(params.dataRoot, params.dieSelector);
  const svg = await fs.readFile(params.svgPath, "utf8");
  const cellClassification = await loadCellClassification(params.identCellsPath, params.chip);
  const plan = planSvgImport({
    die,
    svg,
    svgPath: params.svgPath,
    mode: params.mode,
    namePrefix: params.namePrefix ?? "",
    cellClassification
  });

  if (!params.dryRun) {
    const annotations = await readAnnotations(params.dataRoot, die.id);
    const nextAnnotations = applyImportPlan(annotations, plan);
    await writeAnnotations(params.dataRoot, die.id, nextAnnotations);
  }

  return plan;
}

export function planSvgImport(params: {
  die: DieRecord;
  svg: string;
  svgPath: string;
  mode: SvgImportMode;
  namePrefix: string;
  cellClassification?: CellClassification;
}): SvgImportPlan {
  const root = parseXmlDocument(params.svg);
  const backgroundImage = findBackgroundImage(root);
  const svgToImage = invertMatrix(backgroundImage.placement);
  const warnings: string[] = [];

  const nets =
    params.mode === "wires" || params.mode === "all"
      ? planWireImport(root, svgToImage, params.die, backgroundImage, warnings, params.namePrefix)
      : [];

  const { cellTypes, cells } =
    params.mode === "cells" || params.mode === "all"
      ? planCellImport(
          root,
          svgToImage,
          params.die,
          backgroundImage,
          warnings,
          params.namePrefix,
          params.cellClassification
        )
      : { cellTypes: [], cells: [] };

  return {
    die: params.die,
    svgPath: params.svgPath,
    backgroundImage,
    mode: params.mode,
    nets,
    cellTypes,
    cells,
    warnings
  };
}

export function formatImportPlan(plan: SvgImportPlan) {
  const totalSegments = plan.nets.reduce((sum, net) => sum + net.edges.length, 0);
  const totalPaths = plan.nets.reduce((sum, net) => sum + net.pathCount, 0);
  const lines = [
    `Die: ${plan.die.name} (${plan.die.id}) ${plan.die.width}x${plan.die.height}`,
    `SVG: ${plan.svgPath}`,
    `Mode: ${plan.mode}`,
    `Background image: ${plan.backgroundImage.href ?? "<embedded image>"} ${plan.backgroundImage.width}x${plan.backgroundImage.height}`
  ];

  if (plan.mode === "wires" || plan.mode === "all") {
    lines.push(`Importable nets: ${plan.nets.length}`);
    lines.push(`Source paths: ${totalPaths}`);
    lines.push(`Imported segments: ${totalSegments}`);
    if (plan.nets.length > 0) {
      lines.push("Sample nets:");
      for (const net of plan.nets.slice(0, 10)) {
        lines.push(
          `  - ${net.name}: ${net.nodes.length} nodes, ${net.edges.length} edges, ${net.pathCount} paths`
        );
      }
    }
  }

  if (plan.mode === "cells" || plan.mode === "all") {
    lines.push(`Importable cell types: ${plan.cellTypes.length}`);
    lines.push(`Importable cells: ${plan.cells.length}`);
    if (plan.cellTypes.length > 0) {
      lines.push("Sample cell types:");
      for (const cellType of plan.cellTypes.slice(0, 10)) {
        lines.push(
          `  - ${cellType.name}: ${cellType.instanceCount} cells, ${cellType.width.toFixed(1)}x${cellType.height.toFixed(1)}`
        );
      }
    }
  }

  if (plan.warnings.length > 0) {
    lines.push(`Warnings: ${plan.warnings.length}`);
    for (const warning of plan.warnings.slice(0, 10)) {
      lines.push(`  - ${warning}`);
    }
  }

  return lines.join("\n");
}

function applyImportPlan(annotations: DieAnnotations, plan: SvgImportPlan): DieAnnotations {
  const importedNets: AnnotationNet[] = plan.nets.map((net) => ({
    id: crypto.randomUUID(),
    name: net.name,
    nodes: net.nodes,
    edges: net.edges
  }));

  const existingTypeKeyToId = new Map<string, string>();
  for (const cellType of annotations.cellTypes) {
    existingTypeKeyToId.set(normalizeCellTypeKey(cellType.name), cellType.id);
  }

  const importedCellTypes: CellType[] = [];
  for (const cellTypePlan of plan.cellTypes) {
    if (existingTypeKeyToId.has(cellTypePlan.key)) {
      continue;
    }

    const id = crypto.randomUUID();
    existingTypeKeyToId.set(cellTypePlan.key, id);
    importedCellTypes.push({
      id,
      name: cellTypePlan.name,
      cropRect: {
        x: 0,
        y: 0,
        width: cellTypePlan.width,
        height: cellTypePlan.height
      }
    });
  }

  const importedCells: Cell[] = plan.cells.map((cellPlan) => {
    const cellTypeId = existingTypeKeyToId.get(cellPlan.typeKey);
    if (!cellTypeId) {
      throw new Error(`Missing imported cell type for ${cellPlan.typeName}.`);
    }

    return {
      id: crypto.randomUUID(),
      cellTypeId,
      x: cellPlan.x,
      y: cellPlan.y
    };
  });

  return {
    ...annotations,
    nets: [...annotations.nets, ...importedNets],
    cellTypes: [...annotations.cellTypes, ...importedCellTypes],
    cells: [...annotations.cells, ...importedCells]
  };
}

async function resolveDie(dataRoot: string, selector: string) {
  try {
    return await readDieRecord(dataRoot, selector);
  } catch {
    const records = await listDieRecords(dataRoot);
    const exactNameMatches = records.filter((record) => record.name === selector);
    if (exactNameMatches.length === 1) {
      return exactNameMatches[0];
    }

    const partialMatches = records.filter(
      (record) => record.id.includes(selector) || record.name.includes(selector)
    );
    if (partialMatches.length === 1) {
      return partialMatches[0];
    }

    if (partialMatches.length > 1) {
      throw new Error(
        `Die selector "${selector}" is ambiguous. Matches: ${partialMatches.map((record) => `${record.name} (${record.id})`).join(", ")}`
      );
    }

    throw new Error(`Could not find a die matching "${selector}".`);
  }
}

function planWireImport(
  root: XmlNode,
  svgToImage: Matrix2D,
  die: DieRecord,
  image: BackgroundImage,
  warnings: string[],
  namePrefix: string
) {
  const wiresGroup = findLabeledGroup(root, "WIRES");
  if (!wiresGroup) {
    throw new Error("Could not find a WIRES group in the SVG.");
  }

  const nets: ImportedWireNet[] = [];
  const childBaseMatrix = matrixForNodePath(root, wiresGroup);
  let fallbackIndex = 1;

  for (const child of wiresGroup.children.filter((node) => node.name === "path" || node.name === "g")) {
    const label =
      child.attributes["inkscape:label"] ||
      child.attributes.id ||
      `imported-net-${fallbackIndex++}`;
    const name = `${namePrefix}${label}`;
    const collector = createNetCollector();
    const childMatrix = multiplyMatrix(childBaseMatrix, parseTransform(child.attributes.transform));

    if (child.name === "path") {
      const d = child.attributes.d;
      if (!d) {
        warnings.push(`Skipped path without "d" for net ${name}.`);
        continue;
      }
      appendPathToCollector({
        collector,
        pathData: d,
        transform: childMatrix,
        svgToImage,
        die,
        image,
        warnings,
        netName: name
      });
    } else {
      const descendantPaths = collectDescendantPaths(child, childMatrix);
      if (descendantPaths.length === 0) {
        warnings.push(`Skipped group ${name} because it contains no paths.`);
        continue;
      }
      for (const pathEntry of descendantPaths) {
        appendPathToCollector({
          collector,
          pathData: pathEntry.pathData,
          transform: pathEntry.transform,
          svgToImage,
          die,
          image,
          warnings,
          netName: name
        });
      }
    }

    if (collector.nodes.length === 0 || collector.edges.length === 0) {
      warnings.push(`Skipped net ${name} because no drawable segments were found.`);
      continue;
    }

    nets.push({
      name,
      nodes: collector.nodes,
      edges: collector.edges,
      pathCount: collector.pathCount
    });
  }

  return nets;
}

function planCellImport(
  root: XmlNode,
  svgToImage: Matrix2D,
  die: DieRecord,
  image: BackgroundImage,
  warnings: string[],
  namePrefix: string,
  cellClassification?: CellClassification
) {
  const cellsGroup = findLabeledGroup(root, "CELLS");
  if (!cellsGroup) {
    throw new Error("Could not find a CELLS group in the SVG.");
  }

  const baseMatrix = matrixForNodePath(root, cellsGroup);
  const cells: ImportedCellPlan[] = [];
  const typeBuckets = new Map<string, ImportedCellTypePlan>();
  const variantCountsByBaseType = new Map<string, number>();
  const provisionalCells: Array<{
    sourceId: string;
    baseTypeName: string;
    typeKey: string;
    x: number;
    y: number;
    width: number;
    height: number;
    column: string | null;
    row: number | null;
    snappedColumn: number | null;
    snappedRow: number | null;
  }> = [];

  for (const rectNode of cellsGroup.children.filter((node) => node.name === "rect")) {
    const width = parseRequiredNumber(rectNode.attributes.width, "cell rect width");
    const height = parseRequiredNumber(rectNode.attributes.height, "cell rect height");
    const x = parseOptionalNumber(rectNode.attributes.x, 0);
    const y = parseOptionalNumber(rectNode.attributes.y, 0);
    const transform = multiplyMatrix(baseMatrix, parseTransform(rectNode.attributes.transform));
    const topLeftSvg = applyMatrix(transform, { x, y });
    const topLeftImage = applyMatrix(svgToImage, topLeftSvg);
    const mappedWidth = (width / image.width) * die.width;
    const mappedHeight = (height / image.height) * die.height;
    const mappedX = clamp((topLeftImage.x / image.width) * die.width, 0, die.width);
    const mappedY = clamp((topLeftImage.y / image.height) * die.height, 0, die.height);

    const sourceId = rectNode.attributes.id || rectNode.attributes["inkscape:label"];
    if (!sourceId) {
      warnings.push("Skipped cell rect without an id.");
      continue;
    }

    const parsedId = parseCellSourceId(sourceId);
    const snappedPosition = snapCellPosition(topLeftSvg, cellClassification?.preset);
    const instanceKey =
      cellClassification && snappedPosition.column !== null && snappedPosition.row !== null
        ? `${cellClassification.chip}_${snappedPosition.column}_${snappedPosition.row}`
        : null;
    const classifiedType = instanceKey
      ? cellClassification?.typeByInstanceKey.get(instanceKey)
      : undefined;
    if (instanceKey && !classifiedType && cellClassification) {
      warnings.push(`No ident_cells match found for ${instanceKey}; falling back to SVG type from ${sourceId}.`);
    }

    const baseTypeName = `${namePrefix}${classifiedType ?? parsedId.type}`;
    const typeKey = normalizeCellTypeKey(baseTypeName);

    if (!typeBuckets.has(typeKey)) {
      typeBuckets.set(typeKey, {
        key: typeKey,
        baseName: baseTypeName,
        name: baseTypeName,
        width: mappedWidth,
        height: mappedHeight,
        instanceCount: 0,
        sourceIds: []
      });
      variantCountsByBaseType.set(
        baseTypeName,
        (variantCountsByBaseType.get(baseTypeName) ?? 0) + 1
      );
    }

    const typeBucket = typeBuckets.get(typeKey)!;
    typeBucket.instanceCount += 1;
    typeBucket.sourceIds.push(sourceId);

    provisionalCells.push({
      sourceId,
      typeKey,
      baseTypeName,
      x: mappedX,
      y: mappedY,
      width: mappedWidth,
      height: mappedHeight,
      column: parsedId.column,
      row: parsedId.row,
      snappedColumn: snappedPosition.column,
      snappedRow: snappedPosition.row
    });
  }

  for (const cellType of typeBuckets.values()) {
    const variantCount = variantCountsByBaseType.get(cellType.baseName) ?? 1;
    if (variantCount > 1) {
      warnings.push(`Cell type ${cellType.baseName} appeared in multiple geometry variants, but was kept merged by row/column classification.`);
    }
  }

  for (const cell of provisionalCells) {
    const typeBucket = typeBuckets.get(cell.typeKey);
    if (!typeBucket) {
      throw new Error(`Missing imported cell type for ${cell.sourceId}.`);
    }

    cells.push({
      sourceId: cell.sourceId,
      typeKey: typeBucket.key,
      baseTypeName: cell.baseTypeName,
      typeName: typeBucket.name,
      x: cell.x,
      y: cell.y,
      width: cell.width,
      height: cell.height,
      column: cell.column,
      row: cell.row,
      snappedColumn: cell.snappedColumn,
      snappedRow: cell.snappedRow
    });
  }

  return {
    cellTypes: [...typeBuckets.values()].sort((a, b) => a.name.localeCompare(b.name)),
    cells
  };
}

function parseCellSourceId(sourceId: string) {
  const parts = sourceId.split("_");
  if (parts.length >= 3) {
    const maybeRow = Number(parts[1]);
    if (Number.isFinite(maybeRow)) {
      return {
        column: parts[0],
        row: maybeRow,
        type: parts.slice(2).join("_")
      };
    }
  }

  return {
    column: null,
    row: null,
    type: sourceId
  };
}

function normalizeCellTypeKey(name: string) {
  return name.trim().toLowerCase();
}

function snapCellPosition(
  point: { x: number; y: number },
  preset: CellGridPreset | undefined
) {
  if (!preset) {
    return { column: null, row: null };
  }

  return {
    column: Math.round((point.x - preset.cellsStartX) / preset.cellWidthWithMargin),
    row: Math.round((point.y - preset.cellsStartY) / preset.cellHeight)
  };
}

async function loadCellClassification(
  identCellsPath: string | undefined,
  chip: string | undefined
): Promise<CellClassification | undefined> {
  if (!identCellsPath || !chip) {
    return undefined;
  }

  const preset = CELL_GRID_PRESETS[chip];
  if (!preset) {
    throw new Error(`No cell grid preset is configured for chip ${chip}.`);
  }

  const typeByInstanceKey = new Map<string, string>();
  const typeDirectories = await fs.readdir(identCellsPath, { withFileTypes: true });
  for (const directory of typeDirectories) {
    if (!directory.isDirectory()) {
      continue;
    }

    const typeName = directory.name;
    const directoryPath = `${identCellsPath}/${typeName}`;
    const files = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) {
        continue;
      }

      const match = /^(ic\d+_\d+_\d+)\.[^.]+$/i.exec(file.name);
      if (!match) {
        continue;
      }

      const instanceKey = match[1].toLowerCase();
      if (instanceKey.startsWith(`${chip.toLowerCase()}_`)) {
        typeByInstanceKey.set(instanceKey, typeName);
      }
    }
  }

  return {
    chip: chip.toLowerCase(),
    preset,
    typeByInstanceKey
  };
}

const CELL_GRID_PRESETS: Record<string, CellGridPreset> = {
  ic19: {
    cellsStartX: -3633,
    cellsStartY: -3256.87,
    cellWidthWithMargin: 349,
    cellHeight: 624.845 / 11
  }
};

function appendPathToCollector(params: {
  collector: ReturnType<typeof createNetCollector>;
  pathData: string;
  transform: Matrix2D;
  svgToImage: Matrix2D;
  die: DieRecord;
  image: BackgroundImage;
  warnings: string[];
  netName: string;
}) {
  const sampledPolylines = sampleSvgPath(params.pathData, params.warnings, params.netName);
  for (const polyline of sampledPolylines) {
    if (polyline.length < 2) {
      continue;
    }

    let previousNodeId: string | null = null;
    for (const point of polyline) {
      const svgPoint = applyMatrix(params.transform, point);
      const imagePoint = applyMatrix(params.svgToImage, svgPoint);
      const diePoint = mapImagePointToDie(imagePoint, params.image, params.die);
      const nodeId = getOrInsertPoint(params.collector, diePoint);
      if (previousNodeId !== null && previousNodeId !== nodeId) {
        params.collector.edges.push({
          id: crypto.randomUUID(),
          from: previousNodeId,
          to: nodeId
        });
      }
      previousNodeId = nodeId;
    }

    params.collector.pathCount += 1;
  }
}

function mapImagePointToDie(point: AnnotationPoint, image: BackgroundImage, die: DieRecord) {
  return {
    x: clamp((point.x / image.width) * die.width, 0, die.width),
    y: clamp((point.y / image.height) * die.height, 0, die.height)
  };
}

function createNetCollector() {
  return {
    nodes: [] as AnnotationNetNode[],
    edges: [] as AnnotationNetEdge[],
    nodeIdByKey: new Map<string, string>(),
    pathCount: 0
  };
}

function getOrInsertPoint(
  collector: ReturnType<typeof createNetCollector>,
  point: AnnotationPoint
) {
  const key = `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
  const existing = collector.nodeIdByKey.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const id = crypto.randomUUID();
  collector.nodes.push({ id, x: point.x, y: point.y });
  collector.nodeIdByKey.set(key, id);
  return id;
}

function collectDescendantPaths(node: XmlNode, parentTransform: Matrix2D) {
  const paths: Array<{ pathData: string; transform: Matrix2D }> = [];
  for (const child of node.children) {
    const transform = multiplyMatrix(parentTransform, parseTransform(child.attributes.transform));
    if (child.name === "path" && child.attributes.d) {
      paths.push({ pathData: child.attributes.d, transform });
      continue;
    }
    if (child.name === "g") {
      paths.push(...collectDescendantPaths(child, transform));
    }
  }
  return paths;
}

function findBackgroundImage(root: XmlNode): BackgroundImage {
  const imageNode = findNode(root, (node) => node.name === "image");
  if (!imageNode) {
    throw new Error("Could not find the embedded background image in the SVG.");
  }

  const width = parseRequiredNumber(imageNode.attributes.width, "image width");
  const height = parseRequiredNumber(imageNode.attributes.height, "image height");
  const x = parseOptionalNumber(imageNode.attributes.x, 0);
  const y = parseOptionalNumber(imageNode.attributes.y, 0);
  const placement = multiplyMatrix(
    matrixForNodePath(root, imageNode),
    { a: 1, b: 0, c: 0, d: 1, e: x, f: y }
  );

  return {
    href: imageNode.attributes["xlink:href"] ?? imageNode.attributes.href ?? null,
    width,
    height,
    placement
  };
}

function matrixForNodePath(root: XmlNode, target: XmlNode) {
  const path = findNodePath(root, target);
  if (!path) {
    throw new Error(`Could not resolve transform path for ${target.name}.`);
  }

  let matrix = identityMatrix();
  for (const node of path) {
    matrix = multiplyMatrix(matrix, parseTransform(node.attributes.transform));
  }
  return matrix;
}

function findNodePath(root: XmlNode, target: XmlNode, trail: XmlNode[] = []): XmlNode[] | null {
  if (root === target) {
    return trail;
  }

  for (const child of root.children) {
    const result = findNodePath(child, target, [...trail, child]);
    if (result) {
      return result;
    }
  }

  return null;
}

function findNode(node: XmlNode, predicate: (node: XmlNode) => boolean): XmlNode | null {
  if (predicate(node)) {
    return node;
  }
  for (const child of node.children) {
    const found = findNode(child, predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

function findLabeledGroup(root: XmlNode, label: string) {
  return findNode(
    root,
    (node) =>
      node.name === "g" &&
      (node.attributes.id === label || node.attributes["inkscape:label"] === label)
  );
}

function parseXmlDocument(source: string): XmlNode {
  const root: XmlNode = { name: "#document", attributes: {}, children: [] };
  const stack: XmlNode[] = [root];
  const tagPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[^>]+?>/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(source)) !== null) {
    const tag = match[0];
    if (tag.startsWith("<!--") || tag.startsWith("<?")) {
      continue;
    }
    if (tag.startsWith("</")) {
      stack.pop();
      continue;
    }

    const selfClosing = tag.endsWith("/>");
    const content = tag.slice(1, tag.length - (selfClosing ? 2 : 1)).trim();
    const nameMatch = /^([^\s/]+)/.exec(content);
    if (!nameMatch) {
      continue;
    }

    const name = nameMatch[1];
    const attributes = parseAttributes(content.slice(name.length));
    const node: XmlNode = { name, attributes, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      stack.push(node);
    }
  }

  const svgNode = root.children.find((node) => node.name === "svg");
  if (!svgNode) {
    throw new Error("Could not find the SVG root element.");
  }
  return svgNode;
}

function parseAttributes(source: string) {
  const attributes: Record<string, string> = {};
  const attributePattern = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(source)) !== null) {
    attributes[match[1]] = match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function parseTransform(value: string | undefined): Matrix2D {
  if (!value) {
    return identityMatrix();
  }

  const transformPattern = /([a-zA-Z]+)\(([^)]*)\)/g;
  let matrix = identityMatrix();
  let match: RegExpExecArray | null;
  while ((match = transformPattern.exec(value)) !== null) {
    const fn = match[1];
    const args = parseNumberList(match[2]);
    let next = identityMatrix();
    if (fn === "translate") {
      next = {
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        e: args[0] ?? 0,
        f: args[1] ?? 0
      };
    } else if (fn === "scale") {
      next = {
        a: args[0] ?? 1,
        b: 0,
        c: 0,
        d: args[1] ?? args[0] ?? 1,
        e: 0,
        f: 0
      };
    } else if (fn === "matrix" && args.length >= 6) {
      next = {
        a: args[0],
        b: args[1],
        c: args[2],
        d: args[3],
        e: args[4],
        f: args[5]
      };
    } else if (fn === "rotate") {
      const angle = ((args[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const cx = args[1] ?? 0;
      const cy = args[2] ?? 0;
      next = multiplyMatrix(
        multiplyMatrix(
          { a: 1, b: 0, c: 0, d: 1, e: cx, f: cy },
          { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
        ),
        { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy }
      );
    } else {
      throw new Error(`Unsupported transform function: ${fn}`);
    }

    matrix = multiplyMatrix(matrix, next);
  }

  return matrix;
}

function parseNumberList(input: string) {
  const matches = input.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g);
  return (matches ?? []).map(Number);
}

function sampleSvgPath(pathData: string, warnings: string[], netName: string) {
  const tokens = tokenizePath(pathData);
  const polylines: Array<Array<{ x: number; y: number }>> = [];
  let index = 0;
  let current = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };
  let currentPolyline: Array<{ x: number; y: number }> = [];
  let lastCommand = "";
  let lastCubicControl: { x: number; y: number } | null = null;
  let lastQuadControl: { x: number; y: number } | null = null;

  const pushPoint = (point: { x: number; y: number }) => {
    const previous = currentPolyline[currentPolyline.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) {
      currentPolyline.push(point);
    }
  };

  const finalizePolyline = () => {
    if (currentPolyline.length >= 2) {
      polylines.push(currentPolyline);
    }
    currentPolyline = [];
  };

  while (index < tokens.length) {
    const token = tokens[index];
    let command = token.type === "command" ? token.value : lastCommand;
    if (!command) {
      throw new Error(`Invalid SVG path data in net ${netName}: missing command.`);
    }
    if (token.type === "command") {
      index += 1;
      lastCommand = command;
    }

    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();

    if (upper === "M") {
      const x = readNumber(tokens, index++);
      const y = readNumber(tokens, index++);
      current = toPoint(current, x, y, relative);
      subpathStart = current;
      finalizePolyline();
      currentPolyline = [current];
      while (index < tokens.length && tokens[index].type !== "command") {
        const lineX = readNumber(tokens, index++);
        const lineY = readNumber(tokens, index++);
        current = toPoint(current, lineX, lineY, relative);
        pushPoint(current);
      }
      lastCubicControl = null;
      lastQuadControl = null;
      continue;
    }

    if (upper === "L") {
      const x = readNumber(tokens, index++);
      const y = readNumber(tokens, index++);
      current = toPoint(current, x, y, relative);
      pushPoint(current);
      lastCubicControl = null;
      lastQuadControl = null;
      continue;
    }

    if (upper === "H") {
      const x = readNumber(tokens, index++);
      current = { x: relative ? current.x + x : x, y: current.y };
      pushPoint(current);
      lastCubicControl = null;
      lastQuadControl = null;
      continue;
    }

    if (upper === "V") {
      const y = readNumber(tokens, index++);
      current = { x: current.x, y: relative ? current.y + y : y };
      pushPoint(current);
      lastCubicControl = null;
      lastQuadControl = null;
      continue;
    }

    if (upper === "C") {
      const x1 = readNumber(tokens, index++);
      const y1 = readNumber(tokens, index++);
      const x2 = readNumber(tokens, index++);
      const y2 = readNumber(tokens, index++);
      const x = readNumber(tokens, index++);
      const y = readNumber(tokens, index++);
      const control1 = toPoint(current, x1, y1, relative);
      const control2 = toPoint(current, x2, y2, relative);
      const target = toPoint(current, x, y, relative);
      for (const point of sampleCubic(current, control1, control2, target, 12)) {
        pushPoint(point);
      }
      current = target;
      lastCubicControl = control2;
      lastQuadControl = null;
      continue;
    }

    if (upper === "S") {
      const x2 = readNumber(tokens, index++);
      const y2 = readNumber(tokens, index++);
      const x = readNumber(tokens, index++);
      const y = readNumber(tokens, index++);
      const control1 =
        lastCommand.toUpperCase() === "C" || lastCommand.toUpperCase() === "S"
          ? reflectPoint(lastCubicControl ?? current, current)
          : current;
      const control2 = toPoint(current, x2, y2, relative);
      const target = toPoint(current, x, y, relative);
      for (const point of sampleCubic(current, control1, control2, target, 12)) {
        pushPoint(point);
      }
      current = target;
      lastCubicControl = control2;
      lastQuadControl = null;
      continue;
    }

    if (upper === "Q") {
      const x1 = readNumber(tokens, index++);
      const y1 = readNumber(tokens, index++);
      const x = readNumber(tokens, index++);
      const y = readNumber(tokens, index++);
      const control = toPoint(current, x1, y1, relative);
      const target = toPoint(current, x, y, relative);
      for (const point of sampleQuadratic(current, control, target, 12)) {
        pushPoint(point);
      }
      current = target;
      lastQuadControl = control;
      lastCubicControl = null;
      continue;
    }

    if (upper === "T") {
      const x = readNumber(tokens, index++);
      const y = readNumber(tokens, index++);
      const control: { x: number; y: number } =
        lastCommand.toUpperCase() === "Q" || lastCommand.toUpperCase() === "T"
          ? reflectPoint(lastQuadControl ?? current, current)
          : current;
      const target = toPoint(current, x, y, relative);
      for (const point of sampleQuadratic(current, control, target, 12)) {
        pushPoint(point);
      }
      current = target;
      lastQuadControl = control;
      lastCubicControl = null;
      continue;
    }

    if (upper === "A") {
      const rx = readNumber(tokens, index++);
      const ry = readNumber(tokens, index++);
      const _rotation = readNumber(tokens, index++);
      const _largeArc = readNumber(tokens, index++);
      const _sweep = readNumber(tokens, index++);
      const x = readNumber(tokens, index++);
      const y = readNumber(tokens, index++);
      const target = toPoint(current, x, y, relative);
      pushPoint(target);
      warnings.push(`Approximated arc as a straight line in net ${netName} (rx=${rx}, ry=${ry}).`);
      current = target;
      lastQuadControl = null;
      lastCubicControl = null;
      continue;
    }

    if (upper === "Z") {
      pushPoint(subpathStart);
      current = subpathStart;
      finalizePolyline();
      currentPolyline = [current];
      lastCubicControl = null;
      lastQuadControl = null;
      continue;
    }

    throw new Error(`Unsupported SVG path command ${command} in net ${netName}.`);
  }

  finalizePolyline();
  return polylines;
}

function tokenizePath(pathData: string) {
  const tokens: Array<{ type: "command" | "number"; value: string }> = [];
  const pattern = /([AaCcHhLlMmQqSsTtVvZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(pathData)) !== null) {
    if (match[1]) {
      tokens.push({ type: "command", value: match[1] });
    } else if (match[2]) {
      tokens.push({ type: "number", value: match[2] });
    }
  }
  return tokens;
}

function readNumber(tokens: Array<{ type: "command" | "number"; value: string }>, index: number) {
  const token = tokens[index];
  if (!token || token.type !== "number") {
    throw new Error("Invalid SVG path data: expected a number.");
  }
  return Number(token.value);
}

function toPoint(current: { x: number; y: number }, x: number, y: number, relative: boolean) {
  return {
    x: relative ? current.x + x : x,
    y: relative ? current.y + y : y
  };
}

function sampleCubic(
  start: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  end: { x: number; y: number },
  steps: number
) {
  const points: Array<{ x: number; y: number }> = [];
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const mt = 1 - t;
    points.push({
      x:
        mt ** 3 * start.x +
        3 * mt ** 2 * t * c1.x +
        3 * mt * t ** 2 * c2.x +
        t ** 3 * end.x,
      y:
        mt ** 3 * start.y +
        3 * mt ** 2 * t * c1.y +
        3 * mt * t ** 2 * c2.y +
        t ** 3 * end.y
    });
  }
  return points;
}

function sampleQuadratic(
  start: { x: number; y: number },
  control: { x: number; y: number },
  end: { x: number; y: number },
  steps: number
) {
  const points: Array<{ x: number; y: number }> = [];
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const mt = 1 - t;
    points.push({
      x: mt ** 2 * start.x + 2 * mt * t * control.x + t ** 2 * end.x,
      y: mt ** 2 * start.y + 2 * mt * t * control.y + t ** 2 * end.y
    });
  }
  return points;
}

function reflectPoint(control: { x: number; y: number }, current: { x: number; y: number }) {
  return {
    x: current.x * 2 - control.x,
    y: current.y * 2 - control.y
  };
}

function identityMatrix(): Matrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrix(left: Matrix2D, right: Matrix2D): Matrix2D {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f
  };
}

function invertMatrix(matrix: Matrix2D): Matrix2D {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(determinant) < 1e-12) {
    throw new Error("Could not invert the SVG background image transform.");
  }

  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant
  };
}

function applyMatrix(matrix: Matrix2D, point: { x: number; y: number }) {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f
  };
}

function parseRequiredNumber(value: string | undefined, label: string) {
  if (value === undefined) {
    throw new Error(`Missing ${label} in SVG.`);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw new Error(`Invalid ${label} in SVG: ${value}`);
  }
  return result;
}

function parseOptionalNumber(value: string | undefined, fallback: number) {
  if (value === undefined) {
    return fallback;
  }
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
