import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Ic } from "../../icons";

/**
 * Collapsible section with a native CSS resize handle (width + height).
 * Size and open/closed state persist in localStorage per `id`.
 */
interface Props {
  /** localStorage key suffix; must be stable and unique per section. */
  id: string;
  title: string;
  count?: number | string | null;
  defaultWidth?: number;
  defaultHeight?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

const LS_PREFIX = "lvs.sec.";

function readLS(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLS(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — ignore */
  }
}

function readSize(id: string): { w: number | null; h: number | null } {
  const w = parseFloat(readLS(`${LS_PREFIX}${id}.w`) ?? "");
  const h = parseFloat(readLS(`${LS_PREFIX}${id}.h`) ?? "");
  return {
    w: Number.isFinite(w) && w > 0 ? w : null,
    h: Number.isFinite(h) && h > 0 ? h : null,
  };
}

export default function ResizableSection({
  id,
  title,
  count,
  defaultWidth = 360,
  defaultHeight = 220,
  defaultOpen = true,
  children,
}: Props) {
  const [open, setOpen] = useState<boolean>(() => {
    const v = readLS(`${LS_PREFIX}${id}.open`);
    return v === null ? defaultOpen : v === "1";
  });

  const bodyRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | null>(null);
  const lastSize = useRef<{ w: number; h: number } | null>(null);

  // Restore size imperatively so React never re-applies a stale inline size
  // (which would cancel the user's drag on the next re-render).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const { w, h } = readSize(id);
    el.style.width = `${w ?? defaultWidth}px`;
    el.style.height = `${h ?? defaultHeight}px`;
  }, [id, open, defaultWidth, defaultHeight]);

  // Persist size after native resize (debounced); flush on collapse/unmount.
  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (!el) return;
    lastSize.current = { w: el.offsetWidth, h: el.offsetHeight };
    const ro = new ResizeObserver(() => {
      const node = bodyRef.current;
      if (!node) return;
      const w = node.offsetWidth;
      const h = node.offsetHeight;
      lastSize.current = { w, h };
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        writeLS(`${LS_PREFIX}${id}.w`, String(w));
        writeLS(`${LS_PREFIX}${id}.h`, String(h));
      }, 200);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      if (lastSize.current) {
        writeLS(`${LS_PREFIX}${id}.w`, String(lastSize.current.w));
        writeLS(`${LS_PREFIX}${id}.h`, String(lastSize.current.h));
      }
    };
  }, [id, open]);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      writeLS(`${LS_PREFIX}${id}.open`, next ? "1" : "0");
      return next;
    });
  };

  return (
    <div
      style={{
        margin: "0 10px 8px",
        border: "1px solid var(--l2)",
        borderRadius: 4,
        overflow: "hidden",
        background: "var(--card)",
      }}
    >
      <button
        type="button"
        onClick={toggle}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 6px",
          border: 0,
          cursor: "pointer",
          background: "var(--l1)",
          color: "var(--ink2)",
          textAlign: "left",
        }}
      >
        <span style={{ color: "var(--ink3)", display: "inline-flex" }}>
          {open ? Ic.caretD : Ic.caretR}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600 }}>{title}</span>
        {count != null && (
          <span style={{ fontSize: 10, color: "var(--ink3)" }}>({count})</span>
        )}
      </button>
      {open && (
        <div
          ref={bodyRef}
          style={{
            minWidth: 180,
            minHeight: 80,
            maxWidth: "100%",
            boxSizing: "border-box",
            resize: "both",
            overflow: "auto",
            padding: "4px 6px",
            background: "var(--card)",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
