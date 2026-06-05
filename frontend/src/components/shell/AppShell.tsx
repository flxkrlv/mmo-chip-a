import type { ReactNode } from "react";
import { TopBar } from "./TopBar";

type Props = {
  children: ReactNode;
  breadcrumb?: string;
  meta?: string;
  savedAgo?: string;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
};

export function AppShell({
  children,
  breadcrumb,
  meta,
  savedAgo,
  onUndo,
  onRedo,
  canUndo,
  canRedo
}: Props) {
  return (
    <div
      className="dark"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--ink)"
      }}
    >
      <TopBar
        breadcrumb={breadcrumb}
        meta={meta}
        savedAgo={savedAgo}
        onUndo={onUndo}
        onRedo={onRedo}
        canUndo={canUndo}
        canRedo={canRedo}
      />
      {children}
    </div>
  );
}
