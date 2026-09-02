/**
 * InteractiveAnalogSchematic.tsx — draggable analog schematic canvas.
 *
 * Renders the same skin symbols as the static netlist2svg view (bodies
 * shared through <defs>/<use>, per-device labels rendered alongside),
 * laid out by `runInteractiveLayout` (ELK with ports — quality parity
 * with the static path). Devices are draggable: during a drag only the
 * touched nets are re-routed locally (`routeNetLocal`), ELK never runs
 * per-frame. Positions and locks persist per scope slot through
 * `useInteractiveSchematic` (survive F5 and navigation).
 *
 * Pan/zoom mirrors LogicSchematicCanvas (ctrl+wheel zoom, background
 * drag pan, ResizeObserver auto-fit).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  memo,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { AnalogDevice } from "shared";
import {
  parseSymbolSkin,
  templateForDevice,
  labelForSpec,
  INTERACTIVE_SCHEMATIC_CSS,
  type SymbolTemplate,
} from "../../lib/schematic/interactiveSymbols";
import {
  runInteractiveLayout,
  buildNetIndex,
  powerDevices,
  ioNetList,
  terminalPinLookup,
  deviceKey,
  routeNetLocal,
  type InteractiveLayoutResult,
  type Point,
  type WireData,
} from "../../lib/schematic/interactiveAnalogLayout";
import {
  useInteractiveSchematic,
  // imperative helper (getState) — safe to call in callbacks, NOT a selector
  effectivePositions,
} from "../../state/interactiveSchematic";
import type {
  LayoutStrategy,
  LayoutDirection,
  CompactionLevel,
} from "../../lib/schematic/netlist2svgSkin";

// ── Props ────────────────────────────────────────────────────────

interface Props {
  devices: AnalogDevice[];
  namedNets: Map<number, string>;
  ioNetIds?: Set<number>;
  /** Scope slot key for position persistence (see scopeKey()). */
  scopeKey: string;
  vdd?: string;
  gnd?: string;
  /** ELK placement strategy — same selector as the static view. */
  layoutStrategy?: LayoutStrategy;
  /** Layout flow direction — same selector as the static view. */
  layoutDirection?: LayoutDirection;
  /** Post-compaction level 0-4 — same selector as the static view. */
  compactionLevel?: CompactionLevel;
}

// ── Constants ────────────────────────────────────────────────────

const MIN_SCALE = 0.08;
const MAX_SCALE = 8;
const WHEEL_FACTOR = 0.01;
const WIRE_STROKE = 1.3;
const WIRE_HIT_WIDTH = 10;
const HL_COLOR = "#7fb2ff";
const LOCK_COLOR = "#e8b931";

interface View { tx: number; ty: number; scale: number }

/** Identity-stable empty containers — never create fresh empties inside
 *  a render/selector, that's the infinite-loop footgun (see store note). */
const EMPTY_POSITIONS: Record<string, Point> = {};
const EMPTY_LOCKED: Record<string, boolean> = {};

interface RenderNode {
  key: string;
  kind: "device" | "power" | "io";
  template?: SymbolTemplate;
  size: { w: number; h: number };
  device?: AnalogDevice;
  /** io net label */
  label?: string;
  /** For power nodes: which rail symbol to draw/color. */
  powerKind?: "vcc" | "gnd";
}

// ── Component ────────────────────────────────────────────────────

export function InteractiveAnalogSchematic({
  devices, namedNets, ioNetIds, scopeKey, vdd, gnd,
  layoutStrategy = "BRANDES_KOEPF", layoutDirection = "DOWN", compactionLevel = 2,
}: Props) {
  const opts = useMemo(
    () => ({
      vdd, gnd, ioNetIds,
      showIo: ioNetIds != null && ioNetIds.size > 0,
      strategy: layoutStrategy,
      direction: layoutDirection,
      compaction: compactionLevel,
    }),
    [vdd, gnd, ioNetIds, layoutStrategy, layoutDirection, compactionLevel],
  );
  const table = useMemo(() => parseSymbolSkin(), []);

  // ── Store slices ─────────────────────────────────────────────
  // IMPORTANT: selectors must return identity-stable references
  // (zustand v5 / useSyncExternalStore re-runs them after every commit
  // and treats a changed snapshot as a re-render trigger). Deriving
  // fresh objects (spread / emptyLayout fallback) inside the selector
  // causes an infinite "Maximum update depth exceeded" loop — so we
  // subscribe to raw state slices and derive via useMemo below.
  const layouts = useInteractiveSchematic((s) => s.layouts);
  const draft = useInteractiveSchematic((s) => s.draft);
  const store = useInteractiveSchematic;
  const scopeLayout = layouts[scopeKey];
  /** Effective render positions: draft overrides during a drag. */
  const storedPositions = useMemo(() => {
    const base = scopeLayout?.positions ?? EMPTY_POSITIONS;
    if (draft && draft.scopeKey === scopeKey) {
      return { ...base, ...draft.positions };
    }
    return base;
  }, [scopeLayout, draft, scopeKey]);
  /** Locked flags (stable reference; EMPTY_LOCKED when scope absent). */
  const locked = scopeLayout?.locked ?? EMPTY_LOCKED;

  // ── Layout load ──────────────────────────────────────────────
  const [elkResult, setElkResult] = useState<InteractiveLayoutResult | null>(null);
  const [laying, setLaying] = useState(true);
  const layoutSeq = useRef(0);

  // Wires: ELK routes patched by local re-routes (drag / position overrides).
  const [wires, setWires] = useState<Map<number, WireData>>(new Map());

  // Powers + io + pin lookups (stable per dataset)
  const powers = useMemo(() => powerDevices(devices, namedNets, opts), [devices, namedNets, opts]);
  const ioNets = useMemo(() => ioNetList(devices, namedNets, opts), [devices, namedNets, opts]);
  const pinLookup = useMemo(
    () => terminalPinLookup(devices, powers, table, opts),
    [devices, powers, table, opts],
  );
  // io pseudo nodes need anchors too — otherwise a drag-time local
  // re-route of an io net drops the io pin's wire end.
  const ioPinLookup = useMemo(() => {
    const map = new Map(pinLookup);
    for (const io of ioNets) {
      map.set(`io:${io.netId}`, (t: string) => (t === "Y" ? { dx: 30, dy: 10 } : undefined));
    }
    return map;
  }, [pinLookup, ioNets]);
  const netIndex = useMemo(
    () => buildNetIndex(devices, opts, powers),
    [devices, opts, powers],
  );

  /** Final render positions: stored/persisted positions win over ELK's. */
  const positions: Record<string, Point> = useMemo(() => {
    if (!elkResult) return {};
    return { ...elkResult.positions, ...storedPositions };
  }, [elkResult, storedPositions]);

  /** Nets touched by the given node keys. */
  const netsTouched = useCallback(
    (keys: Iterable<string>): number[] => {
      const set = new Set(keys);
      const out: number[] = [];
      for (const [netId, members] of netIndex) {
        if (members.some((m) => set.has(m.deviceKey))) out.push(netId);
      }
      return out;
    },
    [netIndex],
  );

  /** Re-route specific nets against current positions. */
  const rerouteNets = useCallback(
    (base: Map<number, WireData>, netIds: number[], pos: Record<string, Point>, excludeKey?: string): Map<number, WireData> => {
      const next = new Map(base);
      const obstacles = Object.entries(pos)
        .filter(([key]) => key !== excludeKey)
        .map(([key, p]) => {
          const size = elkResult?.sizes[key] ?? { w: 30, h: 40 };
          return { x: p.x, y: p.y, w: size.w, h: size.h };
        });
      for (const netId of netIds) {
        const members = netIndex.get(netId);
        if (!members) continue;
        const anchors = members
          .map((m) => {
            const pin = ioPinLookup.get(m.deviceKey);
            const p = pos[m.deviceKey];
            const off = pin?.(m.terminal);
            return p && off ? { x: p.x + off.dx, y: p.y + off.dy } : undefined;
          })
          .filter((p): p is Point => !!p);
        next.set(netId, routeNetLocal(anchors, obstacles));
      }
      return next;
    },
    [elkResult, netIndex, pinLookup],
  );

  /** Merge an ELK result: stored positions win (unless ignoreStored),
   *  locked always keep their stored position; wires patched for moves. */
  const absorbResult = useCallback(
    (res: InteractiveLayoutResult, ignoreStored: boolean) => {
      const st = store.getState();
      const scope = st.layouts[scopeKey];
      const stored = scope?.positions ?? {};
      const isLocked = scope?.locked ?? {};

      const final: Record<string, Point> = {};
      const changedKeys: string[] = [];
      const toApply: Record<string, Point> = {};
      for (const [key, p] of Object.entries(res.positions)) {
        const useStored = !ignoreStored && stored[key] != null;
        final[key] = useStored ? stored[key] : p;
        if (!useStored) toApply[key] = p;
        if (Math.abs(final[key].x - p.x) > 0.5 || Math.abs(final[key].y - p.y) > 0.5) {
          // ELK routed this net assuming its own position — re-route locally.
          changedKeys.push(key);
        }
      }
      // Persist: locked devices are skipped inside the store action.
      st.applyPositions(scopeKey, toApply);

      // Patch wires for every net touching a device whose effective
      // position differs from the ELK routing assumption, plus every
      // net of a locked device (locked nodes were excluded from ELK's
      // graph entirely).
      const dirty = new Set<number>();
      for (const key of changedKeys) {
        for (const netId of netsTouched([key])) dirty.add(netId);
      }
      for (const key of Object.keys(isLocked)) {
        if (isLocked[key] && res.positions[key] == null) {
          for (const netId of netsTouched([key])) dirty.add(netId);
        }
      }
      let nextWires = res.wires;
      if (dirty.size > 0) {
        nextWires = rerouteNets(res.wires, [...dirty], final);
      }
      setElkResult(res);
      setWires(nextWires);
      setLaying(false);
    },
    [scopeKey, store, netsTouched, rerouteNets],
  );

  /** Run ELK (async, cancellation-guarded). Locked devices are excluded
   *  from ELK's graph — elkjs cannot pin individual nodes (verified
   *  empirically against elkjs 0.11.1). */
  const runLayout = useCallback(
    (ignoreStored: boolean) => {
      const seq = ++layoutSeq.current;
      setLaying(true);
      const lockMapNow = store.getState().layouts[scopeKey]?.locked ?? {};
      const exclude = new Set(Object.keys(lockMapNow).filter((k) => lockMapNow[k]));
      runInteractiveLayout(devices, namedNets, table, { ...opts, excludeKeys: exclude })
        .then((res) => {
          if (seq !== layoutSeq.current) return; // stale result — drop
          absorbResult(res, ignoreStored);
        })
        .catch((err) => {
          if (seq !== layoutSeq.current) return;
          console.error("[InteractiveAnalogSchematic] layout failed:", err);
          setLaying(false);
        });
    },
    [devices, namedNets, table, opts, scopeKey, store, absorbResult],
  );

  // Initial load + dataset/settings changes. A dataset change fills in
  // missing positions (restores the persisted arrangement); a layout
  // settings change (strategy/direction/compaction) re-arranges
  // everything except locked devices.
  const dataSig = useMemo(
    () => `${devices.length}|${namedNets.size}|${[...devices].map((d) => deviceKey(d)).join(",")}`,
    [devices, namedNets],
  );
  const settingsSig = `${layoutStrategy}|${layoutDirection}|${compactionLevel}`;
  const prevSigRef = useRef<{ data: string; settings: string } | null>(null);
  useEffect(() => {
    // Drop persisted entries for devices that no longer exist.
    store.getState().pruneScope(scopeKey, [...devices].map((d) => deviceKey(d)));
    const prev = prevSigRef.current;
    const settingsChanged = prev != null && prev.settings !== settingsSig;
    prevSigRef.current = { data: dataSig, settings: settingsSig };
    runLayout(settingsChanged);
    return () => {
      layoutSeq.current++; // cancel in-flight layout on dataset switch
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSig, settingsSig, scopeKey]);

  // ── Viewport (pan/zoom — LogicSchematicCanvas pattern) ───────
  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ tx: 0, ty: 0, scale: 1 });
  const panRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lastFitKey = useRef<string | null>(null);
  useEffect(() => {
    if (!elkResult || size.w === 0 || size.h === 0) return;
    const { bbox } = elkResult;
    if (bbox.width === 0 || bbox.height === 0) return;
    const key = `${bbox.width}x${bbox.height}|${size.w}x${size.h}`;
    if (lastFitKey.current === key) return;
    lastFitKey.current = key;
    const margin = 24;
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(
      (size.w - margin * 2) / bbox.width,
      (size.h - margin * 2) / bbox.height,
    )));
    setView({ tx: size.w / 2 - (bbox.width / 2) * scale, ty: size.h / 2 - (bbox.height / 2) * scale, scale });
  }, [elkResult, size.w, size.h]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !elkResult) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * Math.exp(-e.deltaY * WHEEL_FACTOR)));
          if (next === v.scale) return v;
          const worldX = (cx - v.tx) / v.scale;
          const worldY = (cy - v.ty) / v.scale;
          return { scale: next, tx: cx - worldX * next, ty: cy - worldY * next };
        }
        return { ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY };
      });
    };
    const prevent = (e: Event) => e.preventDefault();
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("gesturestart", prevent, { passive: false });
    svg.addEventListener("gesturechange", prevent, { passive: false });
    svg.addEventListener("gestureend", prevent, { passive: false });
    return () => {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("gesturestart", prevent);
      svg.removeEventListener("gesturechange", prevent);
      svg.removeEventListener("gestureend", prevent);
    };
  }, [elkResult]);

  // ── Device drag ──────────────────────────────────────────────
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hoverNet, setHoverNet] = useState<number | null>(null);
  const [hoverDevice, setHoverDevice] = useState<string | null>(null);
  const dragRef = useRef<{
    deviceKey: string;
    sx: number; sy: number;
    grabDX: number; grabDY: number;
    moved: boolean;
    netIds: number[];
    raf: number;
    pending: { x: number; y: number } | null;
  } | null>(null);

  const onDevicePointerDown = useCallback(
    (e: ReactPointerEvent<SVGGElement>, node: RenderNode) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const lockedNow = locked[node.key];
      if (lockedNow) {
        setSelectedKey(node.key);
        return; // locked devices don't move
      }
      svgRef.current?.setPointerCapture(e.pointerId);
      const p = worldFromEvent(e, view, svgRef.current);
      dragRef.current = {
        deviceKey: node.key,
        sx: e.clientX,
        sy: e.clientY,
        grabDX: p.x - (positions[node.key]?.x ?? 0),
        grabDY: p.y - (positions[node.key]?.y ?? 0),
        moved: false,
        netIds: netsTouched([node.key]),
        raf: 0,
        pending: null,
      };
      store.getState().dragBegin(scopeKey);
    },
    [locked, positions, view, netsTouched, scopeKey, store],
  );

  const applyDragPosition = useCallback(
    (key: string, pos: Point) => {
      store.getState().dragMove(key, pos);
      const current = useInteractiveSchematic.getState();
      const posNow = effectivePositions(current, scopeKey);
      setWires((prev) => rerouteNets(prev, dragRef.current?.netIds ?? [], posNow, key));
    },
    [store, scopeKey, rerouteNets],
  );

  const onSvgPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      // Pan
      const pan = panRef.current;
      if (pan) {
        setView((v) => ({ ...v, tx: pan.tx + (e.clientX - pan.sx), ty: pan.ty + (e.clientY - pan.sy) }));
        return;
      }
      // Device drag (rAF-coalesced)
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      const p = worldFromEvent(e, view, svgRef.current);
      d.pending = { x: p.x - d.grabDX, y: p.y - d.grabDY };
      if (d.raf) return;
      d.raf = requestAnimationFrame(() => {
        const dd = dragRef.current;
        if (!dd || !dd.pending) return;
        dd.raf = 0;
        applyDragPosition(dd.deviceKey, dd.pending);
        dd.pending = null;
      });
    },
    [view, applyDragPosition],
  );

  const endPointer = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const pan = panRef.current;
      if (pan) {
        panRef.current = null;
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      if (d.raf) cancelAnimationFrame(d.raf);
      dragRef.current = null;
      svgRef.current?.releasePointerCapture(e.pointerId);
      store.getState().dragEnd();
      if (!d.moved) setSelectedKey((cur) => (cur === d.deviceKey ? null : d.deviceKey));
    },
    [store],
  );

  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (e.button !== 0 && e.button !== 1) return;
      svgRef.current?.setPointerCapture(e.pointerId);
      panRef.current = { sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
      setSelectedKey(null);
    },
    [view.tx, view.ty],
  );

  // ── Toolbar actions ──────────────────────────────────────────
  const onRelayout = useCallback(() => runLayout(false), [runLayout]);
  const onAutoArrange = useCallback(() => runLayout(true), [runLayout]);
  const onToggleLock = useCallback(() => {
    if (!selectedKey) return;
    store.getState().setLocked(scopeKey, selectedKey, !locked[selectedKey]);
  }, [selectedKey, locked, scopeKey, store]);
  const onReset = useCallback(() => {
    store.getState().resetScope(scopeKey);
    runLayout(true);
  }, [store, scopeKey, runLayout]);

  // ── Render nodes ─────────────────────────────────────────────
  const nodes: RenderNode[] = useMemo(() => {
    if (!elkResult) return [];
    const out: RenderNode[] = [];
    for (const d of devices) {
      const key = deviceKey(d);
      if (elkResult.positions[key] == null) continue;
      out.push({
        key,
        kind: "device",
        template: templateForDevice(table, d),
        size: elkResult.sizes[key] ?? { w: 30, h: 40 },
        device: d,
      });
    }
    for (const p of powers) {
      const key = deviceKey(p);
      if (elkResult.positions[key] == null) continue;
      const powerKind: "vcc" | "gnd" = key === (opts.gnd ?? "GND") ? "gnd" : "vcc";
      out.push({
        key,
        kind: "power",
        template: table.byKey.get(powerKind),
        size: elkResult.sizes[key] ?? { w: 20, h: 30 },
        device: p,
        powerKind,
      });
    }
    for (const io of ioNets) {
      const key = `io:${io.netId}`;
      if (elkResult.positions[key] == null) continue;
      out.push({ key, kind: "io", size: elkResult.sizes[key] ?? { w: 30, h: 20 }, label: io.name });
    }
    return out;
  }, [elkResult, devices, powers, ioNets, table, opts.gnd]);

  if (devices.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--ink3)", fontStyle: "italic", fontSize: 12 }}>
        No analog devices found
      </div>
    );
  }

  return (
    <div ref={hostRef} style={{ position: "relative", width: "100%", height: "100%", background: "var(--canvas-bg)", overflow: "hidden", overscrollBehavior: "none" }}>
      {laying && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink3)", fontSize: 12, zIndex: 2, pointerEvents: "none" }}>
          laying out…
        </div>
      )}
      {/* Toolbar */}
      <div style={{ position: "absolute", top: 6, left: 6, zIndex: 1, display: "flex", gap: 4, alignItems: "center" }}>
        <button type="button" className="btn sm" onClick={onRelayout} title="ELK re-layout — fills positions for unplaced devices; your arrangement is kept">
          Re-layout
        </button>
        <button type="button" className="btn sm" onClick={onAutoArrange} title="ELK re-layout of ALL unlocked devices (locks are kept)">
          Auto-arrange
        </button>
        <button
          type="button"
          className={"btn sm" + (selectedKey && locked[selectedKey] ? " on" : "")}
          onClick={onToggleLock}
          disabled={!selectedKey}
          title={selectedKey ? "Lock/unlock the selected device (locked devices survive re-layout)" : "Click a device to select it first"}
          style={{ opacity: selectedKey ? 1 : 0.4 }}
        >
          {selectedKey && locked[selectedKey] ? "Unlock" : "Lock"}
        </button>
        <button type="button" className="btn sm" onClick={onReset} title="Reset all positions and locks, run a fresh ELK layout">
          Reset
        </button>
        {elkResult?.usedFallback && (
          <span style={{ fontSize: 10, color: "var(--warn)", marginLeft: 4 }}>grid fallback</span>
        )}
        {!elkResult?.usedFallback && elkResult?.applied && (
          elkResult.applied.strategy !== layoutStrategy || elkResult.applied.compaction !== compactionLevel
            ? (
              <span
                style={{ fontSize: 10, color: "var(--warn)", marginLeft: 4 }}
                title="ELK failed with the requested settings — layout was auto-degraded until it succeeded"
              >
                degraded: {elkResult.applied.strategy} / c{elkResult.applied.compaction}
              </span>
            )
            : (
              <span style={{ fontSize: 10, color: "var(--ink3)", marginLeft: 4 }}>
                {elkResult.applied.strategy} · {elkResult.applied.direction} · c{elkResult.applied.compaction}
              </span>
            )
        )}
      </div>

      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        style={{ display: "block", touchAction: "none", cursor: panRef.current ? "grabbing" : hoverDevice ? "move" : "default" }}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onSvgPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        <style>{INTERACTIVE_SCHEMATIC_CSS}</style>
        {/* Shared symbol bodies — identical art to the static netlist2svg view */}
        <defs>
          {table.templates.map((t) => (
            <g key={t.type} id={`isch-${t.type}`} dangerouslySetInnerHTML={{ __html: t.body }} />
          ))}
        </defs>
        <g transform={`translate(${view.tx}, ${view.ty}) scale(${view.scale})`}>
          {/* Wires */}
          {[...wires.entries()].map(([netId, wire]) => (
            <NetWire
              key={netId}
              netId={netId}
              wire={wire}
              hovered={hoverNet === netId}
              onHover={setHoverNet}
            />
          ))}
          {/* Devices */}
          {nodes.map((n) => (
            <DeviceNode
              key={n.key}
              node={n}
              pos={positions[n.key] ?? { x: 0, y: 0 }}
              selected={selectedKey === n.key}
              isLocked={!!locked[n.key]}
              hovered={hoverDevice === n.key}
              onPointerDown={onDevicePointerDown}
              onHover={setHoverDevice}
            />
          ))}
        </g>
      </svg>

      {/* Status line */}
      <div style={{ position: "absolute", bottom: 6, left: 6, zIndex: 1, fontSize: 10, color: "var(--ink3)", pointerEvents: "none" }}>
        {hoverNet != null && namedNets.get(hoverNet)
          ? `net: ${namedNets.get(hoverNet)}`
          : `${devices.length} devices · drag to move · ctrl+wheel to zoom`}
      </div>
    </div>
  );
}

// ── Memoized children ────────────────────────────────────────────

function worldFromEvent(
  e: { clientX: number; clientY: number },
  view: View,
  svg: SVGSVGElement | null,
): Point {
  const rect = svg?.getBoundingClientRect();
  const left = rect?.left ?? 0;
  const top = rect?.top ?? 0;
  return {
    x: (e.clientX - left - view.tx) / view.scale,
    y: (e.clientY - top - view.ty) / view.scale,
  };
}

const NetWire = memo(function NetWire({
  netId,
  wire,
  hovered,
  onHover,
}: {
  netId: number;
  wire: WireData;
  hovered: boolean;
  onHover: (netId: number | null) => void;
}) {
  return (
    <g
      onMouseEnter={() => onHover(netId)}
      onMouseLeave={() => onHover(null)}
    >
      {wire.polylines.map((line, li) => {
        const pts = line.map((p) => `${p.x},${p.y}`).join(" ");
        return (
          <g key={li}>
            <polyline points={pts} fill="none" stroke="transparent" strokeWidth={WIRE_HIT_WIDTH} pointerEvents="stroke" />
            <polyline
              points={pts}
              fill="none"
              stroke={hovered ? HL_COLOR : "var(--ink2)"}
              strokeWidth={hovered ? WIRE_STROKE + 1 : WIRE_STROKE}
              strokeLinejoin="round"
              strokeLinecap="round"
              pointerEvents="none"
            />
          </g>
        );
      })}
      {wire.junctions.map((j, ji) => (
        <circle key={ji} cx={j.x} cy={j.y} r={2.4} fill={hovered ? HL_COLOR : "var(--ink2)"} pointerEvents="none" />
      ))}
    </g>
  );
});

const DeviceNode = memo(function DeviceNode({
  node,
  pos,
  selected,
  isLocked,
  onPointerDown,
  onHover,
}: {
  node: RenderNode;
  pos: Point;
  selected: boolean;
  isLocked: boolean;
  /** Kept in props so hover changes re-render memoized nodes (cursor). */
  hovered: boolean;
  onPointerDown: (e: ReactPointerEvent<SVGGElement>, node: RenderNode) => void;
  onHover: (key: string | null) => void;
}) {
  const { key, template, size, kind, device, label, powerKind } = node;
  const cls = [
    "isch",
    kind === "power" ? (powerKind === "gnd" ? "isch-gnd" : "isch-vcc") : "",
  ].filter(Boolean).join(" ");
  return (
    <g
      data-device-id={key}
      className={cls}
      transform={`translate(${pos.x}, ${pos.y})`}
      onPointerDown={(e) => onPointerDown(e, node)}
      onMouseEnter={() => onHover(key)}
      onMouseLeave={() => onHover(null)}
      style={{ cursor: isLocked ? "default" : "move" }}
    >
      {/* Selection / lock indicators — thin outlines, no fill halo
          (a filled bbox rect reads as a bright square over the art). */}
      {selected && (
        <rect
          x={-3}
          y={-3}
          width={size.w + 6}
          height={size.h + 6}
          rx={4}
          fill="none"
          stroke={HL_COLOR}
          strokeWidth={1}
          pointerEvents="none"
        />
      )}
      {isLocked && !selected && (
        <rect
          x={-3}
          y={-3}
          width={size.w + 6}
          height={size.h + 6}
          rx={4}
          fill="none"
          stroke={LOCK_COLOR}
          strokeWidth={1}
          strokeDasharray="4 3"
          pointerEvents="none"
        />
      )}
      {template ? <use href={`#isch-${template.type}`} /> : (
        <rect width={size.w} height={size.h} fill="none" stroke="var(--ink2)" strokeDasharray="3 2" />
      )}
      {/* Per-instance labels (cannot live inside <use> — shared DOM) */}
      {template?.labels.map((spec, i) => {
        const text = device
          ? labelForSpec(spec, device, key)
          : spec.source === "ref"
            ? (label ?? key)
            : "";
        const lines = text.split("\n");
        return (
          <text key={i} x={spec.x} y={spec.y} className={spec.cls} pointerEvents="none">
            {lines.map((ln, li) => (
              <tspan key={li} x={spec.x} dy={li === 0 ? 0 : 10}>{ln}</tspan>
            ))}
          </text>
        );
      })}
      {isLocked && (
        <text x={size.w + 2} y={-2} fontSize={8} fill={LOCK_COLOR} pointerEvents="none">
          L
        </text>
      )}
      {/* Hit overlay: whole bbox receives pointer events */}
      <rect width={size.w} height={size.h} fill="transparent" pointerEvents="all" />
    </g>
  );
});
