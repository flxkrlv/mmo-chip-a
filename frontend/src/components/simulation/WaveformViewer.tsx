/**
 * WaveformViewer — Canvas 2D waveform display.
 *
 * Based on @spice-ts/ui renderer with momentum pan/zoom, cursor interpolation,
 * min/max decimation, and SI-prefix formatted tooltips.
 *
 * Traces are split by type: voltages on top, currents on bottom.
 * Each plot has its own zoom/pan state and legend.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WaveformTrace } from "../../lib/simulation/types";
import { TransientRenderer } from "../../lib/simulation/waveform/renderer";
import { InteractionHandler } from "../../lib/simulation/waveform/interaction";
import { normalizeWaveformTraces } from "../../lib/simulation/waveform/data";
import { resolveTheme } from "../../lib/simulation/waveform/theme";
import type { ThemeConfig, CursorState } from "../../lib/simulation/waveform/types";
import { CursorTooltip } from "../../lib/simulation/waveform/CursorTooltip";
import { Legend, type LegendSignal } from "../../lib/simulation/waveform/Legend";
import { useCanvas } from "../../lib/simulation/waveform/use-renderer";

type Props = {
  traces: WaveformTrace[];
  height?: number;
};

// ── Single plot panel (reused for voltage and current) ─────────────

interface PlotPanelProps {
  traces: WaveformTrace[];
  label: string;
  height: number;
  theme: ThemeConfig;
  rendererRef: React.MutableRefObject<TransientRenderer | null>;
  interactionRef: React.MutableRefObject<InteractionHandler | null>;
  onFit?: () => void;
}

function PlotPanel({
  traces,
  label,
  height,
  theme,
  rendererRef,
  interactionRef,
  onFit,
}: PlotPanelProps) {
  const [cursor, setCursor] = useState<CursorState | null>(null);
  const [allSignals, setAllSignals] = useState<LegendSignal[]>([]);

  const handleResize = useCallback(() => {
    rendererRef.current?.render();
  }, [rendererRef]);

  const { refCallback } = useCanvas(handleResize);

  // Create renderer and interaction handler once when canvas mounts
  const canvasRefCallback = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      rendererRef.current?.destroy();
      interactionRef.current?.destroy();
      rendererRef.current = null;
      interactionRef.current = null;

      refCallback(canvas);

      if (canvas) {
        const renderer = new TransientRenderer(canvas, { theme });
        rendererRef.current = renderer;

        renderer.on("cursorMove", (state) => {
          setCursor(state);
        });

        const interaction = new InteractionHandler(canvas, {
          onCursorMove: (pixelX) => {
            renderer.setCursorPixelX(pixelX);
            renderer.render();
          },
          onZoom: (_pixelX, factor, _shiftKey) => {
            renderer.zoomAt(_pixelX, factor);
            renderer.render();
          },
          onPan: (dx, _dy) => {
            renderer.pan(dx, 0);
            renderer.render();
          },
          onDoubleClick: () => {
            renderer.fitToData();
            renderer.render();
          },
        });
        interactionRef.current = interaction;
      }
    },
    [theme, refCallback, rendererRef, interactionRef],
  );

  // Update data when traces change
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    if (traces.length === 0) {
      renderer.setData([], []);
      renderer.render();
      setAllSignals([]);
      return;
    }

    const datasets = normalizeWaveformTraces(traces);
    const signalNames = traces.filter((t) => t.type !== "time").map((t) => t.name);

    renderer.setData(datasets, signalNames);
    renderer.render();

    const signalStates = renderer.getSignalStates();
    const signals: LegendSignal[] = signalStates.map((s) => ({
      id: s.name,
      label: s.name,
      color: s.color,
      visible: s.visible,
    }));
    setAllSignals(signals);
  }, [traces, rendererRef]);

  // Handle legend toggle
  const handleToggle = useCallback(
    (signalId: string) => {
      const renderer = rendererRef.current;
      if (!renderer) return;

      renderer.setSignalVisibility(
        signalId,
        !renderer.getSignalStates().find((s) => s.name === signalId)?.visible,
      );
      renderer.render();

      setAllSignals((prev) =>
        prev.map((s) =>
          s.id === signalId ? { ...s, visible: !s.visible } : s,
        ),
      );
    },
    [rendererRef],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      rendererRef.current?.destroy();
      interactionRef.current?.destroy();
    };
  }, [rendererRef, interactionRef]);

  if (traces.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--ink3)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {label}
        </div>
        {onFit && (
          <button
            onClick={onFit}
            className="btn ghost"
            style={{ fontSize: 9, padding: "0 4px" }}
            title="Zoom to fit"
          >
            &#9634;
          </button>
        )}
        {allSignals.length > 0 && (
          <Legend signals={allSignals} onToggle={handleToggle} style={{ padding: 0, gap: 8 }} />
        )}
      </div>
      <div style={{ position: "relative" }}>
        <canvas
          ref={canvasRefCallback}
          style={{
            width: "100%",
            height,
            borderRadius: 4,
            cursor: "crosshair",
            display: "block",
          }}
        />
        <CursorTooltip
          cursor={cursor}
          theme={theme}
          formatX={(x) => `${x.toExponential(2)}s`}
        />
      </div>
    </div>
  );
}

// ── Main viewer ──────────────────────────────────────────────────────

export function WaveformViewer({ traces, height = 120 }: Props) {
  const theme: ThemeConfig = resolveTheme("dark");

  // Separate voltage and current traces
  const { voltageTraces, currentTraces } = useMemo(() => {
    const voltage: WaveformTrace[] = [];
    const current: WaveformTrace[] = [];
    for (const t of traces) {
      if (t.type === "current") {
        current.push(t);
      } else {
        voltage.push(t);
      }
    }
    return { voltageTraces: voltage, currentTraces: current };
  }, [traces]);

  // Refs for voltage plot
  const voltageRendererRef = useRef<TransientRenderer | null>(null);
  const voltageInteractionRef = useRef<InteractionHandler | null>(null);

  // Refs for current plot
  const currentRendererRef = useRef<TransientRenderer | null>(null);
  const currentInteractionRef = useRef<InteractionHandler | null>(null);

  // Zoom to fit both plots
  const fitToData = useCallback(() => {
    voltageRendererRef.current?.fitToData();
    voltageRendererRef.current?.render();
    currentRendererRef.current?.fitToData();
    currentRendererRef.current?.render();
  }, []);

  if (traces.length === 0) {
    return (
      <div
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--ink3)",
          fontSize: 11,
          background: "var(--bg)",
          borderRadius: 4,
        }}
      >
        Run a simulation to see waveforms
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {/* Voltage plot */}
      <PlotPanel
        traces={voltageTraces}
        label="Voltages"
        height={height}
        theme={theme}
        rendererRef={voltageRendererRef}
        interactionRef={voltageInteractionRef}
        onFit={fitToData}
      />

      {/* Current plot */}
      <PlotPanel
        traces={currentTraces}
        label="Currents"
        height={height}
        theme={theme}
        rendererRef={currentRendererRef}
        interactionRef={currentInteractionRef}
        onFit={fitToData}
      />
    </div>
  );
}
