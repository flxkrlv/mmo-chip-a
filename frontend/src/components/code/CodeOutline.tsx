import { useState } from "react";
import { TreeRow, TreeSep } from "../tree/TreeRow";
import type { OutlineGroup } from "../../api/codeGen";

interface Props {
  outline: OutlineGroup[];
  /** 1-based line currently selected in the viewer; used for leaf highlight. */
  selectedLine?: number;
  onGoToLine: (line: number) => void;
}

/**
 * Left-rail outline tree for the Code page. One group per
 * `OutlineGroupKind` — each group is expand/collapse with its leaves indented
 * one step. Clicking a leaf scrolls the viewer to that source line.
 *
 * The matching logic for "is this leaf selected?" rounds the viewer's selected
 * line down to the nearest leaf at or above it — instances span several lines
 * and the user pointing the gutter at line `N+2` should still highlight the
 * instance row whose head is line `N`.
 */
export function CodeOutline({ outline, selectedLine, onGoToLine }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (kind: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  // Selected leaf = deepest leaf across all groups whose `line <= selectedLine`.
  // Beats per-group nearest because two consecutive instances of different
  // kinds shouldn't fight over the highlight.
  let selectedLeafId: string | null = null;
  if (selectedLine != null) {
    let bestLine = -1;
    for (const g of outline) {
      for (const leaf of g.leaves) {
        if (leaf.line <= selectedLine && leaf.line > bestLine) {
          bestLine = leaf.line;
          selectedLeafId = leaf.id;
        }
      }
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--card)",
      }}
    >
      <div className="ph">
        <span
          className="m"
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--ink2)",
            letterSpacing: 0.6,
          }}
        >
          OUTLINE
        </span>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {outline.map((g, gi) => {
          const isCollapsed = collapsed.has(g.kind);
          return (
            <div key={g.kind}>
              {gi > 0 && <TreeSep />}
              <TreeRow
                expand={isCollapsed ? "closed" : "open"}
                label={g.title}
                meta={String(g.leaves.length)}
                onToggleExpand={() => toggle(g.kind)}
                onSelect={() => toggle(g.kind)}
              />
              {!isCollapsed &&
                (g.leaves.length === 0 ? (
                  <div
                    style={{
                      paddingLeft: 28,
                      fontSize: 11,
                      color: "var(--ink3)",
                      lineHeight: "20px",
                    }}
                  >
                    none
                  </div>
                ) : (
                  g.leaves.map((leaf) => (
                    <TreeRow
                      key={leaf.id}
                      depth={1}
                      label={leaf.label}
                      meta={leaf.meta}
                      monoLabel
                      selected={selectedLeafId === leaf.id}
                      onSelect={() => onGoToLine(leaf.line)}
                    />
                  ))
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
