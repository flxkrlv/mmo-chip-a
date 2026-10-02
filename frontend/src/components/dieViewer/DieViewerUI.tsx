import type { DieAnnotations } from "shared";
import type { Rect } from "../../lib/geometry";
import { formatPercent } from "../../lib/format";
import { withShortcut } from "../../lib/hotkeys";
import { useLiveValue, type LiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";

/** Small presentational pieces for the Die viewer. Kept dumb so they can
 *  subscribe to hot-path LiveValues without re-rendering the page. */

export function MarqueeOverlay({ store }: { store: LiveValue<Rect | null> }) {
  const rect = useLiveValue(store);
  if (!rect) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        border: "1px solid rgba(58, 169, 255, 0.95)",
        background: "rgba(58, 169, 255, 0.12)",
        pointerEvents: "none"
      }}
    />
  );
}

export function ZoomChip({ store }: { store: LiveValue<Viewport | null> }) {
  const vp = useLiveValue(store);
  return <span className="chip">{vp ? formatPercent(vp.zoom * 100) : "—"}</span>;
}

export function ZoomReadout({ store }: { store: LiveValue<Viewport | null> }) {
  const vp = useLiveValue(store);
  return <span>{vp ? formatPercent(vp.zoom * 100) : "—"}</span>;
}

export function CursorReadout({
  store
}: {
  store: LiveValue<{ x: number; y: number } | null>;
}) {
  const c = useLiveValue(store);
  if (!c) return <span style={{ color: "var(--ink3)" }}>x — · y —</span>;
  return (
    <span>
      x {Math.round(c.x).toLocaleString()} · y {Math.round(c.y).toLocaleString()}
    </span>
  );
}

/** What the cursor is currently over: the net a hovered wire/vertex belongs
 *  to, the cell type(s) of any visible cells under the cursor and the
 *  floorplan type(s) of any regions containing it. */
export interface HoverInfo {
  net: string | null;
  cells: string[];
  floorplans: string[];
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export function sameHoverInfo(a: HoverInfo | null, b: HoverInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.net === b.net &&
    sameList(a.cells, b.cells) &&
    sameList(a.floorplans, b.floorplans)
  );
}

/** Renders its own leading separators so it can sit inside the cursor item
 *  without leaving a dangling "·" in the status bar when nothing is hovered. */
export function HoverReadout({ store }: { store: LiveValue<HoverInfo | null> }) {
  const h = useLiveValue(store);
  if (!h) return null;
  const sep = <span style={{ color: "var(--muted)", margin: "0 6px" }}>·</span>;
  return (
    <>
      {h.net != null && (
        <>
          {sep}
          <span>
            net <span style={{ color: "var(--ink)" }}>{h.net}</span>
            <span style={{ color: "var(--muted)", marginLeft: 6 }}>
              (double-click: rename · hold 2s: select &amp; fit)
            </span>
          </span>
        </>
      )}
      {h.cells.length > 0 && (
        <>
          {sep}
          <span>
            cell <span style={{ color: "var(--ink)" }}>{h.cells.join(", ")}</span>
          </span>
        </>
      )}
      {h.floorplans.length > 0 && (
        <>
          {sep}
          <span>
            floorplan <span style={{ color: "var(--ink)" }}>{h.floorplans.join(", ")}</span>
          </span>
        </>
      )}
    </>
  );
}

/**
 * Progress ring at the cursor while a net is press-and-held on the canvas
 * (same look and timing as the outline eye's long press). `store` holds the
 * canvas-relative position; `key` restarts the CSS animation per press.
 */
export function NetHoldRing({
  store,
  delayMs
}: {
  store: LiveValue<{ x: number; y: number; key: number } | null>;
  delayMs: number;
}) {
  const at = useLiveValue(store);
  if (!at) return null;
  return (
    <div
      style={{ position: "absolute", left: at.x, top: at.y, width: 0, height: 0, zIndex: 20, pointerEvents: "none" }}
    >
      <svg
        key={at.key}
        className="trow-eye-ring"
        viewBox="0 0 20 20"
        aria-hidden
        // The ring appears `delayMs` into the hold; start its fill there so it
        // completes exactly when the hold fires.
        style={{ width: 28, height: 28, ["--ring-delay" as string]: `-${delayMs}ms` }}
      >
        <circle cx="10" cy="10" r="8.5" pathLength={1} />
      </svg>
    </div>
  );
}

export function annotationsSummary(a: DieAnnotations): string | null {
  const counts: string[] = [];
  if (a.cells.length) counts.push(`${a.cells.length} cells`);
  const emptyTypes = a.cellTypes.filter(
    (ct) => !ct.layers || Object.keys(ct.layers).length === 0,
  ).length;
  if (emptyTypes) counts.push(`${emptyTypes} empty`);
  if (a.nets.length) counts.push(`${a.nets.length} nets`);
  const vias = a.annotations?.length ?? 0;
  if (vias) counts.push(`${vias} vias`);
  if (a.rois?.length) counts.push(`${a.rois.length} rois`);
  if (a.ignores?.length) counts.push(`${a.ignores.length} ignores`);
  if (a.pins?.length) counts.push(`${a.pins.length} pins`);
  return counts.length ? counts.join(" · ") : null;
}

export const panelStyle: React.CSSProperties = {
  background: "var(--card)",
  borderRight: "1px solid var(--l2)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0
};

export function Tool({
  icon,
  on,
  label,
  shortcut,
  todo,
  onClick
}: {
  icon: React.ReactNode;
  on?: boolean;
  label?: string;
  /** Keyboard shortcut appended to the tooltip, e.g. "W". */
  shortcut?: string;
  /** Not implemented yet — renders disabled with a "(coming soon)" hint. */
  todo?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={"tool" + (on ? " on" : "") + (todo ? " todo" : "")}
      title={todo ? `${label ?? ""} (coming soon)` : withShortcut(label ?? "", shortcut) || undefined}
      disabled={todo}
      onClick={todo ? undefined : onClick}
    >
      {icon}
    </button>
  );
}

/** A wider, slightly stronger separator between major toolbar regions
 *  (e.g. tools → per-tool options). */
export function BigToolDivider() {
  return (
    <div
      style={{
        width: 1,
        height: 22,
        background: "var(--l3)",
        margin: "0 10px"
      }}
    />
  );
}

export function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        flex: "1 1 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 10.5,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: "var(--ink3)"
      }}
    >
      {children}
    </div>
  );
}

export function CenteredStatus({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "rgba(255,255,255,0.6)",
        fontSize: 11,
        letterSpacing: 0.4
      }}
    >
      {children}
    </div>
  );
}
