/**
 * Netlist2SvgView.tsx — Lazy-loads netlist2svg (with ELK.js) and renders
 * a Yosys-format netlist as an SVG schematic.
 *
 * netlist2svg uses ELK.js for layout (~2MB, fetched from CDN on first use).
 */

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { buildSkin, type LayoutStrategy, type LayoutDirection, type CompactionLevel } from "../../lib/schematic/netlist2svgSkin";

// ── Types ───────────────────────────────────────────────────────

interface Netlist2SvgModule {
  render(
    skin: string,
    netlist: unknown,
    cb?: (err: Error | null, result?: string) => void,
  ): Promise<string>;
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

// ── Module-level loader state (survives HMR / re-mounts) ────────
// We track the actual loading progress of elk + netlist2svg so that
// multiple component mounts share one load cycle.

// Local copies served from public/lib/netlist2svg/ — no internet needed.
// To update, replace these files with newer releases from:
// https://github.com/ajsb85/netlist2svg/releases
const ELK_CDN = "/lib/netlist2svg/elk.bundled.js";
const N2S_CDN = "/lib/netlist2svg/netlist2svg.bundle.js";

declare global {
  interface Window {
    ELK?: new (...args: unknown[]) => unknown;
    netlist2svg?: Netlist2SvgModule;
  }
}

let loadPromise: Promise<void> | null = null;

/**
 * Idempotent loader: returns a single promise that resolves when both
 * ELK and netlist2svg are loaded and ready to use.
 * 
 * We load scripts as plain `<script>` tags (not `async`) so they execute
 * in order. After elk script loads we patch `.default` on the constructor
 * immediately, before the netlist2svg bundle runs and tries to use it.
 */
function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<void>((resolve, reject) => {
    try {
      // Step 1: inject elk.bundled.js as a sync script tag
      const elkScript = document.createElement("script");
      elkScript.src = ELK_CDN;
      // NOT async — we need ordering guarantees
      elkScript.onload = () => {
        // Patch ESM interop: netlist2svg expects `require("elkjs").default`
        if (window.ELK) {
          (window.ELK as any).default = window.ELK;
        }
        // Step 2: now inject netlist2svg.bundle.js
        const n2sScript = document.createElement("script");
        n2sScript.src = N2S_CDN;
        n2sScript.onload = () => {
          if (window.netlist2svg) {
            resolve();
          } else {
            reject(new Error("netlist2svg loaded but not found on window.netlist2svg"));
          }
        };
        n2sScript.onerror = () => reject(new Error(`Failed to load: ${N2S_CDN}`));
        document.head.appendChild(n2sScript);
      };
      elkScript.onerror = () => reject(new Error(`Failed to load: ${ELK_CDN}`));
      document.head.appendChild(elkScript);
    } catch (err) {
      reject(err);
    }
  });

  return loadPromise;
}

// ── Refs handle for parent access ───────────────────────────────

export interface Netlist2SvgHandle {
  /** Get SVG string with white background + black elements (for document export) */
  getSvgString(): string | null;
  /** Get the raw Yosys netlist JSON (for debug export) */
  getJson(): unknown;
  /** Get SVG bounding size */
  getSvgSize(): { width: number; height: number } | null;
}

// ── Component ───────────────────────────────────────────────────

interface Props {
  /** Yosys-format netlist JSON object */
  netlistJson: unknown;
  /** ELK layout strategy (default: BRANDES_KOEPF) */
  layoutStrategy?: LayoutStrategy;
  /** ELK layout direction (default: DOWN) */
  layoutDirection?: LayoutDirection;
  /** ELK post-compaction level 0-4 (default: 2 = Scanline) */
  compactionLevel?: CompactionLevel;
  /** Height of the schematic container (default: flex-fill) */
  height?: number | string;
}

export const Netlist2SvgView = forwardRef<Netlist2SvgHandle, Props>(function Netlist2SvgView({ netlistJson, height, layoutStrategy, layoutDirection, compactionLevel }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const renderSeq = useRef(0);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Expose download helpers to parent
  useImperativeHandle(ref, () => ({
    getSvgString() {
      const svg = svgRef.current;
      if (!svg) return null;
      const clone = svg.cloneNode(true) as SVGSVGElement;

      // Switch from dark theme (n2s-svg) to light theme (n2s-light)
      // The skin already defines .n2s-light CSS — just change the class
      if (clone.classList.contains("n2s-svg")) {
        clone.classList.remove("n2s-svg");
        clone.classList.add("n2s-light");
      }

      // Safety: inject missing light-theme rules in case skin is stale
      // (fill:none prevents solid-black fills on symbols; .symbol needs explicit stroke-width)
      const safetyStyle = document.createElementNS("http://www.w3.org/2000/svg", "style");
      safetyStyle.textContent = `
        .n2s-light { fill: none !important; }
        .n2s-light .symbol { stroke-width: 2; }
        .n2s-light .detail, .n2s-light .symbol { stroke-linejoin: round; stroke-linecap: round; }
      `;
      clone.prepend(safetyStyle);

      // Force white background on SVG root
      clone.style.background = "#ffffff";

      const serializer = new XMLSerializer();
      return serializer.serializeToString(clone);
    },
    getJson() {
      return netlistJson;
    },
    getSvgSize() {
      const svg = svgRef.current;
      if (!svg) return null;
      // Try viewBox first, then width/height attributes
      const vb = svg.getAttribute("viewBox");
      if (vb) {
        const parts = vb.split(/[\s,]+/).map(Number);
        if (parts.length === 4) {
          return { width: parts[2], height: parts[3] };
        }
      }
      const w = svg.getAttribute("width");
      const h = svg.getAttribute("height");
      if (w && h) {
        return { width: parseFloat(w), height: parseFloat(h) };
      }
      return { width: svg.clientWidth || 800, height: svg.clientHeight || 600 };
    },
  }), [netlistJson]);

  const renderSchematic = useCallback(async () => {
    console.log('[Netlist2Svg] render triggered, strategy:', layoutStrategy, 'direction:', layoutDirection);
    if (!window.ELK || !window.netlist2svg) return;
    const container = containerRef.current;
    if (!container) return;

    // Track render sequence — ignore stale results from older renders
    const seq = ++renderSeq.current;

    try {
      console.log('[Netlist2Svg] Layout strategy:', layoutStrategy, 'direction:', layoutDirection);

      const skin = buildSkin(layoutStrategy, layoutDirection, compactionLevel);
      let svg = await window.netlist2svg.render(
        skin,
        netlistJson,
      );
      if (seq !== renderSeq.current) return; // stale
      // The app is always in dark mode. Force .n2s-svg class on <svg> root
      // so all dark-theme CSS rules apply (white strokes/fills).
      svg = svg.replace("<svg ", `<svg class="n2s-svg" `);
      container.innerHTML = svg;
      // Keep a reference to the <svg> element for download export
      svgRef.current = container.querySelector("svg");
    } catch (err) {
      if (seq !== renderSeq.current) return; // stale
      console.error("[Netlist2Svg] render error:", err);
      const isElkError = String(err).includes("scanline") || String(err).includes("hitboxes");
      container.innerHTML = `<div style="padding:16px;color:var(--warn);font-style:italic;font-size:11px;">
        <div style="font-weight:600;margin-bottom:6px;">⚠ ELK layout error (netlist2svg)</div>
        <div style="margin-bottom:8px;">${err instanceof Error ? err.message : String(err)}</div>
        ${isElkError
          ? '<div style="color:var(--ink3);font-size:10px;">Try switching to <b>Spice-TS</b> renderer above, or check the Console (&gt;F12) for the full JSON dump.</div>'
          : ''}
      </div>`;
    }
  }, [netlistJson, layoutStrategy, layoutDirection, compactionLevel]);

  // Trigger load on mount
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus("loading");
      setErrorMsg(null);
      try {
        await ensureLoaded();
        if (!cancelled) setStatus("ready");
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setErrorMsg(
            `Failed to load: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  // Render when ready or netlist changes
  useEffect(() => {
    if (status === "ready" && netlistJson) {
      renderSchematic();
    }
  }, [status, netlistJson, layoutStrategy, renderSchematic]);

  // Clear svgRef when netlist changes (will be set again after render)
  useEffect(() => {
    svgRef.current = null;
  }, [netlistJson]);

  // ── Render ─────────────────────────────────────────────────

  if (status === "loading") {
    return (
      <LoadingIndicator message="Loading schematic engine (ELK.js)…" />
    );
  }

  if (status === "error") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: height ?? "100%",
          color: "var(--warn)",
          fontStyle: "italic",
          fontSize: 11,
          padding: 16,
        }}
      >
        ⚠ {errorMsg}
      </div>
    );
  }

  if (!netlistJson) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: height ?? "100%",
          color: "var(--ink3)",
          fontStyle: "italic",
          fontSize: 12,
        }}
      >
        No netlist data
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: height ?? "100%",
        overflow: "auto",
        background: "var(--card)",
      }}
    />
  );
});

// ── Loading indicator ───────────────────────────────────────────

function LoadingIndicator({ message }: { message: string }) {
  const [dots, setDots] = useState("");

  useEffect(() => {
    const t = setInterval(() => {
      setDots((d) => (d.length < 3 ? d + "." : ""));
    }, 500);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 8,
        height: "100%",
        color: "var(--ink3)",
        fontSize: 11,
      }}
    >
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: "50%",
            border: "2px solid var(--ink3)",
            borderTopColor: "transparent",
            animation: "spin 0.8s linear infinite",
          }}
        />
        <span>{message}{dots}</span>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
