import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { readAnnotations, readDieRecord } from "../store.js";

// Output JPG side length. Each ROI is cropped from the source image and
// resized to this resolution.
export const ML_EXPORT_RESOLUTION = 512;

const ML_EXPORTS_SUBDIR = "ml_exports";
const ALL_CLASSES = ["point_via", "irregular_via", "trace"] as const;

type ManifestGeometry =
  | { kind: "point"; x: number; y: number }
  | { kind: "polyline"; points: { x: number; y: number }[] }
  | { kind: "rectangle"; x: number; y: number; width: number; height: number }
  | { kind: "polygon"; points: { x: number; y: number }[] };

interface ManifestAnnotation {
  class: "point_via" | "irregular_via" | "trace";
  geometry: ManifestGeometry;
}

interface ManifestIgnore {
  kind: "rectangle";
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RoiManifest {
  source_image: string;
  roi_bbox: [number, number, number, number];
  roi_classes: string[];
  ml_config: { point_via_size: number; trace_width: number };
  annotations: ManifestAnnotation[];
  ignore?: ManifestIgnore[];
  /** Overlay filename used as source, absent when base image was used. */
  source_overlay?: string;
}

export interface MLExportResult {
  exportDir: string;
  totalRois: number;
  sourceImage: string;
}

export async function runMLExport(params: {
  dataRoot: string;
  dieId: string;
  approxViaRadiusPx: number; // legacy fallback when mlConfig is absent
  overlayFilename?: string;
  logger?: (message: string) => void;
}): Promise<MLExportResult> {
  const { dataRoot, dieId, approxViaRadiusPx, overlayFilename, logger } = params;
  const log = logger ?? (() => {});

  const record = await readDieRecord(dataRoot, dieId);
  const annotations = await readAnnotations(dataRoot, dieId);
  const rois = annotations.rois ?? [];
  const humanAnnotations = annotations.annotations ?? [];
  const ignores = annotations.ignores ?? [];
  const nets = annotations.nets ?? [];
  const mlConfig = annotations.mlConfig ?? {
    pointViaSize: approxViaRadiusPx > 0 ? approxViaRadiusPx : 6,
    traceWidth: 4
  };

  // Determine source image path and dimensions
  let sourcePath: string;
  let sourceFilename: string;
  let sourceWidth: number;
  let sourceHeight: number;

  if (overlayFilename) {
    const overlayDir = path.join(dataRoot, "overlay-images", dieId);
    sourcePath = path.join(overlayDir, overlayFilename);
    sourceFilename = overlayFilename;
    const meta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
    sourceWidth = meta.width ?? record.width;
    sourceHeight = meta.height ?? record.height;
    log(`[ml-export] using overlay: ${overlayFilename} (${sourceWidth}×${sourceHeight})`);
  } else {
    sourcePath = record.originalPath;
    sourceFilename = record.originalFilename;
    sourceWidth = record.width;
    sourceHeight = record.height;
  }

  // nets is a node/edge graph; flatten to source-space segments once.
  const netSegments: { ax: number; ay: number; bx: number; by: number }[] = [];
  for (const net of nets) {
    const nodeById = new Map(net.nodes.map((n) => [n.id, n]));
    for (const e of net.edges) {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (a && b) netSegments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exportDirAbs = path.join(dataRoot, ML_EXPORTS_SUBDIR, `${record.name}-${timestamp}`);
  await fs.mkdir(exportDirAbs, { recursive: true });

  log(`[ml-export] ${dieId} → ${exportDirAbs} (${rois.length} ROIs, ${netSegments.length} net segments)`);

  // Coordinate transform: annotations are in base-image space; overlay may have different dimensions.
  // Scale factors map base-image coords → overlay coords when sizes differ.
  const scaleX = overlayFilename ? sourceWidth / record.width : 1;
  const scaleY = overlayFilename ? sourceHeight / record.height : 1;
  const ox = (x: number) => Math.round(x * scaleX);
  const oy = (y: number) => Math.round(y * scaleY);

  let written = 0;
  for (let i = 0; i < rois.length; i++) {
    const roi = rois[i];
    const roiX0 = Math.max(0, Math.round(roi.x));
    const roiY0 = Math.max(0, Math.round(roi.y));
    const roiX1 = Math.min(record.width, Math.round(roi.x + roi.width));
    const roiY1 = Math.min(record.height, Math.round(roi.y + roi.height));
    // Map to overlay coordinates
    const x0 = ox(roiX0);
    const y0 = oy(roiY0);
    const x1 = Math.min(sourceWidth, ox(roiX1));
    const y1 = Math.min(sourceHeight, oy(roiY1));
    const cropWidth = x1 - x0;
    const cropHeight = y1 - y0;
    if (cropWidth <= 0 || cropHeight <= 0) {
      log(`[ml-export]   roi_${i + 1} skipped (out of bounds)`);
      continue;
    }

    const jpgPath = path.join(exportDirAbs, `roi_${i + 1}.jpg`);
    const jsonPath = path.join(exportDirAbs, `roi_${i + 1}.json`);

    await sharp(sourcePath, { limitInputPixels: false, sequentialRead: true })
      .extract({ left: x0, top: y0, width: cropWidth, height: cropHeight })
      .resize({
        width: ML_EXPORT_RESOLUTION,
        height: ML_EXPORT_RESOLUTION,
        fit: "fill",
        kernel: sharp.kernel.lanczos3
      })
      .jpeg({ quality: 92 })
      .toFile(jpgPath);

    // fit:"fill" → x/y scale independently. Size driver uses the geometric
    // mean so it's fair under edge clipping (scaleX==scaleY when unclipped).
    const rScaleX = ML_EXPORT_RESOLUTION / cropWidth;
    const rScaleY = ML_EXPORT_RESOLUTION / cropHeight;
    const sizeScale = Math.sqrt(rScaleX * rScaleY);
    const sx = (x: number) => (x - x0) * rScaleX;
    // Map annotation coords from base-image → overlay space, then to ROI-local
    const annotX = (x: number) => sx(ox(x));
    const annotY = (y: number) => sy(oy(y));
    const sy = (y: number) => (y - y0) * rScaleY;
    const bboxHits = (
      pxMin: number, pyMin: number, pxMax: number, pyMax: number
    ) => !(pxMax <= roiX0 || pxMin >= roiX1 || pyMax <= roiY0 || pyMin >= roiY1);

    const roiClasses = roi.classes ?? [...ALL_CLASSES];
    const out: ManifestAnnotation[] = [];
    let pts = 0, regions = 0, traces = 0;

    // ── Authored point_via / irregular_via ──────────────────────────
    for (const a of humanAnnotations) {
      const g = a.geometry;
      if (a.class === "point_via" && g.kind === "point") {
        if (g.x >= roiX0 && g.x <= roiX1 && g.y >= roiY0 && g.y <= roiY1) {
          out.push({ class: "point_via", geometry: { kind: "point", x: annotX(g.x), y: annotY(g.y) } });
          pts += 1;
        }
      } else if (a.class === "irregular_via" && g.kind === "rectangle") {
        const rx0 = Math.max(roiX0, g.x);
        const ry0 = Math.max(roiY0, g.y);
        const rx1 = Math.min(roiX1, g.x + g.width);
        const ry1 = Math.min(roiY1, g.y + g.height);
        if (rx1 > rx0 && ry1 > ry0) {
          out.push({
            class: "irregular_via",
            geometry: {
              kind: "rectangle",
              x: annotX(rx0), y: annotY(ry0),
              width: (rx1 - rx0) * rScaleX * scaleX,
              height: (ry1 - ry0) * rScaleY * scaleY
            }
          });
          regions += 1;
        }
      } else if (a.class === "irregular_via" && g.kind === "polygon") {
        if (g.points.length < 3) continue;
        let pxMin = Infinity, pyMin = Infinity, pxMax = -Infinity, pyMax = -Infinity;
        for (const p of g.points) {
          pxMin = Math.min(pxMin, p.x); pyMin = Math.min(pyMin, p.y);
          pxMax = Math.max(pxMax, p.x); pyMax = Math.max(pyMax, p.y);
        }
        if (!bboxHits(pxMin, pyMin, pxMax, pyMax)) continue;
        out.push({
          class: "irregular_via",
          geometry: { kind: "polygon", points: g.points.map((p) => ({ x: annotX(p.x), y: annotY(p.y) })) }
        });
        regions += 1;
      }
    }

    // ── Traces materialized from nets (never persisted) ─────────────
    for (const s of netSegments) {
      const pxMin = Math.min(s.ax, s.bx), pxMax = Math.max(s.ax, s.bx);
      const pyMin = Math.min(s.ay, s.by), pyMax = Math.max(s.ay, s.by);
      if (!bboxHits(pxMin, pyMin, pxMax, pyMax)) continue;
      out.push({
        class: "trace",
        geometry: {
          kind: "polyline",
          points: [
            { x: annotX(s.ax), y: annotY(s.ay) },
            { x: annotX(s.bx), y: annotY(s.by) }
          ]
        }
      });
      traces += 1;
    }

    // ── Ignore rectangles clipped to the ROI ────────────────────────
    const ignore: ManifestIgnore[] = [];
    for (const r of ignores) {
      const rx0 = Math.max(roiX0, r.x);
      const ry0 = Math.max(roiY0, r.y);
      const rx1 = Math.min(roiX1, r.x + r.width);
      const ry1 = Math.min(roiY1, r.y + r.height);
      if (rx1 <= rx0 || ry1 <= ry0) continue;
      ignore.push({
        kind: "rectangle",
        x: annotX(rx0), y: annotY(ry0),
        width: (rx1 - rx0) * rScaleX * scaleX,
        height: (ry1 - ry0) * rScaleY * scaleY
      });
    }

    const manifest: RoiManifest = {
      source_image: sourceFilename,
      roi_bbox: [x0, y0, x1, y1],
      roi_classes: roiClasses,
      ml_config: {
        point_via_size: mlConfig.pointViaSize * sizeScale,
        trace_width: mlConfig.traceWidth * sizeScale
      },
      annotations: out,
      source_overlay: overlayFilename ?? undefined,
    };
    if (ignore.length > 0) manifest.ignore = ignore;

    await fs.writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    written += 1;
    log(`[ml-export]   roi_${i + 1}.jpg (${pts} pts, ${regions} regions, ${traces} trace segs, ${ignore.length} ignore) classes=[${roiClasses.join(",")}]`);
  }

  log(`[ml-export] ${dieId} done — wrote ${written}/${rois.length} ROIs`);

  return {
    exportDir: path.relative(dataRoot, exportDirAbs),
    totalRois: written,
    sourceImage: sourceFilename,
  };
}
