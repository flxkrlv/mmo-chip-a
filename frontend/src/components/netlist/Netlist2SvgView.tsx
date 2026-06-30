/**
 * Netlist2SvgView.tsx — Lazy-loads netlist2svg (with ELK.js) and renders
 * a Yosys-format netlist as an SVG schematic.
 *
 * netlist2svg uses ELK.js for layout (~2MB, fetched from CDN on first use).
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { buildSkin, type LayoutStrategy, type LayoutDirection } from "../../lib/schematic/netlist2svgSkin";

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

const ELK_CDN =
  "https://github.com/ajsb85/netlist2svg/releases/download/v1.1.2/elk.bundled.js";
const N2S_CDN =
  "https://github.com/ajsb85/netlist2svg/releases/download/v1.1.2/netlist2svg.bundle.js";

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

// ── Component ───────────────────────────────────────────────────

interface Props {
  /** Yosys-format netlist JSON object */
  netlistJson: unknown;
  /** ELK layout strategy (default: BRANDES_KOEPF) */
  layoutStrategy?: LayoutStrategy;
  /** ELK layout direction (default: DOWN) */
  layoutDirection?: LayoutDirection;
  /** Height of the schematic container (default: flex-fill) */
  height?: number | string;
}

export function Netlist2SvgView({ netlistJson, height, layoutStrategy, layoutDirection }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const renderSeq = useRef(0);

  const renderSchematic = useCallback(async () => {
    console.log('[Netlist2Svg] render triggered, strategy:', layoutStrategy, 'direction:', layoutDirection);
    if (!window.ELK || !window.netlist2svg) return;
    const container = containerRef.current;
    if (!container) return;

    // Track render sequence — ignore stale results from older renders
    const seq = ++renderSeq.current;

    try {
      console.log('[Netlist2Svg] Layout strategy:', layoutStrategy, 'direction:', layoutDirection);

      const skin = buildSkin(layoutStrategy, layoutDirection);
      let svg = await window.netlist2svg.render(
        skin,
        netlistJson,
      );
      if (seq !== renderSeq.current) return; // stale
      // The app is always in dark mode. Force .dark class on <svg> root
      // so all dark-theme CSS rules apply (white strokes/fills).
      svg = svg.replace("<svg ", `<svg class="dark" `);
      container.innerHTML = svg;
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
  }, [netlistJson, layoutStrategy, layoutDirection]);

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
}

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
