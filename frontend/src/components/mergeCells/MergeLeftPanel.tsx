import { Fragment } from "react";
import type { Cell, DieAnnotations } from "shared";
import { TreeRow, TreeSep } from "../tree/TreeRow";
import { Ic } from "../../icons";
import { useMergeStore } from "../../state/mergeCells";
import {
  candidatesFor,
  cellCropUrl,
  cellTypeById,
  groupCellTypes,
  membersOf
} from "../../lib/mergeCells";

interface Props {
  dieId: string;
  annotations: DieAnnotations;
  onCandidateContextMenu: (cell: Cell, clientX: number, clientY: number) => void;
}

export function MergeLeftPanel({ dieId, annotations, onCandidateContextMenu }: Props) {
  const specimenTypeId = useMergeStore((s) => s.specimenTypeId);
  const specimenCellId = useMergeStore((s) => s.specimenCellId);
  const candidateCellId = useMergeStore((s) => s.candidateCellId);
  const expandedTypes = useMergeStore((s) => s.expandedTypes);
  const unmatchedOpen = useMergeStore((s) => s.unmatchedOpen);
  const mlOpen = useMergeStore((s) => s.mlOpen);
  const setSpecimen = useMergeStore((s) => s.setSpecimen);
  const setSpecimenCell = useMergeStore((s) => s.setSpecimenCell);
  const setCandidate = useMergeStore((s) => s.setCandidate);
  const toggleType = useMergeStore((s) => s.toggleType);
  const setUnmatchedOpen = useMergeStore((s) => s.setUnmatchedOpen);
  const setMlOpen = useMergeStore((s) => s.setMlOpen);

  const { matched, unmatched } = groupCellTypes(annotations);
  const specimenType = cellTypeById(annotations, specimenTypeId);
  const candidates = candidatesFor(annotations, specimenType);
  // Index of the first not-yet-matched candidate (done ones sort first); a
  // separator goes here when there are matched ones above it.
  const firstUndone = candidates.findIndex((c) => !c.done);

  return (
    <aside style={panelStyle}>
      {/* ── Cell Types ─────────────────────────────────────────── */}
      <div className="ph">
        <span className="u">Cell Types</span>
        <span className="m" style={{ fontSize: 10, color: "var(--ink3)", marginLeft: "auto" }}>
          {matched.length + unmatched.length}
        </span>
      </div>
      <div style={{ overflow: "auto", flex: "1 1 40%", minHeight: 60 }}>
        {matched.map((ct) => {
          const open = expandedTypes.includes(ct.id);
          const members = membersOf(annotations, ct.id);
          return (
            <div key={ct.id}>
              <TreeRow
                icon={Ic.cell}
                expand={members.length ? (open ? "open" : "closed") : "leaf"}
                label={ct.name}
                meta={members.length}
                monoLabel
                selected={specimenTypeId === ct.id}
                onToggleExpand={() => toggleType(ct.id)}
                onSelect={() => setSpecimen(ct.id, null)}
              />
              {open &&
                members.map((m) => (
                  <TreeRow
                    key={m.id}
                    depth={1}
                    icon={Ic.cell}
                    label={`cell ${m.id.slice(0, 6)}`}
                    monoLabel
                    selected={specimenTypeId === ct.id && specimenCellId === m.id}
                    onSelect={() => {
                      if (specimenTypeId !== ct.id) setSpecimen(ct.id, m.id);
                      else setSpecimenCell(m.id);
                    }}
                  />
                ))}
            </div>
          );
        })}

        <TreeSep />
        <TreeRow
          icon={Ic.cell}
          expand={unmatched.length ? (unmatchedOpen ? "open" : "closed") : "leaf"}
          label="Unmatched"
          meta={unmatched.length}
          dimmed
          onToggleExpand={() => setUnmatchedOpen(!unmatchedOpen)}
          onSelect={() => setUnmatchedOpen(!unmatchedOpen)}
        />
        {unmatchedOpen &&
          unmatched.map((ct) => (
            <TreeRow
              key={ct.id}
              depth={1}
              icon={Ic.cell}
              label={ct.name}
              meta={membersOf(annotations, ct.id).length}
              monoLabel
              dimmed
              selected={specimenTypeId === ct.id}
              onSelect={() => setSpecimen(ct.id, null)}
            />
          ))}

        <TreeRow
          icon={Ic.cell}
          expand={mlOpen ? "open" : "closed"}
          label="ML"
          meta={0}
          dimmed
          onToggleExpand={() => setMlOpen(!mlOpen)}
          onSelect={() => setMlOpen(!mlOpen)}
        />
        {mlOpen && (
          <div
            className="m"
            style={{ padding: "6px 16px", fontSize: 10, color: "var(--ink3)" }}
          >
            no ML-proposed cells yet
          </div>
        )}
      </div>

      <TreeSep />

      {/* ── Candidates ─────────────────────────────────────────── */}
      <div className="ph">
        <span className="u">Candidates</span>
        {specimenType && (
          <span
            className="m"
            style={{ fontSize: 10, color: "var(--ink3)", marginLeft: "auto" }}
          >
            → {specimenType.name}
          </span>
        )}
      </div>
      <div style={{ overflow: "auto", flex: "1 1 60%", minHeight: 80 }}>
        {candidates.length === 0 && (
          <div
            className="m"
            style={{ padding: "10px 16px", fontSize: 10, color: "var(--ink3)" }}
          >
            {specimenType ? "nothing left to match" : "pick a cell type above"}
          </div>
        )}
        {candidates.map(({ cell, cellType, done }, i) => {
          const sel = candidateCellId === cell.id;
          const showSep = i === firstUndone && firstUndone > 0;
          return (
            <Fragment key={cell.id}>
              {showSep && (
                <div
                  style={{
                    margin: "8px 8px 4px",
                    paddingTop: 8,
                    borderTop: "1px solid var(--l2)"
                  }}
                >
                  <span className="u" style={{ fontSize: 9, color: "var(--ink3)" }}>
                    to match
                  </span>
                </div>
              )}
              <div
                className={"trow" + (sel ? " sel" : "")}
              style={{
                padding: "5px 8px",
                alignItems: "center",
                cursor: "pointer",
                gap: 8
              }}
              onClick={() => setCandidate(cell.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCandidate(cell.id);
                onCandidateContextMenu(cell, e.clientX, e.clientY);
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 28,
                  flex: "0 0 auto",
                  borderRadius: 3,
                  overflow: "hidden",
                  position: "relative",
                  border: "1px solid var(--l2)",
                  background: "var(--canvas-bg)"
                }}
              >
                <img
                  src={cellCropUrl(dieId, cell)}
                  alt=""
                  loading="lazy"
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    display: "block"
                  }}
                />
                {done && (
                  <span
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "rgba(20,40,28,0.45)",
                      color: "var(--ok)"
                    }}
                  >
                    {CHECK}
                  </span>
                )}
              </div>
              <div className="col" style={{ minWidth: 0, gap: 1, flex: 1 }}>
                <span
                  className="m"
                  style={{ fontSize: 10.5, color: "var(--ink)", fontWeight: 500 }}
                >
                  cell {cell.id.slice(0, 6)}
                </span>
                <span style={{ fontSize: 9.5, color: "var(--ink3)" }}>
                  {Math.round(cellType.cropRect.width)}×
                  {Math.round(cellType.cropRect.height)} px
                </span>
              </div>
              {done && (
                <span className="chip ok" style={{ fontSize: 9 }}>
                  merged
                </span>
              )}
              </div>
            </Fragment>
          );
        })}
      </div>
    </aside>
  );
}

const CHECK = (
  <svg viewBox="0 0 16 16" className="ico" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const panelStyle: React.CSSProperties = {
  width: 248,
  flex: "0 0 auto",
  background: "var(--card)",
  borderRight: "1px solid var(--l2)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0
};
