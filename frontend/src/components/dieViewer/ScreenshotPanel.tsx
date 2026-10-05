import { useEffect, useRef } from "react";
import {
  SCREENSHOT_MIN_SCALE,
  SCREENSHOT_STEP,
  screenshotSize
} from "../../lib/screenshot";

interface Props {
  /** The screenshot button: the panel opens just below it, right-aligned. */
  anchor: DOMRect;
  scale: number;
  maxScale: number;
  /** On-screen canvas size in device px (what 1× produces). */
  baseWidth: number;
  baseHeight: number;
  /** Rendering status while a screenshot is in progress, else null. */
  busy: string | null;
  onScale: (scale: number) => void;
  onTake: () => void;
  onClose: () => void;
}

const fmtScale = (s: number) => `${+s.toFixed(2)}×`;

/** Small panel (right-click on the screenshot button) to pick its resolution. */
export function ScreenshotPanel({
  anchor,
  scale,
  maxScale,
  baseWidth,
  baseHeight,
  busy,
  onScale,
  onTake,
  onClose
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

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

  const width = 260;
  const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
  const top = anchor.bottom + 6;
  const out = screenshotSize(baseWidth, baseHeight, scale);
  const mp = (out.width * out.height) / 1e6;

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
        <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase" }}>
          Screenshot resolution
        </span>
        <span className="m" style={{ fontSize: 12, color: "var(--accent)" }}>
          {fmtScale(scale)}
        </span>
      </div>
      <input
        type="range"
        min={SCREENSHOT_MIN_SCALE}
        max={maxScale}
        step={SCREENSHOT_STEP}
        value={scale}
        disabled={!!busy}
        onChange={(e) => onScale(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: "var(--accent)" }}
        aria-label="Screenshot resolution"
        autoFocus
      />
      <div className="row m" style={{ justifyContent: "space-between", fontSize: 10, color: "#888" }}>
        <span>{fmtScale(SCREENSHOT_MIN_SCALE)}</span>
        <span>screen = 1×</span>
        <span>{fmtScale(maxScale)}</span>
      </div>
      <div className="m" style={{ margin: "10px 0", fontSize: 12 }}>
        {out.width.toLocaleString()} × {out.height.toLocaleString()} px
        <span style={{ color: "#888" }}> · {mp.toFixed(1)} MP</span>
      </div>
      <div className="row" style={{ gap: 8, justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, color: "#888" }}>{busy ?? "Left-click the button to reuse"}</span>
        <button className="btn sm accent" disabled={!!busy} onClick={onTake}>
          Save PNG
        </button>
      </div>
    </div>
  );
}
