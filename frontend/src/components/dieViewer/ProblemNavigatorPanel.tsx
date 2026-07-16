import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalogDevice, AnnotationNet, DieAnnotations, WireLayer, MetalStack } from "shared";
import { useSession } from "../../state/session";

// ── Problem types ──────────────────────────────────────────────────────

export interface ProblemUnconnPin {
  type: "unconn-pin";
  instanceName: string;
  terminalName: string;
  cellId: string;
  device: AnalogDevice;
}

export interface ProblemUnconnNet {
  type: "unconn-net";
  netId: number;
  netName: string;
  terminalCount: number;
}

export interface ProblemUnconnWire {
  type: "unconn-wire";
  x: number;
  y: number;
  net1Name: string;
  net2Name: string;
  distance: number;
}

export interface ProblemDanglingVia {
  type: "dangling-via";
  id: string;
  x: number;
  y: number;
  /** Layers that are missing around this via. */
  missing: string[];
}

export interface ProblemPinMismatch {
  type: "pin-mismatch";
  pinName: string;
  x: number;
  y: number;
  actual: string;
}

export interface ProblemOverlappingWire {
  type: "overlapping-wire";
  x: number;
  y: number;
  net1Name: string;
  net2Name: string;
  layer: string;
}

export type ProblemItem =
  | ProblemUnconnPin
  | ProblemUnconnNet
  | ProblemUnconnWire
  | ProblemDanglingVia
  | ProblemPinMismatch
  | ProblemOverlappingWire;

// ── Geometry helpers ───────────────────────────────────────────────────

function sqDist(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

function pointToSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return sqDist(px, py, ax, ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return sqDist(px, py, ax + t * dx, ay + t * dy);
}

function segIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): { x: number; y: number } | null {
  const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom;
  if (t >= -1e-10 && t <= 1 + 1e-10 && u >= -1e-10 && u <= 1 + 1e-10) {
    return { x: ax + t * (bx - ax), y: ay + t * (by - ay) };
  }
  return null;
}

function edgeNear(x: number, y: number, nets: AnnotationNet[], layer: WireLayer | undefined, tol: number) {
  const tolSq = tol * tol;
  for (const net of nets) {
    const nodeMap = new Map(net.nodes.map(n => [n.id, n]));
    for (const edge of net.edges) {
      if (edge.layer !== layer) continue;
      const fn = nodeMap.get(edge.from);
      const tn = nodeMap.get(edge.to);
      if (!fn || !tn) continue;
      if (pointToSegDist(x, y, fn.x, fn.y, tn.x, tn.y) <= tolSq) return true;
    }
  }
  return false;
}

// ── Problem computation ────────────────────────────────────────────────

export function collectProblems(
  annotations: DieAnnotations,
  devices: AnalogDevice[],
  netNames: Map<number, string>,
  metalStack?: MetalStack,
) {
  // ── unConnPins ──
  const connErrors: ProblemUnconnPin[] = [];
  for (const d of devices) {
    for (const t of d.terminals) {
      if (t.netId >= 2000) {
        connErrors.push({
          type: "unconn-pin",
          instanceName: d.instanceName ?? d.id,
          terminalName: t.name,
          cellId: (d as any)._cellId as string,
          device: d,
        });
      }
    }
  }

  // ── unConnNets ──
  const netTermCount = new Map<number, number>();
  for (const d of devices) {
    const seen = new Set<number>();
    for (const t of d.terminals) {
      if (t.netId >= 0 && !seen.has(t.netId)) {
        seen.add(t.netId);
        netTermCount.set(t.netId, (netTermCount.get(t.netId) ?? 0) + 1);
      }
    }
  }
  const unconnNets: ProblemUnconnNet[] = [];
  for (const [netId, count] of netTermCount) {
    if (count <= 1 && netId >= 100 && netId < 2000) {
      unconnNets.push({
        type: "unconn-net",
        netId,
        netName: netNames.get(netId) ?? `net${netId}`,
        terminalCount: count,
      });
    }
  }

  // ── unConnWires ──
  interface Ep { x: number; y: number; netId: string; netName: string }
  const endpoints: Ep[] = [];
  for (const net of annotations.nets) {
    const nodeMap = new Map(net.nodes.map(n => [n.id, n]));
    for (const edge of net.edges) {
      if (!edge.layer) continue;
      const fn = nodeMap.get(edge.from);
      const tn = nodeMap.get(edge.to);
      if (!fn || !tn) continue;
      endpoints.push({ x: fn.x, y: fn.y, netId: net.id, netName: net.name });
      endpoints.push({ x: tn.x, y: tn.y, netId: net.id, netName: net.name });
    }
  }

  const BUCKET = 20;
  const buckets = new Map<string, Ep[]>();
  for (const ep of endpoints) {
    const key = `${Math.round(ep.x / BUCKET)},${Math.round(ep.y / BUCKET)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(ep);
  }

  const unconnWires: ProblemUnconnWire[] = [];
  for (const [, items] of buckets) {
    if (items.length < 2) continue;
    const byNet = new Map<string, Ep[]>();
    for (const item of items) {
      if (!byNet.has(item.netId)) byNet.set(item.netId, []);
      byNet.get(item.netId)!.push(item);
    }
    if (byNet.size < 2) continue;
    const netIds = [...byNet.keys()];
    for (let i = 0; i < netIds.length; i++) {
      for (let j = i + 1; j < netIds.length; j++) {
        const a = byNet.get(netIds[i])!;
        const b = byNet.get(netIds[j])!;
        let best = Infinity, bx = 0, by = 0;
        for (const pa of a) for (const pb of b) {
          const d = sqDist(pa.x, pa.y, pb.x, pb.y);
          if (d < best) { best = d; bx = (pa.x + pb.x) / 2; by = (pa.y + pb.y) / 2; }
        }
        if (best <= BUCKET * BUCKET) {
          unconnWires.push({
            type: "unconn-wire",
            x: bx, y: by,
            net1Name: a[0].netName, net2Name: b[0].netName,
            distance: Math.round(Math.sqrt(best)),
          });
        }
      }
    }
  }

  // ── Dangling Vias ──
  const danglingVias: ProblemDanglingVia[] = [];
  const viasDef = metalStack?.vias;
  for (const ann of annotations.annotations ?? []) {
    if (ann.class !== "point_via" && ann.class !== "irregular_via") continue;
    const g = ann.geometry;
    let cx: number, cy: number;
    if (g.kind === "point") { cx = g.x; cy = g.y; }
    else if (g.kind === "rectangle") { cx = g.x + g.width / 2; cy = g.y + g.height / 2; }
    else if (g.kind === "polygon") {
      const pts = g.points;
      cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    } else continue;

    // Without metal stack, check legacy ME1/ME2
    if (!viasDef) {
      const me1 = edgeNear(cx, cy, annotations.nets, "metal1", 15);
      const me2 = edgeNear(cx, cy, annotations.nets, "metal2", 15);
      if (!me1 || !me2) {
        danglingVias.push({
          type: "dangling-via",
          id: ann.id,
          x: cx, y: cy,
          missing: [!me1 && "metal1", !me2 && "metal2"].filter(Boolean) as string[],
        });
      }
    } else {
      const missing: string[] = [];
      // Check only the via definition that matches this annotation's layer
      const viaDef = viasDef.find(v => v.id === ann.layer) ?? viasDef[0];
      const bottomMetal = metalStack!.metals.find(m => m.id === viaDef.from)?.layer;
      const topMetal = metalStack!.metals.find(m => m.id === viaDef.to)?.layer;
      if (bottomMetal && !edgeNear(cx, cy, annotations.nets, bottomMetal as WireLayer, 15)) missing.push(viaDef.from);
      if (topMetal && !edgeNear(cx, cy, annotations.nets, topMetal as WireLayer, 15)) missing.push(viaDef.to);
      if (missing.length > 0) {
        danglingVias.push({
          type: "dangling-via",
          id: ann.id,
          x: cx, y: cy,
          missing,
        });
      }
    }
  }

  // ── Pin mismatch ──
  const pinMismatches: ProblemPinMismatch[] = [];
  for (const pin of annotations.pins ?? []) {
    let bestNet = "", bestDist = Infinity;
    for (const net of annotations.nets) {
      for (const node of net.nodes) {
        const d = sqDist(node.x, node.y, pin.x, pin.y);
        if (d < bestDist && d <= 400) { bestDist = d; bestNet = net.name; }
      }
    }
    if (bestNet && bestNet !== pin.name) {
      pinMismatches.push({ type: "pin-mismatch", pinName: pin.name, x: pin.x, y: pin.y, actual: bestNet });
    }
  }

  // ── Overlapping same-metal wires ──
  interface EdgeSeg { netId: string; netName: string; ax: number; ay: number; bx: number; by: number; layer: string }
  const edgeLayers = new Map<string, EdgeSeg[]>();
  for (const net of annotations.nets) {
    const nodeMap = new Map(net.nodes.map(n => [n.id, n]));
    for (const edge of net.edges) {
      if (!edge.layer) continue;
      const fn = nodeMap.get(edge.from);
      const tn = nodeMap.get(edge.to);
      if (!fn || !tn) continue;
      if (!edgeLayers.has(edge.layer)) edgeLayers.set(edge.layer, []);
      edgeLayers.get(edge.layer)!.push({ netId: net.id, netName: net.name, ax: fn.x, ay: fn.y, bx: tn.x, by: tn.y, layer: edge.layer });
    }
  }
  const overlappingWires: ProblemOverlappingWire[] = [];
  const seen = new Set<string>();
  for (const [, segs] of edgeLayers) {
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i], b = segs[j];
        if (a.netId === b.netId) continue;
        const hit = segIntersect(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by);
        if (hit) {
          const key = `${a.netId}:${b.netId}:${a.layer}:${hit.x.toFixed(0)},${hit.y.toFixed(0)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          overlappingWires.push({
            type: "overlapping-wire",
            x: hit.x, y: hit.y,
            net1Name: a.netName, net2Name: b.netName,
            layer: a.layer,
          });
        }
      }
    }
  }

  return { connErrors, unconnNets, unconnWires, danglingVias, pinMismatches, overlappingWires };
}

// ── Section renderer (shared by all sections) ──────────────────────────

function Section({
  title,
  count,
  color,
  children,
  defaultOpen = false,
}: {
  title: string;
  count: number;
  color: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: "1px solid var(--l1)" }}>
      <div
        className="ph"
        style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
        onClick={() => setOpen(v => !v)}
      >
        <span style={{ fontSize: 10, color: "var(--ink3)", userSelect: "none" }}>
          {open ? "▼" : "▶"}
        </span>
        <span className="u" style={{ fontSize: 10, color }}>{title}</span>
        <span className="u" style={{ fontSize: 10, color: "var(--ink3)" }}>
          {count}
        </span>
      </div>
      {open && (
        <div style={{ padding: "0 4px 4px" }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── Panel component ────────────────────────────────────────────────────

interface Props {
  annotations: DieAnnotations | null | undefined;
  devices: AnalogDevice[];
  netNames: Map<number, string>;
  warnings: string[];
  netIdToUuid: Map<number, string>;
  onFocusCell: (cellId: string) => void;
  onFocusPoint: (x: number, y: number) => void;
  onFocusNet: (netUuid: string) => void;
}

interface FlatItem {
  group: string;
  label: string;
  detail: string;
  icon: string;
  onClick: () => void;
}

export function ProblemNavigatorPanel({
  annotations,
  devices,
  netNames,
  warnings,
  netIdToUuid,
  onFocusCell,
  onFocusPoint,
  onFocusNet,
}: Props) {
  const metalStack = useSession((s) => s.metalStack);
  const problems = useMemo(
    () => annotations ? collectProblems(annotations, devices, netNames, metalStack ?? undefined) : null,
    [annotations, devices, netNames, metalStack],
  );

  // Parse warnings and build a device lookup map
  const parsedWarnings = useMemo(() => {
    const re = /^\[(WARN|INFO)\]\s+(\S+)\s+(.*)$/;
    const out: { level: "WARN" | "INFO"; instanceName: string; message: string; device?: AnalogDevice }[] = [];
    const devMap = new Map<string, AnalogDevice>();
    for (const d of devices) {
      const name = d.instanceName ?? d.id;
      if (!devMap.has(name)) devMap.set(name, d);
    }
    for (const w of warnings) {
      const m = re.exec(w);
      if (!m) continue;
      out.push({
        level: m[1] as "WARN" | "INFO",
        instanceName: m[2],
        message: m[3],
        device: devMap.get(m[2]),
      });
    }
    return out;
  }, [warnings, devices]);

  const listRef = useRef<HTMLDivElement>(null);
  const [focusIdx, setFocusIdx] = useState(-1);

  // Build a flat list of all clickable items for keyboard nav
  const allItems = useMemo(() => {
    const items: FlatItem[] = [];
    if (problems) {
      for (const p of problems.connErrors) {
        items.push({
          group: "connectivity", label: `${p.instanceName} · ${p.terminalName}`,
          detail: "floating", icon: "⚡",
          onClick: () => { onFocusCell(p.cellId); },
        });
      }
      for (const p of problems.unconnNets) {
        items.push({
          group: "connectivity", label: p.netName,
          detail: `${p.terminalCount} terminal`, icon: "⚡",
          onClick: () => {
            const uuid = netIdToUuid.get(p.netId);
            if (uuid) onFocusNet(uuid);
          },
        });
      }
      for (const p of problems.unconnWires) {
        items.push({
          group: "wiring", label: `${p.net1Name} ↔ ${p.net2Name}`,
          detail: `${p.distance}px`, icon: "⑂",
          onClick: () => onFocusPoint(p.x, p.y),
        });
      }
      for (const p of problems.danglingVias) {
        const n = items.length;
        items.push({
          group: "vias",
          label: `Via #${n - problems.connErrors.length - problems.unconnWires.length + 1}`,
          detail: `no ${p.missing}`, icon: "◉",
          onClick: () => onFocusPoint(p.x, p.y),
        });
      }
      for (const p of problems.pinMismatches) {
        items.push({
          group: "pins", label: p.pinName,
          detail: `→ ${p.actual}`, icon: "⊘",
          onClick: () => onFocusPoint(p.x, p.y),
        });
      }
      for (const p of problems.overlappingWires) {
        items.push({
          group: "overlaps", label: `${p.net1Name} ✗ ${p.net2Name}`,
          detail: p.layer, icon: "⊗",
          onClick: () => onFocusPoint(p.x, p.y),
        });
      }
    }
    for (const pw of parsedWarnings) {
      items.push({
        group: "electrical", label: pw.instanceName,
        detail: pw.message, icon: pw.level === "WARN" ? "⚠" : "ℹ",
        onClick: () => {
          if (pw.device) {
            const cid = (pw.device as any)._cellId as string | undefined;
            if (cid) onFocusCell(cid);
          }
        },
      });
    }
    return items;
  }, [problems, parsedWarnings, netIdToUuid, onFocusCell, onFocusPoint, onFocusNet]);

  const execFocus = useCallback((idx: number) => {
    if (idx >= 0 && idx < allItems.length) {
      setFocusIdx(idx);
      allItems[idx].onClick();
      // Scroll into view
      const el = listRef.current?.children[idx] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [allItems]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (allItems.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        execFocus(focusIdx < allItems.length - 1 ? focusIdx + 1 : 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        execFocus(focusIdx > 0 ? focusIdx - 1 : allItems.length - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [allItems, focusIdx, execFocus]);

  const hasAny = problems || parsedWarnings.length > 0;
  if (!hasAny) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--ink3)", fontStyle: "italic" }}>
        Run analog extraction to see problems.
      </div>
    );
  }

  const total = problems
    ? problems.connErrors.length + problems.unconnNets.length
      + problems.unconnWires.length + problems.danglingVias.length
      + problems.pinMismatches.length + problems.overlappingWires.length + parsedWarnings.length
    : parsedWarnings.length;

  const connCount = problems ? problems.connErrors.length + problems.unconnNets.length : 0;
  const wireCount = problems ? problems.unconnWires.length : 0;
  const viaCount = problems ? problems.danglingVias.length : 0;
  const pinCount = problems ? problems.pinMismatches.length : 0;
  const overlapCount = problems ? problems.overlappingWires.length : 0;
  const electCount = parsedWarnings.length;

  // Map flat index → global index within each group for row-level highlighting
  let flatIdx = 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", maxHeight: 400 }}>
      <div
        className="ph"
        style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          borderBottom: "1px solid var(--l2)",
          color: total > 0 ? "var(--err)" : "var(--ink3)",
          flexShrink: 0,
        }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          PROBLEMS · {total}
          {allItems.length > 0 && <span style={{ color: "var(--ink3)", marginLeft: 6, fontSize: 9 }}>↑↓</span>}
        </span>
      </div>

      <div ref={listRef} style={{ overflow: "auto", flex: 1 }}>
        {connCount > 0 && problems && (
          <Section title="CONNECTIVITY" count={connCount} color="var(--err)">
            {problems.connErrors.map((p, i) => {
              const idx = flatIdx++;
              return (
                <Row key={`pin-${i}`}
                  icon="⚡"
                  label={`${p.instanceName} · ${p.terminalName}`}
                  detail="floating"
                  focused={focusIdx === idx}
                  onClick={() => execFocus(idx)}
                />
              );
            })}
            {problems.unconnNets.map((p, i) => {
              const idx = flatIdx++;
              return (
                <Row key={`net-${i}`}
                  icon="⚡"
                  label={p.netName}
                  detail={`${p.terminalCount} terminal`}
                  focused={focusIdx === idx}
                  onClick={() => execFocus(idx)}
                />
              );
            })}
          </Section>
        )}

        {wireCount > 0 && problems && (
          <Section title="WIRING" count={wireCount} color="var(--err)">
            {problems.unconnWires.map((p, i) => {
              const idx = flatIdx++;
              return (
                <Row key={`wire-${i}`}
                  icon="⑂"
                  label={`${p.net1Name} ↔ ${p.net2Name}`}
                  detail={`${p.distance}px`}
                  focused={focusIdx === idx}
                  onClick={() => execFocus(idx)}
                />
              );
            })}
          </Section>
        )}

        {viaCount > 0 && problems && (
          <Section title="VIAS" count={viaCount} color="var(--err)">
            {problems.danglingVias.map((p, i) => {
              const idx = flatIdx++;
              return (
                <Row key={`via-${i}`}
                  icon="◉"
                  label={`Via #${i + 1}`}
                  detail={`no ${p.missing}`}
                  focused={focusIdx === idx}
                  onClick={() => execFocus(idx)}
                />
              );
            })}
          </Section>
        )}

        {pinCount > 0 && problems && (
          <Section title="I/O PINS" count={pinCount} color="var(--err)">
            {problems.pinMismatches.map((p, i) => {
              const idx = flatIdx++;
              return (
                <Row key={`mismatch-${i}`}
                  icon="⊘"
                  label={p.pinName}
                  detail={`→ ${p.actual}`}
                  focused={focusIdx === idx}
                  onClick={() => execFocus(idx)}
                />
              );
            })}
          </Section>
        )}

        {overlapCount > 0 && problems && (
          <Section title="OVERLAPS" count={overlapCount} color="var(--err)">
            {problems.overlappingWires.map((p, i) => {
              const idx = flatIdx++;
              return (
                <Row key={`overlap-${i}`}
                  icon="⊗"
                  label={`${p.net1Name} ✗ ${p.net2Name}`}
                  detail={p.layer}
                  focused={focusIdx === idx}
                  onClick={() => execFocus(idx)}
                />
              );
            })}
          </Section>
        )}

        {electCount > 0 && (
          <Section title="ELECTRICAL" count={electCount} color="var(--err)">
            {parsedWarnings.map((pw, i) => {
              const idx = flatIdx++;
              return (
                <Row key={`elect-${i}`}
                  icon={pw.level === "WARN" ? "⚠" : "ℹ"}
                  label={pw.instanceName}
                  detail={pw.message}
                  focused={focusIdx === idx}
                  onClick={() => execFocus(idx)}
                />
              );
            })}
          </Section>
        )}

        {total === 0 && (
          <div style={{ padding: "12px", color: "var(--ink3)", fontSize: 11, textAlign: "center" }}>
            ✓ no problems found
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  icon, label, detail, onClick, focused,
}: {
  icon: string;
  label: string;
  detail: string;
  onClick?: () => void;
  focused?: boolean;
}) {
  return (
    <div
      className="trow"
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "2px 4px", borderRadius: 3,
        cursor: onClick ? "pointer" : "default",
        background: focused ? "var(--l2)" : undefined,
      }}
      onClick={onClick}
    >
      <span style={{ flexShrink: 0, fontSize: 10, width: 14, textAlign: "center" }}>{icon}</span>
      <span style={{ flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <span className="m" style={{ fontSize: 9, color: "var(--ink3)", flexShrink: 0 }}>{detail}</span>
    </div>
  );
}
