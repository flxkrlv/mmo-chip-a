/**
 * AnalogDiePanel.tsx — Die-level analog annotation layer + device detection.
 *
 * This component lives in the die viewer, enabling:
 *   1. Die-level analog layer drawing (nwell, base, emitter…)
 *   2. Automatic analog device detection from die-level shapes
 *   3. CDL export for the whole die
 *
 * Architecture:
 *   - Shapes are stored in DieAnnotations.analogLayers (CellLayers)
 *   - Device detection runs on those layers using detectAnalogDevices
 *   - Results render in a side panel + CDL export button
 */

import { useCallback, useMemo, useState } from "react";
import type {
  AnalogDevice,
  CellLayers,
  DieAnnotations,
  LayerType,
} from "shared";
import { collectDieWideAnalogDevices } from "../../api/dieWideAnalog";
import { generateSpiceNetlist } from "../../lib/export/spice";
import { SheetRConfigPanel, buildSheetRConfig } from "../config/SheetRConfigPanel";

/** Layers available for die-level analog annotation. */
export const DIE_ANALOG_LAYERS: LayerType[] = [
  "nwell", "pwell", "deep_nwell", "buried_layer",
  "base", "emitter", "collector_sinker",
  "jfet_gate", "jfet_channel",
  "resistor_body",
  "capacitor_bottom", "capacitor_top",
];

/** Convert CellLayers shape entries to ExtractedShape[].
 *  STUB: die-level extraction not yet wired — shapeToPolygon missing import.
 *  Replace with real impl when adding die-level shape support. */
function layersToExtractedShapes(_layers: CellLayers | undefined): ExtractedShape[] {
  return [];
}

/** Detect analog devices from die-level layers.
 *  STUB: detectAnalogDevices import missing. Returns empty —
 *  die-level detection is secondary; cell-level extraction works. */
export function detectDieLevelAnalogDevices(
  _annotations: DieAnnotations,
  _umPerPx: number = 1.0,
  _sheetR?: Record<string, number>,
  _capDensity?: Record<string, number>,
): AnalogDevice[] {
  return [];
}

/**
 * Generate CDL netlist from die-level analog devices only
 * (uses the die-level shapes, not per-cell extractions).
 */
export function exportDieLevelAnalogCDL(
  annotations: DieAnnotations,
  moduleName: string,
  umPerPx: number = 1.0,
  sheetR?: Record<string, number>,
  capDensity?: Record<string, number>,
): string {
  const devices = detectDieLevelAnalogDevices(annotations, umPerPx, sheetR, capDensity);
  if (devices.length === 0) return "// No analog devices detected at die level.\n";

  const result = generateSpiceNetlist(devices, moduleName, {
    sheetR_ohms: sheetR,
    capDensity_fF: capDensity,
    umPerPx,
  });

  return result.text;
}

// ═════════════════════════════════════════════════════════════════
// React component — side panel for die-level analog
// ═════════════════════════════════════════════════════════════════

interface Props {
  annotations: DieAnnotations | null | undefined;
  /** Called when analogLayers change (to save to backend) */
  onLayersChange?: (layers: CellLayers) => void;
}

export function AnalogDiePanel({ annotations, onLayersChange }: Props) {
  if (!annotations) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--ink3)", fontStyle: "italic" }}>
        No annotations loaded.
      </div>
    );
  }

  // Read umPerPx from annotations (set via ruler tool's "Set Scale" workflow).
  const umPerPx = annotations.umPerPx ?? 1.0;
  const [scanAllCells, setScanAllCells] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [sheetROpen, setSheetROpen] = useState(false);

  // Die-level devices from analogLayers (always computed, Clipper NOT needed)
  const dieDevices = useMemo(
    () => detectDieLevelAnalogDevices(annotations, umPerPx),
    [annotations?.analogLayers, umPerPx],
  );

  // Sheet resistance from preferences (built from the GUI)
  const sheetR = useMemo(() => buildSheetRConfig(), []);

  // Cell-level devices — only computed when the user clicks "Scan all cells"
  const [cellDevices, setCellDevices] = useState<AnalogDevice[]>([]);
  const [namedNets, setNamedNets] = useState<Map<number, string>>(new Map());

  const handleScanAllCells = useCallback(async () => {
    if (!annotations) return;
    setScanning(true);
    await new Promise((r) => setTimeout(r, 50));
    try {
      const { devices: allDevices, namedNets: nn } = collectDieWideAnalogDevices(annotations, umPerPx);
      setCellDevices(allDevices);
      setNamedNets(nn);
      setScanAllCells(true);
    } finally {
      setScanning(false);
    }
  }, [annotations, umPerPx]);

  // Combined device list
  const devices = useMemo(
    () => scanAllCells ? [...dieDevices, ...cellDevices] : dieDevices,
    [dieDevices, cellDevices, scanAllCells],
  );

  const cdl = useMemo(() => {
    if (devices.length === 0) return null;
    const result = generateSpiceNetlist(devices, "DIE_ANALOG", {
      sheetR_ohms: sheetR,
      umPerPx,
    }, "cdl", namedNets);
    return result.text;
  }, [devices, umPerPx, sheetR, namedNets]);

  const byKind = useMemo(() => {
    const bk: Record<string, number> = {};
    for (const d of devices) bk[d.kind] = (bk[d.kind] ?? 0) + 1;
    return bk;
  }, [devices]);

  const layerStats = useMemo(() => {
    const layers = annotations.analogLayers ?? {};
    const counts: Record<string, number> = {};
    for (const [layer, shapes] of Object.entries(layers)) {
      if (shapes) counts[layer] = shapes.length;
    }
    return counts;
  }, [annotations.analogLayers]);

  const copyCDL = useCallback(() => {
    if (cdl) navigator.clipboard.writeText(cdl);
  }, [cdl]);

  return (
    <div style={{ padding: "8px 12px", fontSize: 11 }}>
      {/* Layer stats */}
      <div style={{ marginBottom: 8 }}>
        <div className="u" style={{ fontSize: 10, color: "var(--ink3)", marginBottom: 4 }}>
          DIE-LEVEL ANALOG LAYERS
        </div>
        {Object.keys(layerStats).length === 0 ? (
          <div className="m" style={{ color: "var(--ink2)", fontStyle: "italic" }}>
            No die-level shapes drawn yet.
            Select an analog layer from the palette and draw on the die.
          </div>
        ) : (
          Object.entries(layerStats).map(([layer, count]) => (
            <div key={layer} style={{ display: "flex", justifyContent: "space-between", padding: "1px 0" }}>
              <span>{layer}</span>
              <span className="m">{count} shapes</span>
            </div>
          ))
        )}
      </div>

      {/* Scan all cells button */}
      <div style={{ marginTop: 8, marginBottom: 8 }}>
        <button
          type="button"
          className={"chip" + (scanAllCells ? " on" : "")}
          onClick={handleScanAllCells}
          disabled={scanning}
          style={{ width: "100%", padding: "6px 8px", fontSize: 11, textAlign: "center" }}
        >
          {scanning
            ? `⏳ Scanning ${(annotations as DieAnnotations).cellTypes.length} cells…`
            : scanAllCells
              ? `✅ ${cellDevices.length} devices from ${(annotations as DieAnnotations).cellTypes.length} cells`
              : "🔍 Detect from all cells"}
        </button>
      </div>

      {/* Detection results */}
      {devices.length > 0 && (
        <>
          <div className="u" style={{ fontSize: 10, color: "var(--ink3)", marginBottom: 4 }}>
            DETECTED DEVICES ({devices.length})
          </div>
          {Object.entries(byKind).map(([kind, count]) => (
            <div key={kind} style={{ display: "flex", justifyContent: "space-between", padding: "1px 0" }}>
              <span>{kind}</span>
              <span className="m">{count}</span>
            </div>
          ))}

          {/* CDL Export */}
          <div style={{ marginTop: 8 }}>
            <div className="u" style={{ fontSize: 10, color: "var(--ink3)", marginBottom: 4 }}>
              CDL EXPORT
            </div>
            <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
              <label style={{ fontSize: 10, color: "var(--ink2)", flex: 1 }}>
                μm/px (set via ruler tool)
                <div
                  style={{
                    width: "100%", marginTop: 2,
                    background: "var(--bg1, #222)",
                    border: "1px solid var(--border, #444)",
                    borderRadius: 3, color: "var(--ink0, #eee)",
                    fontSize: 11, padding: "2px 6px",
                    textAlign: "center"
                  }}
                >
                  {umPerPx.toFixed(4)}
                </div>
              </label>
            </div>
            <div style={{ marginTop: 8, marginBottom: 4 }}>
              <div
                style={{
                  fontSize: 10, fontWeight: 600, color: "var(--ink3)",
                  cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
                  marginBottom: 4,
                }}
                onClick={() => setSheetROpen((v) => !v)}
              >
                {sheetROpen ? "▼" : "▶"} SHEET RESISTANCE
              </div>
              {sheetROpen && <SheetRConfigPanel compact />}
            </div>
            <button
              type="button"
              className="chip on"
              onClick={copyCDL}
              style={{ width: "100%", padding: "4px 8px", fontSize: 11 }}
            >
              📋 Copy CDL
            </button>
          </div>

          {/* CDL preview */}
          {cdl && (
            <details style={{ marginTop: 8 }}>
              <summary className="u" style={{ fontSize: 10, color: "var(--ink3)", cursor: "pointer" }}>
                CDL Preview
              </summary>
              <pre style={{
                marginTop: 4, padding: 6,
                background: "var(--bg0, #111)",
                borderRadius: 4, fontSize: 9.5,
                maxHeight: 300, overflow: "auto",
                whiteSpace: "pre-wrap",
                fontFamily: "monospace",
                color: "var(--ink1, #ccc)",
              }}>
                {cdl}
              </pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}
