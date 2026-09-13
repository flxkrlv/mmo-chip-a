/**
 * WaveformViewer — Canvas 2D waveform display.
 *
 * Uses HTML Canvas 2D context. Supports pan, zoom, toggle traces, auto-scale.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WaveformTrace } from "../../lib/simulation/types";

const PALETTE = [
  "#3399ff", "#ff6633", "#1acc44", "#ffcc11",
  "#b34dff", "#1accbb", "#ff77bb", "#999999",
];

type Props = {
  traces: WaveformTrace[];
  height?: number;
};

export function WaveformViewer({ traces, height = 320 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [enabledIdx, setEnabledIdx] = useState<Set<number>>(new Set());
  const viewRef = useRef({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 });
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  const bounds = useCallback(() => {
    if (traces.length === 0) return null;
    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    for (const t of traces) {
      for (const x of t.xValues) { if (Number.isFinite(x)) { if (x < xMin) xMin = x; if (x > xMax) xMax = x; } }
      for (const y of t.yValues) { if (Number.isFinite(y)) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; } }
    }
    if (!Number.isFinite(xMin) || xMin === xMax) return null;
    const xPad = (xMax - xMin) * 0.02 || 0.1;
    const yPad = (yMax - yMin) * 0.08 || 0.01;
    return { xMin: xMin - xPad, xMax: xMax + xPad, yMin: yMin - yPad, yMax: yMax + yPad };
  }, [traces]);

  useEffect(() => {
    const b = bounds();
    if (b) viewRef.current = b;
    setEnabledIdx(new Set(traces.map((_, i) => i)));
    draw();
  }, [traces, bounds]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cs = getComputedStyle(canvas);
    const bgColor = cs.getPropertyValue("--bg").trim() || "#15140f";

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);

    const view = viewRef.current;
    const xSpan = view.xMax - view.xMin;
    const ySpan = view.yMax - view.yMin;
    if (xSpan <= 0 || ySpan <= 0) return;

    const margin = { left: 60 * dpr, right: 20 * dpr, top: 20 * dpr, bottom: 30 * dpr };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;
    if (plotW <= 0 || plotH <= 0) return;

    const toX = (x: number) => margin.left + ((x - view.xMin) / xSpan) * plotW;
    const toY = (y: number) => margin.top + plotH - ((y - view.yMin) / ySpan) * plotH;

    // Grid
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    const numGridX = Math.min(10, Math.floor(plotW / (60 * dpr)));
    const numGridY = Math.min(8, Math.floor(plotH / (40 * dpr)));
    for (let i = 0; i <= numGridX; i++) {
      const x = margin.left + (i / numGridX) * plotW;
      ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, margin.top + plotH); ctx.stroke();
    }
    for (let i = 0; i <= numGridY; i++) {
      const y = margin.top + (i / numGridY) * plotH;
      ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(margin.left + plotW, y); ctx.stroke();
    }

    // Axis labels
    ctx.fillStyle = "#667";
    ctx.font = `${10 * dpr}px monospace`;
    ctx.textAlign = "center";
    for (let i = 0; i <= numGridX; i++) {
      const xVal = view.xMin + (i / numGridX) * xSpan;
      ctx.fillText(fmtAxis(xVal), margin.left + (i / numGridX) * plotW, margin.top + plotH + 14 * dpr);
    }
    ctx.textAlign = "right";
    for (let i = 0; i <= numGridY; i++) {
      const yVal = view.yMax - (i / numGridY) * ySpan;
      ctx.fillText(fmtAxis(yVal), margin.left - 6 * dpr, margin.top + (i / numGridY) * plotH + 4 * dpr);
    }

    // Traces
    for (let ti = 0; ti < traces.length; ti++) {
      if (!enabledIdx.has(ti)) continue;
      const trace = traces[ti];
      ctx.strokeStyle = PALETTE[ti % PALETTE.length];
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < trace.xValues.length; i++) {
        const x = trace.xValues[i], y = trace.yValues[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const cx = toX(x), cy = toY(y);
        if (!started) { ctx.moveTo(cx, cy); started = true; } else ctx.lineTo(cx, cy);
      }
      ctx.stroke();
    }

    // Border
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, plotW, plotH);
  }, [traces, enabledIdx]);

  useEffect(() => { draw(); }, [draw]);

  const rafRef = useRef(0);
  const scheduleRedraw = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  const toggleTrace = useCallback((idx: number) => {
    setEnabledIdx((prev) => { const next = new Set(prev); if (next.has(idx)) next.delete(idx); else next.add(idx); return next; });
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    isPanning.current = true; lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - lastMouse.current.x; const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    const v = viewRef.current;
    const xS = (v.xMax - v.xMin) / (rect.width - 80);
    const yS = (v.yMax - v.yMin) / (rect.height - 50);
    v.xMin -= dx * xS; v.xMax -= dx * xS; v.yMin += dy * yS; v.yMax += dy * yS;
    scheduleRedraw();
  }, [scheduleRedraw]);

  const onMouseUp = useCallback(() => { isPanning.current = false; }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const v = viewRef.current; const f = e.deltaY > 0 ? 1.1 : 0.9;
    const xM = (v.xMin + v.xMax) / 2, yM = (v.yMin + v.yMax) / 2;
    v.xMin = xM + (v.xMin - xM) * f; v.xMax = xM + (v.xMax - xM) * f;
    v.yMin = yM + (v.yMin - yM) * f; v.yMax = yM + (v.yMax - yM) * f;
    scheduleRedraw();
  }, [scheduleRedraw]);

  const autoScale = useCallback(() => { const b = bounds(); if (b) { viewRef.current = b; scheduleRedraw(); } }, [bounds, scheduleRedraw]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height, borderRadius: 4, cursor: "crosshair" }}
        onMouseDown={onMouseDown} onMouseMove={onMouseMove}
        onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
        onWheel={onWheel}
      />
      {traces.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {traces.map((trace, idx) => (
            <button key={idx} onClick={() => toggleTrace(idx)} style={{
              display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", fontSize: 10,
              fontFamily: "var(--font-mono, monospace)",
              background: enabledIdx.has(idx) ? "var(--l1)" : "transparent",
              border: `1px solid ${enabledIdx.has(idx) ? "var(--l2)" : "transparent"}`,
              borderRadius: 3, color: enabledIdx.has(idx) ? "var(--ink)" : "var(--ink3)",
              cursor: "pointer", textDecoration: enabledIdx.has(idx) ? "none" : "line-through",
            }}>
              <span style={{ width: 10, height: 3, background: PALETTE[idx % PALETTE.length], borderRadius: 1, display: "inline-block" }} />
              {trace.name}
            </button>
          ))}
          <button onClick={autoScale} className="btn ghost" style={{ fontSize: 10, marginLeft: 8 }} title="Auto-scale">&#9634;</button>
        </div>
      )}
      {traces.length === 0 && (
        <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink3)", fontSize: 11, background: "var(--bg)", borderRadius: 4 }}>
          Run a simulation to see waveforms
        </div>
      )}
    </div>
  );
}

function fmtAxis(v: number): string {
  if (Math.abs(v) < 1e-10) return "0";
  if (Math.abs(v) >= 1e6 || (Math.abs(v) < 0.001 && v !== 0)) return v.toExponential(1);
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
