import { Fragment, type ReactNode } from "react";

type Props = {
  items: ReactNode[];
  online?: boolean;
};

export function StatusBar({ items, online = true }: Props) {
  return (
    <div
      className="m"
      style={{
        height: 24,
        borderTop: "1px solid var(--l2)",
        background: "var(--panel)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 12,
        fontSize: 10.5,
        color: "var(--ink2)",
        flex: "0 0 auto"
      }}
    >
      {items.map((it, i) => (
        <Fragment key={i}>
          <span>{it}</span>
          {i < items.length - 1 && <span style={{ color: "var(--muted)" }}>·</span>}
        </Fragment>
      ))}
      <div style={{ flex: 1 }} />
      {/* TODO */}
      {/* {online && <span style={{ color: "var(--ink3)" }}>● online</span>} */}
    </div>
  );
}
