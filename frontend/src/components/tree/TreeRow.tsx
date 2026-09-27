import { useEffect, useRef, useState } from "react";
import type { ReactNode, DragEventHandler } from "react";
import { Ic } from "../../icons";

export type ExpandState = "open" | "closed" | "leaf";

export type TreeRowProps = {
  depth?: number;
  expand?: ExpandState;
  swatch?: string;
  icon?: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  selected?: boolean;
  dimmed?: boolean;
  monoLabel?: boolean;
  onToggleExpand?: () => void;
  /** Click on the row body. Receives the mouse event so callers that support
   *  multi-select (e.g. the net list) can branch on shift/ctrl/cmd. */
  onSelect?: (e: React.MouseEvent) => void;
  /** Double-click the row (e.g. to frame this entity in the viewport). */
  onDoubleClick?: () => void;
  /** Triple-click the row (e.g. to solo layer selectability). */
  onTripleClick?: () => void;
  /** Optional native drag/drop hooks for reorderable rows. */
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLDivElement>;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  onDragEnd?: DragEventHandler<HTMLDivElement>;
  /** Render an eye / eye-off button at the right end; click toggles visibility.
   *  Optional `onLongPress` fires after holding the eye for LONG_PRESS_MS
   *  (the click that follows the release is swallowed, so it doesn't toggle). */
  visibility?: { visible: boolean; onToggle: () => void; onLongPress?: () => void };
  /** Render a lock / unlock button next to the eye; click toggles selectability. */
  selectable?: { selectable: boolean; onToggle: () => void };
  /** Extra controls (small action buttons) rendered before the visibility eye. */
  controls?: ReactNode;
};

const LONG_PRESS_MS = 2000;
/** Hovering a long-pressable eye this long reveals a hint about the gesture. */
const LONG_PRESS_HINT_MS = 5000;
/** The progress ring only appears once a press outlasts a normal click. */
const LONG_PRESS_RING_DELAY_MS = 500;

/**
 * One row of the outline tree, matching the hifi `.trow` design.
 * Caret area handles expand/collapse; the rest of the row handles selection.
 */
export function TreeRow({
  depth = 0,
  expand = "leaf",
  swatch,
  icon,
  label,
  meta,
  selected,
  dimmed,
  monoLabel,
  onToggleExpand,
  onSelect,
  onDoubleClick,
  onTripleClick,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  visibility,
  selectable,
  controls
}: TreeRowProps) {
  return (
    <div
      className={"trow" + (selected ? " sel" : "")}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        paddingLeft: 4 + depth * 12,
        opacity: dimmed ? 0.58 : 1,
        cursor: onSelect || onTripleClick ? "pointer" : "default"
      }}
      onClick={
        onSelect || onTripleClick
          ? (e) => {
              e.stopPropagation();
              // Triple-click fires on the 3rd click's onClick event.
              if (onTripleClick && e.detail === 3) onTripleClick();
              else if (onSelect) onSelect(e);
            }
          : undefined
      }
      onDoubleClick={onDoubleClick ? (e) => { e.stopPropagation(); onDoubleClick(); } : undefined}
    >
      <span
        onClick={
          expand === "leaf" || !onToggleExpand
            ? undefined
            : (e) => {
                e.stopPropagation();
                onToggleExpand();
              }
        }
        style={{
          width: 10,
          color: "var(--ink3)",
          display: "inline-flex",
          cursor: expand === "leaf" || !onToggleExpand ? "default" : "pointer"
        }}
      >
        {expand === "open" ? Ic.caretD : expand === "closed" ? Ic.caretR : null}
      </span>
      {swatch && (
        <span
          style={{
            width: 8,
            height: 8,
            background: swatch,
            border: "1px solid rgba(0,0,0,0.15)",
            borderRadius: 1,
            flex: "0 0 auto"
          }}
        />
      )}
      {icon && (
        <span
          style={{
            display: "inline-flex",
            color: selected ? "var(--accent)" : "var(--ink3)"
          }}
        >
          {icon}
        </span>
      )}
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: monoLabel ? "var(--mono)" : "var(--font)",
          fontSize: monoLabel ? 10.5 : 11
        }}
      >
        {label}
      </span>
      {meta != null && <span className="meta">{meta}</span>}
      {controls && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            marginLeft: meta == null ? "auto" : 4
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {controls}
        </span>
      )}
      {(selectable || visibility) && (
        <span
          style={{ display: "inline-flex", alignItems: "center", gap: 2, marginLeft: meta == null && !controls ? "auto" : 4 }}
          // Rapid clicks on the lock/eye are just repeated toggles — don't let
          // them bubble up as a row double-click (which frames the entity).
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {selectable && (
            <button
              type="button"
              className="trow-eye"
              aria-label={selectable.selectable ? "lock" : "unlock"}
              aria-pressed={!selectable.selectable}
              onClick={(e) => {
                e.stopPropagation();
                selectable.onToggle();
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: 0,
                padding: 0,
                color: selectable.selectable ? "var(--muted)" : "var(--ink)",
                cursor: "pointer"
              }}
            >
              {selectable.selectable ? Ic.unlock : Ic.lock}
            </button>
          )}
          {visibility && <EyeButton {...visibility} />}
        </span>
      )}
    </div>
  );
}

function EyeButton({
  visible,
  onToggle,
  onLongPress
}: NonNullable<TreeRowProps["visibility"]>) {
  const pressTimer = useRef<number | null>(null);
  const ringTimer = useRef<number | null>(null);
  const hintTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  // Bumped on every press so the progress ring remounts and its CSS
  // animation restarts from zero.
  const [pressKey, setPressKey] = useState<number | null>(null);
  const [hintAt, setHintAt] = useState<{ x: number; y: number } | null>(null);

  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    if (ringTimer.current !== null) {
      window.clearTimeout(ringTimer.current);
      ringTimer.current = null;
    }
    setPressKey(null);
  };
  const cancelHint = () => {
    if (hintTimer.current !== null) {
      window.clearTimeout(hintTimer.current);
      hintTimer.current = null;
    }
    setHintAt(null);
  };
  useEffect(
    () => () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
      if (ringTimer.current !== null) window.clearTimeout(ringTimer.current);
      if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    },
    []
  );

  return (
    <button
      type="button"
      className="trow-eye"
      aria-label={visible ? "hide" : "show"}
      aria-pressed={!visible}
      onPointerEnter={
        onLongPress
          ? (e) => {
              const el = e.currentTarget;
              cancelHint();
              hintTimer.current = window.setTimeout(() => {
                hintTimer.current = null;
                const r = el.getBoundingClientRect();
                setHintAt({ x: r.right + 6, y: r.top + r.height / 2 });
              }, LONG_PRESS_HINT_MS);
            }
          : undefined
      }
      onPointerDown={
        onLongPress
          ? (e) => {
              if (e.button !== 0) return;
              cancelHint();
              cancelPress();
              longPressFired.current = false;
              ringTimer.current = window.setTimeout(() => {
                ringTimer.current = null;
                setPressKey(Date.now());
              }, LONG_PRESS_RING_DELAY_MS);
              pressTimer.current = window.setTimeout(() => {
                pressTimer.current = null;
                longPressFired.current = true;
                setPressKey(null);
                onLongPress();
              }, LONG_PRESS_MS);
            }
          : undefined
      }
      onPointerUp={onLongPress ? cancelPress : undefined}
      onPointerLeave={
        onLongPress
          ? () => {
              cancelPress();
              cancelHint();
            }
          : undefined
      }
      onPointerCancel={onLongPress ? cancelPress : undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (longPressFired.current) {
          longPressFired.current = false;
          return;
        }
        onToggle();
      }}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: 0,
        padding: 0,
        color: visible ? "var(--ink3)" : "var(--muted)",
        cursor: "pointer"
      }}
    >
      {visible ? Ic.eye : Ic.eyeOff}
      {pressKey !== null && (
        <svg
          key={pressKey}
          className="trow-eye-ring"
          viewBox="0 0 20 20"
          aria-hidden
          // Start the fill already LONG_PRESS_RING_DELAY_MS in, so the ring
          // still completes exactly when the long press fires.
          style={{ ["--ring-delay" as string]: `-${LONG_PRESS_RING_DELAY_MS}ms` }}
        >
          <circle cx="10" cy="10" r="8.5" pathLength={1} />
        </svg>
      )}
      {hintAt && (
        <span className="trow-eye-hint" style={{ left: hintAt.x, top: hintAt.y }}>
          Hold 2s to zoom to fit
        </span>
      )}
    </button>
  );
}

/** Section separator between outline groups. */
export function TreeSep() {
  return <div style={{ borderTop: "1px solid var(--l1)", margin: "4px 0" }} />;
}
