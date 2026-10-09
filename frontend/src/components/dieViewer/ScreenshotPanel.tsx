import { useEffect, useRef } from "react";
import { useLiveValue, type LiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";
import {
  SCREENSHOT_MAX_PIXELS,
  SCREENSHOT_MIN_SCALE,
  maxScreenshotScale,
  nativeScreenshotScale,
  resolveScreenshotScale,
  scaleToSlider,
  screenshotSize,
  sliderToScale,
  snapScreenshotScale,
  type ScreenshotScale
} from "../../lib/screenshot";

interface Props {
  /** The screenshot button: the panel opens just below it, right-aligned. */
  anchor: DOMRect;
  scale: ScreenshotScale;
  /** Live viewport: native resolution follows the zoom. */
  viewport: LiveValue<Viewport | null>;
  /** On-screen device px per CSS px. */
  dpr: number;
  /** Source px per pixel of the die's finest pyramid level (usually 1). */
  finestLevelScale: number;
  /** On-screen canvas size in device px (what 1× produces). */
  baseWidth: number;
  baseHeight: number;
  /** Rendering status while a screenshot is in progress, else null. */
  busy: string | null;
  onScale: (scale: ScreenshotScale) => void;
  onTake: () => void;
  onCancel: () => void;
  onClose: () => void;
}

const fmtScale = (s: number) => `${s < 10 ? +s.toFixed(2) : Math.round(s)}×`;
const fmtPixels = (px: number) =>
  px >= 1e9 ? `${(px / 1e9).toFixed(2)} GP` : `${(px / 1e6).toFixed(1)} MP`;

/** Small panel (right-click on the screenshot button) to pick its resolution. */
export function ScreenshotPanel({
  anchor,
  scale,
  viewport,
  dpr,
  finestLevelScale,
  baseWidth,
  baseHeight,
  busy,
  onScale,
  onTake,
  onCancel,
  onClose
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const vp = useLiveValue(viewport);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const native = nativeScreenshotScale(vp?.zoom ?? 1, dpr, finestLevelScale);
  const max = maxScreenshotScale(baseWidth, baseHeight, native);
  const current = resolveScreenshotScale(scale, native, max);
  const out = screenshotSize(baseWidth, baseHeight, current);
  const nativeOut = screenshotSize(baseWidth, baseHeight, native);
  const nativeCapped = native > max;
  const isNative = scale === "native" || Math.abs(current - Math.min(native, max)) < 1e-6;

  const width = 290;
  const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
  const top = anchor.bottom + 6;
  const muted = { fontSize: 10, color: "#888" } as const;

  return (
    <div
      ref={ref}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        left,
        top,
        width,
        zIndex: 1000,
        background: "#2a2a2e",
        border: "1px solid #444",
        borderRadius: 8,
        padding: 12,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        color: "#ddd",
        fontSize: 12
      }}
    >
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ ...muted, textTransform: "uppercase" }}>Screenshot resolution</span>
        <span className="m" style={{ fontSize: 12, color: "var(--accent)" }}>
          {isNative ? `native · ${fmtScale(current)}` : fmtScale(current)}
        </span>
      </div>
      <input
        type="range"
        min={scaleToSlider(SCREENSHOT_MIN_SCALE)}
        max={scaleToSlider(max)}
        step={0.01}
        value={scaleToSlider(current)}
        disabled={!!busy}
        onChange={(e) => {
          const s = sliderToScale(parseFloat(e.target.value));
          // Snap onto native when close to it, else to a readable step.
          const nearNative = Math.abs(Math.log2(s) - Math.log2(Math.min(native, max))) < 0.04;
          onScale(nearNative ? "native" : Math.min(max, Math.max(SCREENSHOT_MIN_SCALE, snapScreenshotScale(s))));
        }}
        style={{ width: "100%", accentColor: "var(--accent)" }}
        aria-label="Screenshot resolution"
        autoFocus
      />
      <div className="row m" style={{ ...muted, justifyContent: "space-between" }}>
        <span>{fmtScale(SCREENSHOT_MIN_SCALE)}</span>
        <span>1× = screen</span>
        <span>{fmtScale(max)}</span>
      </div>
      <div className="m" style={{ margin: "10px 0 4px", fontSize: 12 }}>
        {out.width.toLocaleString()} × {out.height.toLocaleString()} px
        <span style={{ color: "#888" }}> · {fmtPixels(out.width * out.height)}</span>
      </div>
      <div style={{ ...muted, marginBottom: 10 }}>
        {nativeCapped
          ? `Native here would be ${fmtScale(native)} (${fmtPixels(nativeOut.width * nativeOut.height)}) — over the ${fmtPixels(SCREENSHOT_MAX_PIXELS)} limit; zoom in to get there.`
          : `Native (1 px per die pixel) is ${fmtScale(native)} at this zoom.`}
      </div>
      <div className="row" style={{ gap: 6, justifyContent: "space-between" }}>
        <button
          className="btn sm plain"
          disabled={!!busy || scale === "native"}
          onClick={() => onScale("native")}
          title="Always the die's full tile resolution for the current zoom"
        >
          Native
        </button>
        <span style={{ ...muted, flex: 1, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis" }}>
          {busy ?? ""}
        </span>
        {busy ? (
          <button className="btn sm" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button className="btn sm accent" onClick={onTake}>
            Save PNG
          </button>
        )}
      </div>
    </div>
  );
}
