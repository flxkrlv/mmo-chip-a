import { useEffect, useRef } from "react";
import type { AnalogDevice, AssistantFinding } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import { useLiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";

const FINDING_COLORS: Record<AssistantFinding["kind"], string> = {
  diode_connected_device: "#9aa7bd",
  current_mirror: "#ffaa44",
  bjt_current_mirror: "#f59e42",
  bjt_current_source: "#eab676",
  widlar_current_source: "#db9a44",
  differential_pair: "#b56cff",
  bjt_differential_pair: "#bc72f5",
  ldo_error_amplifier_feedback: "#57b6ff",
  resistor_divider: "#f2cf4a",
  protection_clamp: "#ff6f91",
  llm_hypothesis: "#67c5ff",
  netlist_problem: "#ff5f56",
  positive_feedback_loop: "#ff6f91",
  bandgap_precursor: "#44ddff",
};

// Fallback so a finding whose kind is not in the palette (e.g. an LLM-proposed
// kind string) never resolves to `undefined` and paints a solid black box.
const FALLBACK_COLOR = "#8aa0c0";

interface Props {
  devices: AnalogDevice[];
  findings: AssistantFinding[];
  activeFindingId: string | null;
  viewportStore: LiveValue<Viewport | null>;
}

/**
 * A non-interactive overlay deliberately separate from AnalogDeviceHighlights.
 * It exists only while assistant results are in browser memory and therefore
 * cannot modify, persist or accidentally become a design annotation.
 */
export function SubcircuitHighlightsOverlay({ devices, findings, activeFindingId, viewportStore }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewport = useLiveValue(viewportStore);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;

    const draw = () => {
      raf = 0;
      const vp = viewportRef.current;
      if (!vp) return;
      const box = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(box.width * dpr));
      const height = Math.max(1, Math.round(box.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, box.width, box.height);

      const byUuid = new Map(devices.map((device) => [String((device as any)._uuid ?? device.id), device]));
      for (const finding of findings) {
        const active = activeFindingId === finding.id;
        const color = FINDING_COLORS[finding.kind] ?? FALLBACK_COLOR;
        const findingDevices = finding.deviceUuids
          .map((uuid) => byUuid.get(String(uuid)))
          .filter((device): device is AnalogDevice => Boolean(device?.bbox));

        // Draw one die-world box per referenced device. A finding may span
        // distant regions of the die, so a single union rectangle is misleading.
        for (const device of findingDevices) {
          const b = device.bbox!;
          const margin = 10 / vp.zoom;
          const sx = (b.x - margin - vp.originX) * vp.zoom;
          const sy = (b.y - margin - vp.originY) * vp.zoom;
          const sw = (b.width + margin * 2) * vp.zoom;
          const sh = (b.height + margin * 2) * vp.zoom;
          if (sx + sw < -40 || sx > box.width + 40 || sy + sh < -40 || sy > box.height + 40) continue;

          ctx.save();
          ctx.globalAlpha = active ? 1 : 0.6;
          ctx.strokeStyle = color;
          // Translucent fill with an 8-digit hex alpha suffix; harmless if the
          // color is the fallback (still a valid 7-char hex).
          ctx.fillStyle = active ? color + "33" : color + "22";
          ctx.lineWidth = active ? 3 : 1.5;
          // Corrected (user/LLM-updated) findings get a solid outline so they
          // read as confirmed, while unconfirmed hypotheses stay dashed.
          ctx.setLineDash(active || finding.userCorrected ? [] : [5, 4]);
          ctx.strokeRect(sx, sy, sw, sh);
          ctx.fillRect(sx, sy, sw, sh);
          if (active || finding.userCorrected || (sw * sh > 4_500 && vp.zoom >= 0.4)) {
            const deviceName = device.instanceName ?? device.id;
            const text = `${deviceName} · ${finding.confidenceLevel}${finding.userCorrected ? " · ✓" : ""}`;
            ctx.font = "600 11px monospace";
            const textWidth = ctx.measureText(text).width + 10;
            ctx.fillStyle = "rgba(8, 12, 24, .88)";
            ctx.fillRect(sx, Math.max(0, sy - 20), textWidth, 18);
            ctx.fillStyle = color;
            ctx.textBaseline = "middle";
            ctx.fillText(text, sx + 5, Math.max(9, sy - 11));
          }
          ctx.restore();
        }
      }
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
    draw();
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    const unsubscribe = viewportStore.subscribe(schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      unsubscribe();
    };
  }, [devices, findings, activeFindingId, viewportStore]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "block",
        pointerEvents: "none",
        zIndex: 7,
      }}
      aria-hidden="true"
    />
  );
}
