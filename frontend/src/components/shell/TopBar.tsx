import { NavLink } from "react-router-dom";
import { BrandMark, Ic } from "../../icons";
import { useSession } from "../../state/session";

// `die` controls how the active die is carried into the tab's URL:
//   "none"  — never (Library is the chooser)
//   "param" — path param (/die/:dieId)
//   "query" — ?die=<id> (other phases; harmless if unused yet)
const PHASE_TABS = [
  { path: "/", label: "Library", end: true, die: "none" as const },
  { path: "/die", label: "Die viewer", die: "param" as const },
  { path: "/merge", label: "Merge cells", die: "query" as const },
  { path: "/re", label: "RE cell", die: "query" as const },
  { path: "/code", label: "Code", die: "query" as const },
  { path: "/analog-netlist", label: "Netlist (Analog)", die: "query" as const }
];

function tabTarget(
  tab: (typeof PHASE_TABS)[number],
  dieId: string | null
): string {
  if (!dieId || tab.die === "none") return tab.path;
  if (tab.die === "param") return `/die/${dieId}`;
  return `${tab.path}?die=${encodeURIComponent(dieId)}`;
}

type Props = {
  breadcrumb?: string;
  meta?: string;
  savedAgo?: string;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
};

export function TopBar({ breadcrumb, meta, savedAgo, onUndo, onRedo, canUndo, canRedo }: Props) {
  const showHistory = !!(onUndo || onRedo);
  const dieId = useSession((s) => s.dieId);
  return (
    <div
      style={{
        height: 38,
        borderBottom: "1px solid var(--l2)",
        background: "var(--card)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 14,
        flex: "0 0 auto"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <BrandMark style={{ flex: "0 0 auto" }} />
        <div
          className="m"
          style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink)", letterSpacing: 0.6 }}
        >
          MMO<span style={{ color: "var(--ink3)" }}>·</span>CHIP
        </div>
      </div>
      <Divider />
      <nav className="row" style={{ gap: 0 }}>
        {PHASE_TABS.map((t) => (
          <NavLink
            key={t.path}
            to={tabTarget(t, dieId)}
            end={t.end}
            className={({ isActive }) => "tab" + (isActive ? " on" : "")}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      {(breadcrumb || meta) && (
        <>
          <Divider />
          <div className="row" style={{ gap: 6 }}>
            {breadcrumb && (
              <span
                className="m"
                style={{ fontSize: 11, color: "var(--ink2)", fontWeight: 500 }}
              >
                {breadcrumb}
              </span>
            )}
            {meta && (
              <span className="m" style={{ fontSize: 10.5, color: "var(--ink3)" }}>
                · {meta}
              </span>
            )}
          </div>
        </>
      )}
      <div style={{ flex: 1 }} />
      {showHistory && (
        <>
          <button
            className="btn ghost"
            title="Undo"
            onClick={onUndo}
            disabled={!onUndo || canUndo === false}
          >
            {Ic.undo}
          </button>
          <button
            className="btn ghost"
            title="Redo"
            onClick={onRedo}
            disabled={!onRedo || canRedo === false}
          >
            {Ic.redo}
          </button>
        </>
      )}
      {savedAgo && (
        <>
          {showHistory && <Divider />}
          <span className="m" style={{ fontSize: 10.5, color: "var(--ink3)" }}>
            {savedAgo}
          </span>
        </>
      )}
    </div>
  );
}

function Divider() {
  return <div style={{ width: 1, height: 18, background: "var(--l2)" }} />;
}
