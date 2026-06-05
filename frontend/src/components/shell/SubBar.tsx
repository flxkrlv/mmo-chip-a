import type { ReactNode } from "react";

type Props = {
  children?: ReactNode;
  right?: ReactNode;
};

export function SubBar({ children, right }: Props) {
  return (
    <div
      style={{
        height: 38,
        borderBottom: "1px solid var(--l2)",
        background: "var(--card)",
        display: "flex",
        alignItems: "center",
        padding: "0 8px",
        gap: 4,
        flex: "0 0 auto"
      }}
    >
      {children}
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}

export function ToolDivider() {
  return <div style={{ width: 1, height: 18, background: "var(--l2)", margin: "0 4px" }} />;
}
