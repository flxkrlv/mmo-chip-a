import { useState } from "react";
import { Ic } from "../../icons";

const LS_PREFIX = "panel.collapsed.";

/** Persisted collapsed state for a named side panel (program-wide). */
export function usePanelCollapsed(id: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_PREFIX + id) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => setCollapsed((v) => {
    const next = !v;
    try {
      localStorage.setItem(LS_PREFIX + id, next ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    return next;
  });
  return [collapsed, toggle];
}

/** VSCode-style side-panel toggle button. */
export function PanelToggle({
  side,
  collapsed,
  onClick,
}: {
  side: "left" | "right";
  collapsed: boolean;
  onClick: () => void;
}) {
  const label = side === "left" ? "left" : "right";
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? `Show ${label} panel` : `Hide ${label} panel`}
      aria-pressed={!collapsed}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 22,
        padding: 0,
        border: "1px solid var(--l2)",
        borderRadius: 3,
        background: collapsed ? "var(--accent)" : "var(--l1)",
        color: collapsed ? "var(--accentFg, #fff)" : "var(--ink2)",
        cursor: "pointer",
        flex: "0 0 auto",
      }}
    >
      {side === "left" ? Ic.panelLeft : Ic.panelRight}
    </button>
  );
}
