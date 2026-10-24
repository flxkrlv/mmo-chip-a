import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  STATUS_BAR_PADDING_X,
  marqueeDuration,
  marqueeNeeded
} from "../../lib/statusMarquee";

type Props = {
  items: ReactNode[];
  online?: boolean;
};

/**
 * The bottom status line.
 *
 * It keeps a fixed height and never wraps: it sits in the flex column
 * under the canvas, so a wrapped second line would shrink the canvas and
 * make it flicker. When the text does not fit into the line, a second copy
 * of it is added and the whole thing scrolls like a ticker - the height
 * stays the same, the text is still readable.
 */
export function StatusBar({ items, online = true }: Props) {
  const viewRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<() => void>(() => {});
  const [scrolling, setScrolling] = useState(false);
  const [seconds, setSeconds] = useState(0);

  // Watch the line and its content: whenever the text grows (a hovered
  // net, a tool hint) or the window changes, we re-check whether it fits.
  useLayoutEffect(() => {
    const view = viewRef.current;
    const copy = copyRef.current;
    if (!view || !copy) return;
    const measure = () => {
      const content = copy.offsetWidth;
      const avail = view.clientWidth - STATUS_BAR_PADDING_X;
      const need = marqueeNeeded(content, avail);
      setScrolling((prev) => (prev === need ? prev : need));
      setSeconds((prev) => {
        const next = need ? marqueeDuration(content) : 0;
        return prev === next ? prev : next;
      });
    };
    measureRef.current = measure;
    const ro = new ResizeObserver(measure);
    ro.observe(view);
    ro.observe(copy);
    measure();
    return () => {
      ro.disconnect();
      measureRef.current = () => {};
    };
  }, []);

  // The items are new nodes on every render. Re-measure when their text
  // changes; the parts that render on their own (the readouts) are caught
  // by the observer above.
  const itemsSig = items
    .map((it) => (typeof it === "string" || typeof it === "number" ? String(it) : "·"))
    .join("|");
  useLayoutEffect(() => {
    measureRef.current();
  }, [itemsSig]);

  const renderItems = () => (
    <>
      {items.map((it, i) => (
        <Fragment key={i}>
          <span>{it}</span>
          {i < items.length - 1 && <span style={{ color: "var(--muted)" }}>·</span>}
        </Fragment>
      ))}
    </>
  );

  return (
    <div
      ref={viewRef}
      className="m"
      style={{
        height: 24,
        // The line must not grow with its content - that is what made the
        // canvas above flicker.
        minHeight: 0,
        flex: "0 0 auto",
        borderTop: "1px solid var(--l2)",
        background: "var(--panel)",
        overflow: "hidden",
        padding: "0 12px",
        fontSize: 10.5,
        color: "var(--ink2)",
        whiteSpace: "nowrap"
      }}
    >
      <div
        className={scrolling ? "sb-track sb-track--scroll" : "sb-track"}
        style={scrolling ? { animationDuration: `${seconds}s` } : undefined}
      >
        <div ref={copyRef} className="sb-copy">
          {renderItems()}
        </div>
        {scrolling && (
          <div className="sb-copy" aria-hidden="true">
            {renderItems()}
          </div>
        )}
      </div>
      {/* TODO */}
      {/* {online && <span style={{ color: "var(--ink3)" }}>● online</span>} */}
    </div>
  );
}
