import { useMemo, useState } from "react";
import { Ic } from "../../icons";
import type { CodeProblem, ProblemSeverity } from "../../api/codeGen";

type Filter = "all" | "err" | "warn";

interface Props {
  problems: CodeProblem[];
  onJump: (line: number) => void;
  onClose: () => void;
}

/**
 * Bottom-of-page problems strip. Lists every netlist / extractor warning and
 * lets the user filter by severity and jump to the line in the editor.
 *
 * The whole panel is collapsible from the toolbar (controlled by `onClose`);
 * within it, the filter chips are local state.
 */
export function ProblemsPanel({ problems, onJump, onClose }: Props) {
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => {
    let err = 0;
    let warn = 0;
    for (const p of problems) {
      if (p.severity === "err") err++;
      else warn++;
    }
    return { err, warn, total: problems.length };
  }, [problems]);

  const filtered = useMemo(
    () => (filter === "all" ? problems : problems.filter((p) => p.severity === filter)),
    [problems, filter],
  );

  return (
    <div
      style={{
        height: 180,
        flex: "0 0 auto",
        borderTop: "1px solid var(--l2)",
        background: "var(--card)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {/* Header strip: title + counts + severity filter + close. */}
      <div
        className="ph"
        style={{
          gap: 8,
        }}
      >
        <span
          className="m"
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--ink2)",
            letterSpacing: 0.6,
          }}
        >
          PROBLEMS
        </span>
        <span className={counts.err > 0 ? "chip err" : "chip"}>{counts.err} err</span>
        <span className={counts.warn > 0 ? "chip warn" : "chip"}>{counts.warn} warn</span>
        <div style={{ flex: 1 }} />
        <FilterChip current={filter} value="all" onSelect={setFilter}>
          all
        </FilterChip>
        <FilterChip current={filter} value="err" onSelect={setFilter}>
          err
        </FilterChip>
        <FilterChip current={filter} value="warn" onSelect={setFilter}>
          warn
        </FilterChip>
        <button
          type="button"
          className="btn ghost"
          aria-label="close problems panel"
          title="Hide problems"
          onClick={onClose}
          style={{ height: 22, padding: "0 6px" }}
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        {filtered.length === 0 ? (
          <div
            style={{
              padding: "16px 12px",
              textAlign: "center",
              color: "var(--ink3)",
              fontSize: 11,
            }}
          >
            no problems
          </div>
        ) : (
          filtered.map((p) => <ProblemRow key={p.id} problem={p} onJump={onJump} />)
        )}
      </div>
    </div>
  );
}

// ── Internals ────────────────────────────────────────────────────

function FilterChip({
  current,
  value,
  onSelect,
  children,
}: {
  current: Filter;
  value: Filter;
  onSelect: (v: Filter) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={"chip" + (current === value ? " on" : "")}
      style={{ cursor: "pointer", border: "1px solid var(--l2)" }}
    >
      {children}
    </button>
  );
}

function severityIcon(s: ProblemSeverity) {
  return s === "err" ? Ic.err : Ic.warn;
}

function severityColor(s: ProblemSeverity) {
  return s === "err" ? "var(--err)" : "var(--warn)";
}

function ProblemRow({
  problem,
  onJump,
}: {
  problem: CodeProblem;
  onJump: (line: number) => void;
}) {
  const canJump = problem.line != null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "4px 12px",
        borderBottom: "1px solid var(--l1)",
        fontSize: 11,
        color: "var(--ink2)",
        cursor: canJump ? "pointer" : "default",
      }}
      onClick={() => {
        if (canJump) onJump(problem.line!);
      }}
    >
      <span style={{ color: severityColor(problem.severity), display: "inline-flex" }}>
        {severityIcon(problem.severity)}
      </span>
      <span
        className="m"
        style={{ width: 40, color: "var(--ink3)", flex: "0 0 auto" }}
      >
        {problem.line != null ? `L${problem.line}` : "—"}
      </span>
      <span
        className="m"
        style={{ width: 60, color: "var(--ink3)", flex: "0 0 auto" }}
      >
        {problem.source}
      </span>
      {problem.target && (
        <span
          className="m"
          style={{ width: 130, color: "var(--ink)", flex: "0 0 auto" }}
        >
          {problem.target}
        </span>
      )}
      <span style={{ flex: 1, color: "var(--ink2)" }}>{problem.message}</span>
      {canJump && (
        <span
          className="m"
          style={{ fontSize: 10, color: "var(--ink3)" }}
        >
          jump
        </span>
      )}
    </div>
  );
}
