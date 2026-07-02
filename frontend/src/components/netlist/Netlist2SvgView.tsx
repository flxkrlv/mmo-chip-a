/**
 * Netlist2SvgView.tsx — Lazy-loads netlist2svg (with ELK.js) and renders
 * a Yosys-format netlist as an SVG schematic.
 *
 * Pan/zoom via @panzoom/panzoom: drag to pan, wheel to zoom.
 * Device tooltips via React overlay.
 */

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import Panzoom from "@panzoom/panzoom";
import type { PanzoomObject } from "@panzoom/panzoom";
import { buildSkin, type LayoutStrategy, type LayoutDirection, type CompactionLevel } from "../../lib/schematic/netlist2svgSkin";

interface Netlist2SvgModule {
  render(skin: string, netlist: unknown, cb?: (err: Error | null, result?: string) => void): Promise<string>;
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

const ELK_CDN = "/lib/netlist2svg/elk.bundled.js";
const N2S_CDN = "/lib/netlist2svg/netlist2svg.bundle.js";

declare global {
  interface Window { ELK?: new (...args: unknown[]) => unknown; netlist2svg?: Netlist2SvgModule; }
}

let loadPromise: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    try {
      const elk = document.createElement("script"); elk.src = ELK_CDN;
      elk.onload = () => {
        if (window.ELK) (window.ELK as any).default = window.ELK;
        const n2s = document.createElement("script"); n2s.src = N2S_CDN;
        n2s.onload = () => { if (window.netlist2svg) resolve(); else reject(new Error("netlist2svg not found")); };
        n2s.onerror = () => reject(new Error(`Failed to load: ${N2S_CDN}`));
        document.head.appendChild(n2s);
      };
      elk.onerror = () => reject(new Error(`Failed to load: ${ELK_CDN}`));
      document.head.appendChild(elk);
    } catch (err) { reject(err); }
  });
  return loadPromise;
}

export interface Netlist2SvgHandle {
  getSvgString(): string | null;
  getJson(): unknown;
  getSvgSize(): { width: number; height: number } | null;
  zoomIn(): void; zoomOut(): void; zoomReset(): void;
}

interface Props {
  netlistJson: unknown;
  layoutStrategy?: LayoutStrategy;
  layoutDirection?: LayoutDirection;
  compactionLevel?: CompactionLevel;
  height?: number | string;
}

interface TooltipData { text: string[]; x: number; y: number; }

export const Netlist2SvgView = forwardRef<Netlist2SvgHandle, Props>(function Netlist2SvgView({ netlistJson, height, layoutStrategy, layoutDirection, compactionLevel }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const renderSeq = useRef(0);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const panzoomRef = useRef<PanzoomObject | null>(null);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  // ── Panzoom ──────────────────────────────────────────────────
  const initPanzoom = useCallback(() => {
    const c = containerRef.current;
    panzoomRef.current?.destroy(); panzoomRef.current = null;
    if (!c) return;
    const pz = Panzoom(c, { maxScale: 6, minScale: 0.2, startTransform: "scale(1)", contain: "outside" });
    c.addEventListener("wheel", pz.zoomWithWheel);
    panzoomRef.current = pz;
  }, []);

  useEffect(() => { return () => { panzoomRef.current?.destroy(); panzoomRef.current = null; }; }, []);

  // ── Exposed handle ───────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    getSvgString() {
      const svg = svgRef.current; if (!svg) return null;
      const clone = svg.cloneNode(true) as SVGSVGElement;
      if (clone.classList.contains("n2s-svg")) { clone.classList.remove("n2s-svg"); clone.classList.add("n2s-light"); }
      const ss = document.createElementNS("http://www.w3.org/2000/svg", "style");
      ss.textContent = ".n2s-light{fill:none!important}.n2s-light .symbol{stroke-width:2}.n2s-light .detail,.n2s-light .symbol{stroke-linejoin:round;stroke-linecap:round}";
      clone.prepend(ss); clone.style.background = "#ffffff";
      return new XMLSerializer().serializeToString(clone);
    },
    getJson() { return netlistJson; },
    getSvgSize() {
      const svg = svgRef.current; if (!svg) return null;
      const vb = svg.getAttribute("viewBox");
      if (vb) { const p = vb.split(/[\s,]+/).map(Number); if (p.length === 4) return { width: p[2], height: p[3] }; }
      const w = svg.getAttribute("width"), h = svg.getAttribute("height");
      if (w && h) return { width: parseFloat(w), height: parseFloat(h) };
      return { width: svg.clientWidth || 800, height: svg.clientHeight || 600 };
    },
    zoomIn() { panzoomRef.current?.zoomIn(); },
    zoomOut() { panzoomRef.current?.zoomOut(); },
    zoomReset() { panzoomRef.current?.reset(); },
  }), [netlistJson]);

  // ── Tooltip mousemove listener (attached in renderSchematic) ─
  const tooltipCleanupRef = useRef<(() => void) | null>(null);
  const attachTooltipListener = useCallback(() => {
    tooltipCleanupRef.current?.();
    const c = containerRef.current;
    if (!c) return;
    const onMove = (e: MouseEvent) => {
      const g = (e.target as Element)?.closest?.("[data-instance]") as SVGElement | null;
      if (!g) { setTooltip(null); return; }
      const a = g.getAttribute("data-tooltip");
      if (!a) { setTooltip(null); return; }
      setTooltip({ text: a.split("␟"), x: e.clientX + 14, y: e.clientY - 10 });
    };
    c.addEventListener("mousemove", onMove);
    tooltipCleanupRef.current = () => c.removeEventListener("mousemove", onMove);
  }, []);

  // Cleanup tooltip listener on unmount
  useEffect(() => { return () => tooltipCleanupRef.current?.(); }, []);

  // ── Render schematic ─────────────────────────────────────────
  const renderSchematic = useCallback(async () => {
    if (!window.ELK || !window.netlist2svg) return;
    const container = containerRef.current;
    if (!container) return;
    const seq = ++renderSeq.current;
    try {
      const skin = buildSkin(layoutStrategy, layoutDirection, compactionLevel);
      let svg = await window.netlist2svg.render(skin, netlistJson);
      if (seq !== renderSeq.current) return;
      svg = svg.replace("<svg ", `<svg class="n2s-svg" `);
      container.innerHTML = svg;
      svgRef.current = container.querySelector("svg");
      if (svgRef.current) { colorPowerNets(svgRef.current); annotateDeviceData(svgRef.current, netlistJson); fixBlockLabels(svgRef.current); }
      initPanzoom();
      attachTooltipListener(); // always after container is ready
    } catch (err) {
      if (seq !== renderSeq.current) return;
      console.error("[Netlist2Svg] render error:", err);
      const isElk = String(err).includes("scanline") || String(err).includes("hitboxes");
      container.innerHTML = `<div style="padding:16px;color:var(--warn);font-style:italic;font-size:11px;">
        <div style="font-weight:600;margin-bottom:6px;">⚠ ELK layout error (netlist2svg)</div>
        <div style="margin-bottom:8px;">${err instanceof Error ? err.message : String(err)}</div>
        ${isElk ? '<div style="color:var(--ink3);font-size:10px;">Try switching to <b>Spice-TS</b> renderer above.</div>' : ''}
      </div>`;
    }
  }, [netlistJson, layoutStrategy, layoutDirection, compactionLevel, initPanzoom, attachTooltipListener]);

  // ── Lifecycle ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setStatus("loading"); setErrorMsg(null);
      try { await ensureLoaded(); if (!cancelled) setStatus("ready"); }
      catch (err) { if (!cancelled) { setStatus("error"); setErrorMsg(err instanceof Error ? err.message : String(err)); } }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (status === "ready" && netlistJson) renderSchematic(); }, [status, netlistJson, layoutStrategy, renderSchematic]);
  useEffect(() => { svgRef.current = null; }, [netlistJson]);

  // ── Render branches ──────────────────────────────────────────
  if (status === "loading") return <LoadingIndicator message="Loading schematic engine (ELK.js)…" />;
  if (status === "error") return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: height ?? "100%", color: "var(--warn)", fontStyle: "italic", fontSize: 11, padding: 16 }}>⚠ {errorMsg}</div>;
  if (!netlistJson) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: height ?? "100%", color: "var(--ink3)", fontStyle: "italic", fontSize: 12 }}>No netlist data</div>;

  return (
    <div style={{ position: "relative", width: "100%", height: height ?? "100%", overflow: "hidden" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%", cursor: "grab", background: "var(--card)" }} />
      {tooltip && (
        <div style={{
          position: "fixed", left: tooltip.x, top: tooltip.y, zIndex: 9999,
          background: "rgba(10,25,47,0.95)", border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 6, padding: "6px 10px", fontSize: 11, lineHeight: "1.5",
          fontFamily: '"Courier New", monospace', color: "#e8e8e8",
          pointerEvents: "none", whiteSpace: "nowrap", maxWidth: 360,
        }}>
          {tooltip.text.map((line, i) => (
            <div key={i} style={{ fontWeight: i === 0 ? 700 : 400, color: i === 0 ? "#ffd700" : "#e8e8e8" }}>{line || "\u00A0"}</div>
          ))}
        </div>
      )}
    </div>
  );
});

// ══════════════════════════════════════════════════════════════════
//  Post-processing helpers
// ══════════════════════════════════════════════════════════════════

const TOOLTIP_TYPES = new Set([
  "transistor_nmos", "transistor_pmos",
  "transistor_npn", "transistor_pnp",
  "resistor_h", "resistor_v",
  "capacitor_h", "capacitor_v",
  "inductor_h", "inductor_v",
  "diode_h", "diode_v",
  "diode_schottky_h", "diode_schottky_v",
  "opamp", "voltage_source", "current_source",
]);

function annotateDeviceData(svg: SVGSVGElement, netlistJson: unknown): void {
  const nl = netlistJson as Record<string, any>;
  const modules = nl?.modules;
  if (!modules) return;
  const moduleName = Object.keys(modules)[0];
  if (!moduleName) return;
  const cells: Record<string, any> = modules[moduleName]?.cells;
  if (!cells) return;

  // Net names stored as _net_<port> attributes per cell (from format)

  const groups = svg.querySelectorAll<SVGGElement>("[s\\:type]");
  let annotated = 0;
  for (const g of groups) {
    const type = g.getAttribute("s:type");
    if (!type || !TOOLTIP_TYPES.has(type)) continue;

    let instName: string | null = null;
    for (const t of g.querySelectorAll<SVGTextElement>("text")) {
      const txt = t.textContent?.trim() || "";
      if (cells[txt]) { instName = txt; break; }
      const first = txt.split(/[\s\n\r]/)[0];
      if (first && cells[first]) { instName = first; break; }
    }
    if (!instName) continue;

    const cell = cells[instName];
    if (!cell) continue;

    const attrs = (cell.attributes || {}) as Record<string, string>;
    const lines: string[] = [instName];
    const hl = humanType(type);
    if (hl) lines[0] += ` — ${hl}`;
    if (attrs.value) {
      for (const v of attrs.value.split("\n")) if (v.trim()) lines.push(v.trim());
    }

    const conns = cell.connections as Record<string, number[]> | undefined;
    if (conns) {
      const nets: string[] = [];
      for (const [port, bits] of Object.entries(conns)) {
        const arr = Array.isArray(bits) ? bits : [bits];
        nets.push(`${port}→${attrs[`_net_${port}`] || `#${arr[0]}`}`);
      }
      if (nets.length > 0) { lines.push(""); lines.push(nets.join("  ")); }
    }

    g.setAttribute("data-instance", instName);
    g.setAttribute("data-tooltip", lines.join("␟"));
    annotated++;

    // Invisible hit rect — bbox of path elements only
    try {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      let ok = false;
      for (const p of g.querySelectorAll<SVGGraphicsElement>("path")) {
        const b = p.getBBox();
        if (b.width === 0 && b.height === 0) continue;
        x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
        x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height);
        ok = true;
      }
      if (ok) {
        const pad = 4;
        const hit = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        hit.setAttribute("x", String(x1 - pad));
        hit.setAttribute("y", String(y1 - pad));
        hit.setAttribute("width", String(x2 - x1 + pad * 2));
        hit.setAttribute("height", String(y2 - y1 + pad * 2));
        hit.style.stroke = "transparent";
        hit.style.fill = "transparent";
        hit.setAttribute("pointer-events", "all");
        g.insertBefore(hit, g.firstChild);
      }
    } catch (_) {}
  }
  console.log(`[Tooltips] annotated ${annotated}/${groups.length} groups`);
}

function humanType(type: string): string {
  const m: Record<string, string> = {
    transistor_nmos: "NMOS", transistor_pmos: "PMOS",
    transistor_npn: "NPN BJT", transistor_pnp: "PNP BJT",
    resistor_h: "Resistor", resistor_v: "Resistor",
    capacitor_h: "Capacitor", capacitor_v: "Capacitor",
    inductor_h: "Inductor", inductor_v: "Inductor",
    diode_h: "Diode", diode_v: "Diode",
    diode_schottky_h: "Schottky", diode_schottky_v: "Schottky",
    opamp: "Op-Amp", voltage_source: "V Source", current_source: "I Source",
  };
  return m[type] || "";
}

// ── Power net coloring ──────────────────────────────────────────

interface PowerNetColors { vdd: string; gnd: string; }
const DEF: PowerNetColors = { vdd: "#ff3344", gnd: "#3388ff" };

function colorPowerNets(svg: SVGSVGElement, c?: Partial<PowerNetColors>): void {
  const clr = { ...DEF, ...c };
  for (const g of svg.querySelectorAll<SVGGElement>('[s\\:type="vcc"], [s\\:type="gnd"]')) {
    const type = g.getAttribute("s:type");
    const ref = (g.querySelector("text")?.textContent || "").toLowerCase();
    const isVdd = type === "vcc" || ref === "vdd" || ref === "vcc";
    const isGnd = type === "gnd" || ref === "gnd" || ref === "vss";
    if (!isVdd && !isGnd) continue;
    const color = isVdd ? clr.vdd : clr.gnd;
    for (const p of g.querySelectorAll<SVGPathElement>("path")) { p.style.stroke = color; if (p.classList.contains("detail") || p.classList.contains("splitjoinBody")) p.style.fill = color; }
    for (const t of g.querySelectorAll<SVGTextElement>("text")) t.style.fill = color;

    const pa = g.querySelector<SVGGElement>('[s\\:pid="A"]'); if (!pa) continue;
    const px = parseFloat(pa.getAttribute("s:x") || "10"), py = parseFloat(pa.getAttribute("s:y") || "30");
    const m = (g.getAttribute("transform") || "").match(/translate\(([\d.]+),\s*([\d.]+)\)/); if (!m) continue;
    const ax = parseFloat(m[1]) + px, ay = parseFloat(m[2]) + py;

    for (const p of svg.querySelectorAll<SVGPathElement>("path")) {
      if (g.contains(p) || p.hasAttribute("data-power-colored")) continue;
      if (parsePathEndpoints(p.getAttribute("d") || "").some(([x, y]) => Math.abs(x - ax) <= 3 && Math.abs(y - ay) <= 3)) {
        p.style.stroke = color; p.setAttribute("data-power-colored", "true");
        if (p.classList.contains("detail") || p.classList.contains("junction") || p.classList.contains("splitjoinBody")) p.style.fill = color;
      }
    }
  }
}

function parsePathEndpoints(d: string): Array<[number, number]> {
  const r: Array<[number, number]> = []; const re = /[Mm]\s*([\d.\-]+)[,\s]+([\d.\-]+)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) r.push([parseFloat(m[1]), parseFloat(m[2])]);
  return r;
}

// ── Block label fix for functional diagrams ────────────────────
// netlist2svg's s:attribute="ref" text replacement doesn't work for
// sub_odd/sub_even types.  However, $cell_id IS replaced in CSS class
// attributes.  We extract the block name from the class list and set
// it as the text content of the title <text> element.

function fixBlockLabels(svg: SVGSVGElement): void {
  let fixed = 0;
  for (const textEl of svg.querySelectorAll<SVGTextElement>("text")) {
    const txt = textEl.textContent || "";
    if (txt !== "sub_odd" && txt !== "sub_even") continue;
    const cls = textEl.getAttribute("class") || "";
    const parts = cls.trim().split(/\s+/).filter(Boolean);
    // After $cell_id replacement, class should be "nodelabel <blockName>"
    const name = parts.find(p => p !== "nodelabel" && p !== "$cell_id" && p !== txt);
    console.log("[fixBlockLabels] found sub text:", { txt, cls, parts, name });
    if (name && name.length > 1) {
      textEl.textContent = name;
      fixed++;
    }
  }
  console.log(`[fixBlockLabels] fixed ${fixed} labels`);
}

// ── Loading indicator ───────────────────────────────────────────

function LoadingIndicator({ message }: { message: string }) {
  const [dots, setDots] = useState("");
  useEffect(() => { const t = setInterval(() => setDots(d => d.length < 3 ? d + "." : ""), 500); return () => clearInterval(t); }, []);
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, height: "100%", color: "var(--ink3)", fontSize: 11 }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", border: "2px solid var(--ink3)", borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} />
        <span>{message}{dots}</span>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
