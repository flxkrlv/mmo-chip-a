import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

// ── Public handle ────────────────────────────────────────────────
//
// Tiny imperative surface so the page can scroll the viewer to a target line
// (outline clicks, problem-row jumps). The viewer is otherwise fully driven
// by props — selection / search highlight are controlled state.

export interface CodeViewerHandle {
  /** Scroll the given 1-based line into view AND mark it as selected. */
  goToLine: (line: number) => void;
}

// ── Tokens ───────────────────────────────────────────────────────
//
// One concise palette for syntax tokens, all sourced from CSS vars so the
// viewer stays in sync with the rest of the app's dark / light theming.
const SYNTAX_CSS = `
.cv {
  --cv-bg: var(--card);
  --cv-gutter: var(--panel);
  --cv-ink: var(--ink);
  --cv-ink2: var(--ink2);
  --cv-ink3: var(--ink3);
  --cv-sel: var(--accentBg);
  --cv-match: rgba(232, 185, 74, 0.32);
  --cv-match-cur: rgba(232, 185, 74, 0.58);
}
.dark .cv { --cv-match: rgba(232, 185, 74, 0.18); --cv-match-cur: rgba(232, 185, 74, 0.4); }
.cv .tok-c { color: var(--ink3); font-style: italic; }
.cv .tok-k { color: var(--accent); }
.cv .tok-t { color: #6b8e6b; }
.dark .cv .tok-t { color: #82d6a6; }
.cv .tok-n { color: var(--warn); }
.cv .tok-s { color: #8a6a2a; }
.dark .cv .tok-s { color: #e8b94a; }
.cv .ln-row { display: flex; min-width: max-content; height: 18px; line-height: 18px; }
.cv .ln-row.sel { background: var(--cv-sel); }
.cv .ln-gut {
  width: 44px;
  text-align: right;
  padding-right: 8px;
  color: var(--cv-ink3);
  font: 10.5px/18px var(--mono);
  user-select: none;
  border-right: 1px solid var(--l1);
  background: var(--cv-gutter);
  flex: 0 0 auto;
}
.cv .ln-gut.err { color: var(--err); }
.cv .ln-gut.warn { color: var(--warn); }
.cv .ln-txt {
  padding: 0 12px;
  white-space: pre;
  font: 11.5px/18px var(--mono);
  color: var(--cv-ink);
  flex: 1 1 auto;
}
.cv .hl { background: var(--cv-match); }
.cv .hl.cur { background: var(--cv-match-cur); }
`;

let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.setAttribute("data-cv", "1");
  style.textContent = SYNTAX_CSS;
  document.head.appendChild(style);
}

// ── Tokenizer ────────────────────────────────────────────────────
//
// Tiny Verilog tokenizer good enough for at-a-glance reading. Real syntax
// trees aren't required — comments, strings, numbers, and a keyword set
// cover ~95% of the lines this page emits.
const KEYWORDS = new Set([
  "module",
  "endmodule",
  "input",
  "output",
  "inout",
  "wire",
  "reg",
  "assign",
  "always",
  "begin",
  "end",
  "if",
  "else",
  "case",
  "endcase",
  "default",
  "parameter",
  "localparam",
  "posedge",
  "negedge",
  "or",
  "and",
  "not",
  "nand",
  "nor",
  "xor",
  "xnor",
  "buf",
  "function",
  "endfunction",
  "task",
  "endtask",
  "generate",
  "endgenerate",
]);

const TYPES = new Set(["bit", "byte", "integer", "real", "time", "logic"]);

interface Token {
  cls?: string; // CSS class suffix (k / t / n / s / c). Absent = no styling.
  text: string;
}

function tokenize(line: string): Token[] {
  // Comment wins outright — keep things simple by short-circuiting.
  const ci = line.indexOf("//");
  if (ci >= 0) {
    const before = line.slice(0, ci);
    return ci === 0
      ? [{ cls: "c", text: line }]
      : [...tokenize(before), { cls: "c", text: line.slice(ci) }];
  }

  const tokens: Token[] = [];
  // Whitespace, identifiers/numbers, operators/punct, strings. Numbers
  // include Verilog's `1'b0` / `8'hff` style for the value-literal coloring.
  const re = /(\s+|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*|\d+(?:'[bdhoBDHO][0-9a-fA-F_]+)?|[^\s\w])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const t = m[0];
    if (/^\s+$/.test(t)) {
      tokens.push({ text: t });
    } else if (t.startsWith('"')) {
      tokens.push({ cls: "s", text: t });
    } else if (/^[A-Za-z_]/.test(t)) {
      if (KEYWORDS.has(t)) tokens.push({ cls: "k", text: t });
      else if (TYPES.has(t)) tokens.push({ cls: "t", text: t });
      else tokens.push({ text: t });
    } else if (/^\d/.test(t)) {
      tokens.push({ cls: "n", text: t });
    } else {
      tokens.push({ text: t });
    }
  }
  return tokens;
}

// ── Search highlighting ──────────────────────────────────────────
//
// Highlights every occurrence of `query` (case-insensitive) on each line.
// We expand a token's text into multiple <span>s when the search term lands
// inside it, but ONLY break across token boundaries — the syntax color of a
// token is preserved on every fragment.
//
// `isCurrentMatch(line, matchIdxOnLine)` lets us paint the active hit a
// stronger shade than the others.

function withSearch(
  tokens: Token[],
  query: string,
  matchIndices: number[], // global indices of matches that start on this line
  currentMatch: number | null, // global index of the currently-focused match
): Array<Token & { hl?: "match" | "current" }> {
  if (!query) return tokens;
  const q = query.toLowerCase();
  const out: Array<Token & { hl?: "match" | "current" }> = [];
  // We walk the flat string to find match positions in line coords, then
  // map them back into token-internal offsets. Simpler than per-token state.
  const flat = tokens.map((t) => t.text).join("");
  const flatLower = flat.toLowerCase();
  // Build positions in line coords.
  const positions: number[] = [];
  let from = 0;
  while (true) {
    const at = flatLower.indexOf(q, from);
    if (at < 0) break;
    positions.push(at);
    from = at + q.length;
  }
  if (positions.length === 0) return tokens;

  // Walk tokens, splitting them at positions intersecting `q`. Tracks the
  // running global-match-index so we can flag the current one.
  let pos = 0;
  let pi = 0;
  let mi = 0; // index within this line's match starts
  for (const t of tokens) {
    const start = pos;
    const end = pos + t.text.length;
    // Slice this token by every match window that intersects [start, end).
    const cuts = new Set<number>();
    cuts.add(start);
    cuts.add(end);
    while (pi < positions.length && positions[pi] < end) {
      cuts.add(Math.max(positions[pi], start));
      cuts.add(Math.min(positions[pi] + q.length, end));
      if (positions[pi] + q.length <= end) pi++;
      else break;
    }
    const sorted = Array.from(cuts).sort((a, b) => a - b);
    for (let k = 0; k < sorted.length - 1; k++) {
      const a = sorted[k];
      const b = sorted[k + 1];
      if (a === b) continue;
      const text = flat.slice(a, b);
      // A slice is highlighted if its midpoint falls inside some match.
      const mid = (a + b) / 2;
      let highlighted: "match" | "current" | undefined;
      for (let p = 0; p < positions.length; p++) {
        if (positions[p] <= mid && mid < positions[p] + q.length) {
          // matchIndices[mi] is the global index of the *first* match starting
          // on this line — add the in-line offset to recover this slice's idx.
          const globalIdx = matchIndices[0] + p;
          highlighted = globalIdx === currentMatch ? "current" : "match";
          if (a === positions[p]) mi++;
          break;
        }
      }
      out.push({ cls: t.cls, text, hl: highlighted });
    }
    pos = end;
  }
  return out;
}

// ── Props ────────────────────────────────────────────────────────

export interface ProblemMarker {
  line: number;
  severity: "err" | "warn";
}

interface CodeViewerProps {
  source: string;
  /** 1-based line numbers with a problem marker in the gutter. */
  markers?: ProblemMarker[];
  /** Currently selected line (highlight + scroll target). */
  selectedLine?: number;
  onSelectLine?: (line: number) => void;
  /** Search needle. Empty / undefined clears highlighting. */
  search?: string;
  /** Match navigation. `matchIndex` is the global match position (0-based). */
  matchIndex?: number;
  onMatchTotal?: (total: number) => void;
  style?: CSSProperties;
}

// ── Component ────────────────────────────────────────────────────

export const CodeViewer = memo(
  forwardRef<CodeViewerHandle, CodeViewerProps>(function CodeViewer(
    {
      source,
      markers,
      selectedLine,
      onSelectLine,
      search,
      matchIndex,
      onMatchTotal,
      style,
    },
    ref,
  ) {
    useEffect(() => {
      ensureStyles();
    }, []);

    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const [internalSel, setInternalSel] = useState<number | null>(null);

    const effectiveSel = selectedLine ?? internalSel;

    useImperativeHandle(
      ref,
      () => ({
        goToLine: (line: number) => {
          setInternalSel(line);
          scrollLineIntoView(line);
        },
      }),
      [],
    );

    const scrollLineIntoView = (line: number) => {
      const el = scrollerRef.current;
      if (!el) return;
      const top = (line - 1) * 18;
      // Center the target line in the visible area when it's out of view.
      const view = el.clientHeight;
      if (top < el.scrollTop || top > el.scrollTop + view - 36) {
        el.scrollTo({ top: Math.max(0, top - view / 2 + 9), behavior: "smooth" });
      }
    };

    // Re-scroll if the parent updates `selectedLine` programmatically.
    useEffect(() => {
      if (selectedLine != null) scrollLineIntoView(selectedLine);
    }, [selectedLine]);

    const lines = useMemo(() => source.split("\n"), [source]);
    const markerByLine = useMemo(() => {
      const m = new Map<number, "err" | "warn">();
      for (const it of markers ?? []) {
        // Errors take precedence over warnings on the same line.
        const prev = m.get(it.line);
        if (prev === "err") continue;
        m.set(it.line, it.severity);
      }
      return m;
    }, [markers]);

    // Compute global match index list — needed both for the parent's count
    // callback and for painting the "current" hit a brighter shade.
    const matches = useMemo(() => {
      if (!search) return [];
      const q = search.toLowerCase();
      const positions: Array<{ line: number; col: number }> = [];
      for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        let from = 0;
        while (true) {
          const at = lower.indexOf(q, from);
          if (at < 0) break;
          positions.push({ line: i + 1, col: at });
          from = at + q.length;
        }
      }
      return positions;
    }, [lines, search]);

    useEffect(() => {
      onMatchTotal?.(matches.length);
    }, [matches.length, onMatchTotal]);

    // Scroll the current match into view as the user cycles through them.
    useEffect(() => {
      if (matchIndex == null || matches.length === 0) return;
      const m = matches[Math.min(matchIndex, matches.length - 1)];
      if (m) scrollLineIntoView(m.line);
    }, [matchIndex, matches]);

    // For O(1) per-line "what are my matches?" lookups during render.
    const matchesByLine = useMemo(() => {
      const map = new Map<number, number[]>();
      matches.forEach((m, i) => {
        let arr = map.get(m.line);
        if (!arr) {
          arr = [];
          map.set(m.line, arr);
        }
        arr.push(i);
      });
      return map;
    }, [matches]);

    return (
      <div
        ref={scrollerRef}
        className="cv"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflow: "auto",
          background: "var(--card)",
          ...style,
        }}
      >
        {lines.map((text, i) => {
          const lineNo = i + 1;
          const severity = markerByLine.get(lineNo);
          const sel = effectiveSel === lineNo;
          const indices = matchesByLine.get(lineNo);
          const tokens = tokenize(text || " ");
          const decorated = search && indices
            ? withSearch(tokens, search, indices, matchIndex ?? null)
            : tokens;
          return (
            <div
              key={lineNo}
              className={"ln-row" + (sel ? " sel" : "")}
              onClick={() => {
                if (onSelectLine) onSelectLine(lineNo);
                else setInternalSel(lineNo);
              }}
            >
              <div
                className={
                  "ln-gut" + (severity ? ` ${severity}` : "")
                }
                title={severity ? `${severity} on this line` : undefined}
              >
                {severity ? (severity === "err" ? "● " : "▲ ") : ""}
                {lineNo}
              </div>
              <div className="ln-txt">
                {decorated.map((t, j) => (
                  <span
                    key={j}
                    className={
                      (t.cls ? `tok-${t.cls}` : "") +
                      ((t as { hl?: string }).hl
                        ? ` hl${(t as { hl?: string }).hl === "current" ? " cur" : ""}`
                        : "")
                    }
                  >
                    {t.text}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }),
);
