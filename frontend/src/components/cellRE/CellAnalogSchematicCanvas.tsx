/**
 * CellAnalogSchematicCanvas.tsx — Analog transistor-level schematic for a
 * single cell type, rendered via netlist2svg (ELK layout engine).
 *
 * Uses the same pipeline as AnalogNetlistPage's Schematic view:
 *   AnalogDevice[] + namedNets
 *     → formatDevicesAsNetlist2Svg() → Yosys JSON
 *     → buildSkin() (custom analog skin)
 *     → ELK layout → SVG
 *     → Netlist2SvgView (pan/zoom, tooltips, download)
 *
 * Cell-level differences from the die-wide SchematicViewPanel:
 *   - No hierarchical regions (flat view only)
 *   - No floorplanRegions
 *   - No net labels (showNetLabels: false)
 *   - Module name = cellType.name
 *   - VDD/GND named from extraction nets or defaults
 */

import { useMemo, useRef, useCallback, useState } from "react";
import type { AnalogDevice, SpiceConfig } from "shared";
import type { ExtractedNet } from "../../lib/extraction";
import { netDisplayName } from "../../lib/labels";
import { Netlist2SvgView, type Netlist2SvgHandle } from "../netlist/Netlist2SvgView";
import {
  buildSkin,
  LAYOUT_STRATEGIES,
  LAYOUT_DIRECTIONS,
  COMPACTION_LEVELS,
  type LayoutStrategy,
  type LayoutDirection,
  type CompactionLevel,
} from "../../lib/schematic/netlist2svgSkin";
import { formatDevicesAsNetlist2Svg } from "../../lib/schematic/netlist2svgFormat";

interface Props {
  /** Analog devices extracted from the cell type (from InferredCellExtraction.analogDevices) */
  devices: AnalogDevice[];
  /** Nets extracted from the cell (from InferredCellExtraction.nets) */
  nets: ExtractedNet[];
  /** Used as the Yosys module name */
  moduleName: string;
  /** SpiceConfig with vdd/gnd names and sheetR preferences */
  spiceConfig?: SpiceConfig;
  /** Loading state — Netlist2SvgView handles its own loading indicator */
  loading?: boolean;
}

// ── Toolbar ────────────────────────────────────────────────────────

function Toolbar({
  layoutStrategy,
  setLayoutStrategy,
  layoutDirection,
  setLayoutDirection,
  compactionLevel,
  setCompactionLevel,
  n2sRef,
  moduleName,
}: {
  layoutStrategy: LayoutStrategy;
  setLayoutStrategy: (s: LayoutStrategy) => void;
  layoutDirection: LayoutDirection;
  setLayoutDirection: (d: LayoutDirection) => void;
  compactionLevel: CompactionLevel;
  setCompactionLevel: (c: CompactionLevel) => void;
  n2sRef: React.RefObject<Netlist2SvgHandle | null>;
  moduleName: string;
}) {
  const handleDownload = useCallback(
    (format: "svg" | "png" | "json") => {
      const ref = n2sRef.current;
      if (!ref) return;
      const baseName = moduleName;

      if (format === "json") {
        const json = ref.getJson();
        if (!json) return;
        const blob = new Blob([JSON.stringify(json, null, 2)], {
          type: "application/json",
        });
        downloadBlob(blob, `${baseName}.json`);
        return;
      }

      const svgString = ref.getSvgString();
      if (!svgString) return;

      if (format === "svg") {
        const blob = new Blob([svgString], {
          type: "image/svg+xml",
        });
        downloadBlob(blob, `${baseName}.svg`);
        return;
      }

      // PNG
      const size = ref.getSvgSize();
      if (!size) return;
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(size.width * scale);
      canvas.height = Math.round(size.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            if (blob) downloadBlob(blob, `${baseName}.png`);
          },
          "image/png",
        );
      };
      img.src =
        "data:image/svg+xml;base64," +
        btoa(unescape(encodeURIComponent(svgString)));
    },
    [n2sRef, moduleName],
  );

  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        padding: "6px 8px",
        background: "var(--l1)",
        borderBottom: "1px solid var(--l2)",
        overflow: "auto",
        flexShrink: 0,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      {/* Layout direction */}
      <select
        value={layoutDirection}
        onChange={(e) => setLayoutDirection(e.target.value as LayoutDirection)}
        style={selectStyle}
        title="ELK layout direction"
      >
        {LAYOUT_DIRECTIONS.map((d) => (
          <option key={d.value} value={d.value} title={d.desc}>
            {d.label}
          </option>
        ))}
      </select>

      {/* Layout strategy */}
      <select
        value={layoutStrategy}
        onChange={(e) => setLayoutStrategy(e.target.value as LayoutStrategy)}
        style={selectStyle}
        title="ELK layout strategy"
      >
        {LAYOUT_STRATEGIES.map((s) => (
          <option key={s.value} value={s.value} title={s.desc}>
            {s.label}
          </option>
        ))}
      </select>

      {/* Compaction (BRANDES_KOEPF only) */}
      {layoutStrategy === "BRANDES_KOEPF" && (
        <select
          value={compactionLevel}
          onChange={(e) =>
            setCompactionLevel(Number(e.target.value) as CompactionLevel)
          }
          style={selectStyle}
          title="ELK post-compaction"
        >
          {COMPACTION_LEVELS.map((c) => (
            <option key={c.value} value={c.value} title={c.desc}>
              {c.label}
            </option>
          ))}
        </select>
      )}

      <span style={{ width: 1, height: 16, background: "var(--l2)", flexShrink: 0 }} />

      {/* Zoom */}
      <button
        type="button"
        className="btn sm"
        onClick={() => n2sRef.current?.zoomIn()}
        style={{ fontSize: 10, fontWeight: 600 }}
        title="Zoom in"
      >
        +
      </button>
      <button
        type="button"
        className="btn sm"
        onClick={() => n2sRef.current?.zoomOut()}
        style={{ fontSize: 10, fontWeight: 600 }}
        title="Zoom out"
      >
        −
      </button>
      <button
        type="button"
        className="btn sm"
        onClick={() => n2sRef.current?.zoomReset()}
        style={{ fontSize: 10 }}
        title="Reset zoom"
      >
        ⊖
      </button>

      <span style={{ width: 1, height: 16, background: "var(--l2)", flexShrink: 0 }} />

      {/* Download */}
      <button
        type="button"
        className="btn sm"
        onClick={() => handleDownload("svg")}
        style={{ fontSize: 10 }}
        title="Download SVG"
      >
        ↓ SVG
      </button>
      <button
        type="button"
        className="btn sm"
        onClick={() => handleDownload("png")}
        style={{ fontSize: 10 }}
        title="Download PNG (2x)"
      >
        ↓ PNG
      </button>
      <button
        type="button"
        className="btn sm"
        onClick={() => handleDownload("json")}
        style={{ fontSize: 10 }}
        title="Download Yosys JSON"
      >
        ↓ JSON
      </button>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  fontSize: 10,
  padding: "1px 4px",
  border: "1px solid var(--l2)",
  borderRadius: 3,
  background: "var(--card)",
  color: "var(--fg)",
  outline: "none",
  cursor: "pointer",
};

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Component ──────────────────────────────────────────────────────

export function CellAnalogSchematicCanvas({
  devices,
  nets,
  moduleName,
  spiceConfig,
  loading,
}: Props) {
  const [layoutStrategy, setLayoutStrategy] = useState<LayoutStrategy>(
    "BRANDES_KOEPF",
  );
  const [layoutDirection, setLayoutDirection] = useState<LayoutDirection>(
    "DOWN",
  );
  const [compactionLevel, setCompactionLevel] = useState<CompactionLevel>(2);

  const n2sRef = useRef<Netlist2SvgHandle>(null);

  // Build namedNets map: netId → human-readable name
  const namedNets = useMemo(() => {
    const m = new Map<number, string>();
    for (const net of nets) {
      // Use the same display name rule as the rest of the UI
      const name = netDisplayName(net);
      m.set(net.id, name);
    }
    return m;
  }, [nets]);

  // Build Yosys JSON via formatDevicesAsNetlist2Svg
  const netlistJson = useMemo(() => {
    if (devices.length === 0) return null;
    const cfg: SpiceConfig = {
      vdd: "VDD",
      gnd: "GND",
      ...spiceConfig,
    };
    return formatDevicesAsNetlist2Svg(devices, namedNets, moduleName, {
      vdd: cfg.vdd ?? "VDD",
      gnd: cfg.gnd ?? "GND",
      hierarchical: false,
      // No port labels for cell-level nets (user said not needed)
      showNetLabels: false,
    });
  }, [devices, namedNets, moduleName, spiceConfig]);

  // Build skin string (includes direction/strategy/compaction overrides)
  const skin = useMemo(
    () => buildSkin(layoutStrategy, layoutDirection, compactionLevel),
    [layoutStrategy, layoutDirection, compactionLevel],
  );

  const hasDevices = devices.length > 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <Toolbar
        layoutStrategy={layoutStrategy}
        setLayoutStrategy={setLayoutStrategy}
        layoutDirection={layoutDirection}
        setLayoutDirection={setLayoutDirection}
        compactionLevel={compactionLevel}
        setCompactionLevel={setCompactionLevel}
        n2sRef={n2sRef}
        moduleName={moduleName}
      />

      <div style={{ flex: "1 1 auto", minHeight: 0, position: "relative" }}>
        {!hasDevices ? (
          <EmptyView message="no analog devices in this cell" />
        ) : netlistJson ? (
          <Netlist2SvgView
            ref={n2sRef}
            netlistJson={netlistJson}
            layoutStrategy={layoutStrategy}
            layoutDirection={layoutDirection}
            compactionLevel={compactionLevel}
          />
        ) : (
          <EmptyView message="failed to build schematic" />
        )}
      </div>
    </div>
  );
}

function EmptyView({ message }: { message?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "var(--ink3)",
        fontStyle: "italic",
        fontSize: 12,
      }}
    >
      {message ?? "no analog devices"}
    </div>
  );
}
