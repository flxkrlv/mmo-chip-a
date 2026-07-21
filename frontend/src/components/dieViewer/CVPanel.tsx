import { useState } from "react";
import type { DieAnnotations } from "shared";
import type { ActionDispatcher } from "../../api/actions";
import { uuid } from "../../lib/uuid";
import { useOverlayLayers } from "../../state/overlayLayers";
import { useDieViewerStore } from "../../state/dieViewer";
import { cvDebug, cvDebugDump, cvMatch, cvTemplateDebug, cvTemplateMatch } from "../../api/ml";

function useRefCell(annotations: DieAnnotations | undefined) {
  const selectedIds = useDieViewerStore((s) => s.selectedIds);
  const selectedCellId = [...selectedIds].find((id) => id.startsWith("cell:"))?.slice(5);
  const cell = annotations?.cells?.find((c) => c.id === selectedCellId);
  const type = cell
    ? annotations?.cellTypes?.find((ct) => ct.id === cell.cellTypeId)
    : null;
  return { cell, type };
}

function NoRefHint() {
  return (
    <div className="m" style={{ fontSize: 10.5, color: "var(--ink3)", marginBottom: 10 }}>
      Select a cell on the die to use as reference for CV detection.
    </div>
  );
}

function RefHeader({ name, width, height }: { name: string; width: number; height: number }) {
  return (
    <div className="m" style={{ fontSize: 10.5, color: "var(--ink2)", marginBottom: 10 }}>
      Reference: <span className="u">{name}</span>
      <br />
      Crop: {Math.round(width)}×{Math.round(height)} px
    </div>
  );
}

function StatusLine({ result, err }: { result: { count: number } | null; err: string | null }) {
  return (
    <>
      {result && (
        <div className="m" style={{ marginTop: 8, fontSize: 10.5, color: "var(--ink2)" }}>
          Found {result.count} matches — placed as ML-detected cells.
        </div>
      )}
      {err && (
        <div className="m" style={{ marginTop: 8, fontSize: 10.5, color: "var(--danger, #e36854)" }}>
          {err}
        </div>
      )}
    </>
  );
}

function dispatchMatch(
  dispatcher: ActionDispatcher,
  cellTypeId: string,
  cropW: number,
  cropH: number,
  minConfidence: number,
  m: {
    x: number;
    y: number;
    rotation: 0 | 90 | 180 | 270;
    confidence: number;
  }
) {
  if (m.confidence < minConfidence) return;
  void dispatcher.dispatch({
    kind: "upsertCell",
    cell: {
      id: uuid(),
      cellTypeId,
      x: Math.round(m.x - cropW / 2),
      y: Math.round(m.y - cropH / 2),
      rotation: m.rotation,
      mlDetected: true,
      mlConfidence: m.confidence,
    },
    prevCell: null,
  });
}

function visibleOverlayName(): string | undefined {
  const ov = useOverlayLayers.getState().layers.find((l) => !l.hidden && l.loaded);
  return ov?.name;
}

// ── Template section (stable, no changes from prior behavior) ────────

function TemplateSection({
  dieId,
  annotations,
  dispatcher
}: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
}) {
  const { cell, type } = useRefCell(annotations);
  const [running, setRunning] = useState(false);
  const [threshold, setThreshold] = useState(0.5);
  const [rotationSteps, setRotationSteps] = useState(4);
  const [maxMatches, setMaxMatches] = useState(100);
  const [sobelKsize, setSobelKsize] = useState(3);
  const [nmsIou, setNmsIou] = useState(0.3);
  const [nmsDist, setNmsDist] = useState(30);
  const [result, setResult] = useState<{ count: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showTmAdvanced, setShowTmAdvanced] = useState(false);
  const [showTmDebug, setShowTmDebug] = useState(false);
  const [tmDebugData, setTmDebugData] = useState<import("shared").CVDebugData | null>(null);
  const [tmDebugLoading, setTmDebugLoading] = useState(false);

  const ready = !!dieId && !!cell && !!type;

  const run = async () => {
    if (!ready) return;
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const res = await cvTemplateMatch({
        dieId: dieId!,
        cellTypeId: type!.id,
        cellX: cell!.x,
        cellY: cell!.y,
        overlayFilename: visibleOverlayName(),
        threshold,
        rotationSteps,
        maxMatches,
        sobelKsize,
        nmsIou,
        nmsDist,
      });
      for (const m of res.matches) {
        dispatchMatch(dispatcher, type!.id, type!.cropRect.width, type!.cropRect.height, threshold, {
          x: m.x,
          y: m.y,
          rotation: m.rotation,
          confidence: m.confidence,
        });
      }
      setResult({ count: res.matches.length });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Template matching failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      {!cell && <NoRefHint />}
      {cell && type && (
        <>
          <RefHeader name={type.name} width={type.cropRect.width} height={type.cropRect.height} />

          <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
            <span className="u" style={{ fontSize: 10 }}>Min confidence</span>
            <span className="m" style={{ fontSize: 11, color: "var(--ink2)" }}>{threshold.toFixed(2)}</span>
          </div>
          <input
            type="range" min={0} max={1} step={0.01}
            value={threshold}
            style={{ width: "100%", marginBottom: 8 }}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />

          <div className="row" style={{ gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="u" style={{ fontSize: 10, alignSelf: "center" }}>Rotation</span>
            {[1, 2, 4].map((n) => (
              <button
                key={n}
                type="button"
                className={"chip" + (rotationSteps === n ? " on" : "")}
                style={{ cursor: "pointer" }}
                onClick={() => setRotationSteps(n)}
              >
                {n === 4 ? "0°/90°/180°/270°" : n === 2 ? "0°/180°" : "0°"}
              </button>
            ))}
          </div>

          <div className="row" style={{ gap: 4, alignItems: "center", marginBottom: 10 }}>
            <span className="u" style={{ fontSize: 10 }}>Max matches</span>
            <input
              type="number" min={1} max={10000}
              value={maxMatches}
              style={{ width: 60, padding: "2px 4px", fontSize: 11, fontFamily: "var(--mono)", background: "var(--panel)", color: "var(--ink)", border: "1px solid var(--l2)", borderRadius: 4 }}
              onChange={(e) => setMaxMatches(Math.max(1, Number(e.target.value)))}
            />
          </div>

          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer" }}
            disabled={!ready || running}
            onClick={() => void run()}
          >
            {running ? "Running template match…" : "Run template matching"}
          </button>
          <StatusLine result={result} err={err} />

          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer", marginTop: 6, opacity: 0.55, fontSize: 10 }}
            onClick={() => setShowTmAdvanced(!showTmAdvanced)}
          >
            {showTmAdvanced ? "▾ Advanced params" : "▸ Advanced params"}
          </button>

          {showTmAdvanced && (
            <div style={{ marginBottom: 8, padding: "6px 8px", background: "var(--l1)", borderRadius: 4, fontSize: 10 }}>
              <SliderRow label="Sobel kernel" value={sobelKsize}
                min={1} max={7} step={2}
                format={(v) => `${v}`}
                onChange={setSobelKsize} />
              <SliderRow label="NMS IoU" value={nmsIou}
                min={0.05} max={0.8} step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={setNmsIou} />
              <SliderRow label="NMS dist (px)" value={nmsDist}
                min={5} max={200} step={5}
                format={(v) => `${v}`}
                onChange={setNmsDist} />
            </div>
          )}

          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer", marginTop: 6, opacity: 0.6 }}
            disabled={!ready || tmDebugLoading}
            onClick={async () => {
              if (showTmDebug) { setShowTmDebug(false); return; }
              setTmDebugLoading(true);
              setTmDebugData(null);
              try {
                const data = await cvTemplateDebug({
                  dieId: dieId!,
                  cellTypeId: type!.id,
                  cellX: cell!.x,
                  cellY: cell!.y,
                  overlayFilename: visibleOverlayName(),
                  threshold,
                  rotationSteps,
                  maxMatches,
                  sobelKsize,
                  nmsIou,
                  nmsDist,
                });
                setTmDebugData(data as import("shared").CVDebugData);
                setShowTmDebug(true);
              } catch (e) {
                setErr(e instanceof Error ? e.message : "template debug failed");
              } finally {
                setTmDebugLoading(false);
              }
            }}
          >
            {tmDebugLoading ? "Loading template debug…" : showTmDebug ? "Hide template debug" : "Debug template"}
          </button>

          {showTmDebug && tmDebugData && (
            <div style={{ marginTop: 8, fontSize: 10, color: "var(--ink2)" }}>
              <div className="m" style={{ marginBottom: 4 }}>
                Pre-NMS peaks: {tmDebugData.pre_nms_peaks ?? "?"} ·{" "}
                Candidates: {tmDebugData.total_candidates}
              </div>
              {(tmDebugData as any).search_edges_png_b64 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="u" style={{ fontSize: 9, marginBottom: 2 }}>Sobel edges</div>
                  <img
                    src={`data:image/jpeg;base64,${(tmDebugData as any).search_edges_png_b64}`}
                    alt="sobel edges"
                    style={{ maxWidth: "100%", borderRadius: 3 }}
                  />
                </div>
              )}
              {(tmDebugData as any).ref_template_png_b64 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="u" style={{ fontSize: 9, marginBottom: 2 }}>Reference template (Sobel)</div>
                  <img
                    src={`data:image/png;base64,${(tmDebugData as any).ref_template_png_b64}`}
                    alt="ref template"
                    style={{ maxWidth: "100%", borderRadius: 3 }}
                  />
                </div>
              )}
              {tmDebugData.search_preview_png_b64 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="u" style={{ fontSize: 9, marginBottom: 2 }}>
                    Search preview (colors = rotation angles)
                  </div>
                  <img
                    src={`data:image/jpeg;base64,${tmDebugData.search_preview_png_b64}`}
                    alt="search preview"
                    style={{ maxWidth: "100%", borderRadius: 3 }}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Contour section (tree-based, experimental) ───────────────────────

function ContourSection({
  dieId,
  annotations,
  dispatcher
}: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
}) {
  const { cell, type } = useRefCell(annotations);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ count: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [debugData, setDebugData] = useState<import("shared").CVDebugData | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);

  const [detectionMode, setDetectionMode] = useState<"canny" | "threshold" | "gradient">("threshold");
  const [gradientKernel, setGradientKernel] = useState(5);
  const [threshold, setThreshold] = useState(0.5);
  const [maxMatches, setMaxMatches] = useState(100);
  const [minArea, setMinArea] = useState(5000);
  const [minDistance, setMinDistance] = useState(15);
  const [areaLo, setAreaLo] = useState(0.6);
  const [areaHi, setAreaHi] = useState(1.8);
  const [aspectThresh, setAspectThresh] = useState(0.5);
  const [mergeDistPx, setMergeDistPx] = useState(20);
  const [mergeAreaRatio, setMergeAreaRatio] = useState(0.5);
  const [efdHarmonics, setEfdHarmonics] = useState(5);
  const [fuzzyThresh, setFuzzyThresh] = useState(1.2);
  const [minRefChildren, setMinRefChildren] = useState(2);
  const [structThresh, setStructThresh] = useState(0.2);
  const [rotationMinMatches, setRotationMinMatches] = useState(2);
  const [wShape, setWShape] = useState(0.6);
  const [wArea, setWArea] = useState(1.0);
  const [wBbox, setWBbox] = useState(1.0);
  const [wPos, setWPos] = useState(0.5);

  const ready = !!dieId && !!cell && !!type;

  const run = async () => {
    if (!ready) return;
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const res = await cvMatch({
        dieId: dieId!,
        cellTypeId: type!.id,
        cellX: cell!.x,
        cellY: cell!.y,
        overlayFilename: visibleOverlayName(),
        threshold,
        maxMatches,
        detectionMode,
        gradientKernel,
        minArea,
        minDistance,
        areaLo,
        areaHi,
        aspectThresh,
        mergeDistPx,
        mergeAreaRatio,
        efdHarmonics,
        fuzzyThresh,
        minRefChildren,
        structThresh,
        rotationMinMatches,
        wShape,
        wArea,
        wBbox,
        wPos,
      });
      for (const m of res.matches) {
        dispatchMatch(dispatcher, type!.id, type!.cropRect.width, type!.cropRect.height, threshold, {
          x: m.x,
          y: m.y,
          rotation: m.rotation,
          confidence: m.confidence,
        });
      }
      setResult({ count: res.matches.length });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Contour detection failed");
    } finally {
      setRunning(false);
    }
  };

  const runDebug = async () => {
    if (!ready) return;
    setDebugLoading(true);
    setErr(null);
    try {
      const data = await cvDebug({
        dieId: dieId!,
        cellTypeId: type!.id,
        cellX: cell!.x,
        cellY: cell!.y,
        overlayFilename: visibleOverlayName(),
        threshold,
        maxMatches,
        detectionMode,
        gradientKernel,
        minArea,
        minDistance,
        areaLo,
        areaHi,
        aspectThresh,
        mergeDistPx,
        mergeAreaRatio,
        efdHarmonics,
        fuzzyThresh,
        minRefChildren,
        structThresh,
        rotationMinMatches,
        wShape,
        wArea,
        wBbox,
        wPos,
      });
      setDebugData(data);
      setShowDebug(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "debug failed");
    } finally {
      setDebugLoading(false);
    }
  };

  const runDump = async () => {
    if (!ready) return;
    try {
      const r = await cvDebugDump({
        dieId: dieId!,
        cellTypeId: type!.id,
        cellX: cell!.x,
        cellY: cell!.y,
        overlayFilename: visibleOverlayName(),
        threshold,
        maxMatches,
        detectionMode,
        gradientKernel,
        minArea,
        minDistance,
        areaLo,
        areaHi,
        aspectThresh,
        mergeDistPx,
        mergeAreaRatio,
        efdHarmonics,
        fuzzyThresh,
        minRefChildren,
        structThresh,
        rotationMinMatches,
        wShape,
        wArea,
        wBbox,
        wPos,
      });
      setErr(`Debug dumped to ${r.dump_path}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "dump failed");
    }
  };

  return (
    <div>
      {!cell && <NoRefHint />}
      {cell && type && (
        <>
          <RefHeader name={type.name} width={type.cropRect.width} height={type.cropRect.height} />

          <div className="m" style={{ fontSize: 9.5, color: "var(--ink3)", marginBottom: 8, fontStyle: "italic" }}>
            Tree-based matching: extracts pocket→base→emitter hierarchy and
            recovers rotation from the matched children's axes. Experimental.
          </div>

          <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
            <span className="u" style={{ fontSize: 10 }}>Min confidence</span>
            <span className="m" style={{ fontSize: 11, color: "var(--ink2)" }}>{threshold.toFixed(2)}</span>
          </div>
          <input
            type="range" min={0} max={1} step={0.01}
            value={threshold}
            style={{ width: "100%", marginBottom: 8 }}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />

          <div className="row" style={{ gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="u" style={{ fontSize: 10, alignSelf: "center" }}>Binarization</span>
            <button
              type="button"
              className={"chip" + (detectionMode === "canny" ? " on" : "")}
              style={{ cursor: "pointer" }}
              onClick={() => setDetectionMode("canny")}
            >
              Canny
            </button>
            <button
              type="button"
              className={"chip" + (detectionMode === "threshold" ? " on" : "")}
              style={{ cursor: "pointer" }}
              onClick={() => setDetectionMode("threshold")}
            >
              Threshold
            </button>
            <button
              type="button"
              className={"chip" + (detectionMode === "gradient" ? " on" : "")}
              style={{ cursor: "pointer" }}
              onClick={() => setDetectionMode("gradient")}
            >
              Gradient
            </button>
          </div>

          {detectionMode === "gradient" && (
            <div style={{ marginBottom: 8 }}>
              <SliderRow label="Gradient kernel" value={gradientKernel}
                min={1} max={15} step={1}
                format={(v) => `${v}`}
                onChange={setGradientKernel} />
            </div>
          )}

          <div className="row" style={{ gap: 4, alignItems: "center", marginBottom: 10 }}>
            <span className="u" style={{ fontSize: 10 }}>Max matches</span>
            <input
              type="number" min={1} max={10000}
              value={maxMatches}
              style={{ width: 60, padding: "2px 4px", fontSize: 11, fontFamily: "var(--mono)", background: "var(--panel)", color: "var(--ink)", border: "1px solid var(--l2)", borderRadius: 4 }}
              onChange={(e) => setMaxMatches(Math.max(1, Number(e.target.value)))}
            />
          </div>

          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer" }}
            disabled={!ready || running}
            onClick={() => void run()}
          >
            {running ? "Running contour detection…" : "Run contour detection"}
          </button>
          <StatusLine result={result} err={err} />

          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer", marginTop: 6, opacity: 0.55, fontSize: 10 }}
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? "▾ Tree & threshold params" : "▸ Tree & threshold params"}
          </button>

          {showAdvanced && (
            <div style={{ marginBottom: 8, padding: "6px 8px", background: "var(--l1)", borderRadius: 4, fontSize: 10 }}>
              <SliderRow label="Min ref children" value={minRefChildren}
                min={1} max={4} step={1}
                format={(v) => `${v}`}
                onChange={setMinRefChildren} />
              <SliderRow label="Struct thresh" value={structThresh}
                min={0.05} max={1.0} step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={setStructThresh} />
              <SliderRow label="Fuzzy thresh" value={fuzzyThresh}
                min={0.5} max={3.0} step={0.1}
                format={(v) => v.toFixed(2)}
                onChange={setFuzzyThresh} />
              <SliderRow label="EFD harmonics" value={efdHarmonics}
                min={2} max={20} step={1}
                format={(v) => `${v}`}
                onChange={setEfdHarmonics} />
              <SliderRow label="Merge dist (px)" value={mergeDistPx}
                min={1} max={100} step={1}
                format={(v) => `${v}`}
                onChange={setMergeDistPx} />
              <SliderRow label="Merge area ratio" value={mergeAreaRatio}
                min={0.05} max={1.0} step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={setMergeAreaRatio} />
              <SliderRow label="Area ratio low" value={areaLo}
                min={0.1} max={1.5} step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={setAreaLo} />
              <SliderRow label="Area ratio high" value={areaHi}
                min={0.5} max={5.0} step={0.1}
                format={(v) => v.toFixed(2)}
                onChange={setAreaHi} />
              <SliderRow label="Aspect thresh" value={aspectThresh}
                min={0.05} max={1.0} step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={setAspectThresh} />
              <SliderRow label="Min area (px²)" value={minArea}
                min={50} max={10000} step={50}
                format={(v) => `${v}`}
                onChange={setMinArea} />
              <SliderRow label="NMS min dist (px)" value={minDistance}
                min={1} max={50} step={1}
                format={(v) => `${v}`}
                onChange={setMinDistance} />
              <SliderRow label="Rotation min matches" value={rotationMinMatches}
                min={1} max={5} step={1}
                format={(v) => `${v}`}
                onChange={setRotationMinMatches} />
              <div className="u" style={{ fontSize: 9, marginTop: 4, marginBottom: 2 }}>
                Fuzzy weights
              </div>
              <SliderRow label="w_shape (EFD)" value={wShape}
                min={0} max={3} step={0.1}
                format={(v) => v.toFixed(2)}
                onChange={setWShape} />
              <SliderRow label="w_area (log)" value={wArea}
                min={0} max={3} step={0.1}
                format={(v) => v.toFixed(2)}
                onChange={setWArea} />
              <SliderRow label="w_bbox (1-IoU)" value={wBbox}
                min={0} max={3} step={0.1}
                format={(v) => v.toFixed(2)}
                onChange={setWBbox} />
              <SliderRow label="w_pos (offset)" value={wPos}
                min={0} max={3} step={0.1}
                format={(v) => v.toFixed(2)}
                onChange={setWPos} />
            </div>
          )}

          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer", marginTop: 4, opacity: 0.6 }}
            disabled={!ready || debugLoading}
            onClick={() => void (showDebug ? setShowDebug(false) : runDebug())}
          >
            {debugLoading ? "Loading debug…" : showDebug ? "Hide debug" : "Debug contour"}
          </button>
          <button
            type="button"
            className="btn"
            style={{ width: "100%", cursor: "pointer", marginTop: 4, opacity: 0.5 }}
            onClick={() => void runDump()}
          >
            Dump debug to file
          </button>

          {showDebug && debugData && (
            <div style={{ marginTop: 8, fontSize: 10, color: "var(--ink2)" }}>
              <div className="m" style={{ marginBottom: 4 }}>
                Ref tree: {debugData.ref_contour_count} nodes ·{" "}
                Stage 1: {debugData.stage1_raw_count}r →{" "}
                {debugData.stage1_after_aspect}a →{" "}
                {debugData.stage1_after_nms}n →{" "}
                {debugData.stage1_clustered_count}c ·{" "}
                Stage 2: {debugData.stage2_no_tree}no_tree{" "}
                {debugData.stage2_low_children}low_child{" "}
                {debugData.stage2_low_struct}low_struct ·{" "}
                {debugData.stage2_matches} matches
              </div>
              {debugData.ref_crop_png_b64 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="u" style={{ fontSize: 9, marginBottom: 2 }}>Reference crop</div>
                  <img
                    src={`data:image/png;base64,${debugData.ref_crop_png_b64}`}
                    alt="ref crop"
                    style={{ maxWidth: "100%", borderRadius: 3 }}
                  />
                </div>
              )}
              {debugData.ref_contour_png_b64 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="u" style={{ fontSize: 9, marginBottom: 2 }}>
                    Reference tree ({debugData.ref_contour_count} nodes)
                  </div>
                  <img
                    src={`data:image/png;base64,${debugData.ref_contour_png_b64}`}
                    alt="ref tree"
                    style={{ maxWidth: "100%", borderRadius: 3 }}
                  />
                </div>
              )}
              {debugData.search_preview_png_b64 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="u" style={{ fontSize: 9, marginBottom: 2 }}>
                    Search preview (green=accepted, bbox=rotated)
                  </div>
                  <img
                    src={`data:image/jpeg;base64,${debugData.search_preview_png_b64}`}
                    alt="search preview"
                    style={{ maxWidth: "100%", borderRadius: 3 }}
                  />
                </div>
              )}
              {debugData.top_matches.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div className="u" style={{ fontSize: 9, marginBottom: 2 }}>Top matches</div>
                  <div style={{ maxHeight: 200, overflow: "auto" }}>
                    {debugData.top_matches.map((m, i) => (
                      <div
                        key={i}
                        style={{
                          padding: "2px 0",
                          borderBottom: "1px solid var(--l1)",
                          fontSize: 9,
                        }}
                      >
                        #{i + 1} conf={m.confidence}{" "}
                        {m.tree_match_score != null && <>score={m.tree_match_score.toFixed(2)} </>}
                        {m.n_children_matched != null && <>matched={m.n_children_matched}/{m.n_children_ref} </>}
                        {m.scale != null && <>scale={m.scale.toFixed(2)} </>}
                        rot={m.rotation}° src={m.orientation_source}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SliderRow({
  label, value, min, max, step, format, onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 2 }}>
        <span className="u" style={{ fontSize: 9 }}>{label}</span>
        <span style={{ color: "var(--ink2)", fontFamily: "var(--mono)" }}>{format(value)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        style={{ width: "100%", marginBottom: 6 }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </>
  );
}


type SubMode = "template" | "contour";

export function CVPanel({
  dieId,
  annotations,
  dispatcher
}: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
}) {
  const [mode, setMode] = useState<SubMode>("template");
  return (
    <div style={{ padding: "12px" }}>
      <div
        className="row"
        style={{ gap: 4, marginBottom: 10, padding: "0 0 8px 0", borderBottom: "1px solid var(--l1)" }}
      >
        <button
          type="button"
          className={"chip" + (mode === "template" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setMode("template")}
        >
          Template
        </button>
        <button
          type="button"
          className={"chip" + (mode === "contour" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setMode("contour")}
        >
          Contour (exp.)
        </button>
      </div>
      {mode === "template" ? (
        <TemplateSection dieId={dieId} annotations={annotations} dispatcher={dispatcher} />
      ) : (
        <ContourSection dieId={dieId} annotations={annotations} dispatcher={dispatcher} />
      )}
    </div>
  );
}
