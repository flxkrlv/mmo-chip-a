import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ic } from "../../icons";

/**
 * Reusable settings popover: a sliders trigger button (sized for a TreeRow's
 * controls slot) that opens a portal-rendered dark popover with click-outside
 * / Escape / scroll dismiss. Content is supplied by the caller.
 */
export function SettingsPopover({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const popWidth = popoverRef.current?.offsetWidth ?? 220;
    setPosition({ top: rect.bottom + 4, left: rect.right - popWidth });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function close() {
      setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="trow-action"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {Ic.sliders}
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="dark popover"
            role="dialog"
            aria-label={label}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              top: position?.top ?? -9999,
              left: position?.left ?? -9999,
              visibility: position ? "visible" : "hidden",
              width: 220
            }}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}

/** A horizontal row of round color swatches with a single active selection. */
export function ColorSwatches({
  options,
  value,
  onPick
}: {
  options: ReadonlyArray<{ label: string; value: string }>;
  value: string;
  onPick: (value: string) => void;
}) {
  return (
    <div className="row" style={{ gap: 8 }}>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.label}
            aria-label={opt.label}
            aria-pressed={active}
            onClick={() => onPick(opt.value)}
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              padding: 0,
              cursor: "pointer",
              background: opt.value,
              border: active ? "2px solid var(--ink)" : "2px solid transparent",
              boxShadow: active ? "0 0 0 1px var(--l2)" : "none"
            }}
          />
        );
      })}
    </div>
  );
}
