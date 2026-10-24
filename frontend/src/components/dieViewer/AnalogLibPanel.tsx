import { useEffect, useRef } from "react";
import type { AnalogLibBaseContactSide, AnalogLibBulk, AnalogLibParams, AnalogLibTemplate } from "shared";
import type { AnalogPcellLayout } from "shared/analogLib";
import { useLiveValue } from "../../lib/liveValue";
import { drawCellLayers } from "../../renderer/annotations/shapes";
import type { TileBounds } from "../../renderer/types";
import { Ic } from "../../icons";
import type { AnalogCellTool } from "./useAnalogCellTool";

/** A small numeric field: commits on Enter / blur, reverts on Escape. */
export function AnalogNumField({
  label,
  value,
  title,
  onCommit,
  width = 64
}: {
  label: string;
  value: number | undefined;
  title?: string;
  onCommit: (v: number) => void;
  width?: number;
}) {
  // A missing value must not take the panel down with it.
  const num = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const shown = String(Number(num.toFixed(4)));
  const commit = (el: HTMLInputElement) => {
    const v = Number(el.value.trim());
    if (!Number.isFinite(v) || v <= 0 || String(Number(v.toFixed(4))) === shown) {
      el.value = shown;
      return;
    }
    onCommit(v);
  };
  return (
    <label className="row" style={{ gap: 6, alignItems: "center" }} title={title ?? label}>
      <span className="m" style={{ fontSize: 10.5, color: "var(--ink3)", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <span className="input" style={{ width }}>
        <input
          key={shown}
          defaultValue={shown}
          inputMode="decimal"
          spellCheck={false}
          onBlur={(e) => commit(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.currentTarget.value = shown;
              e.currentTarget.blur();
            }
          }}
        />
      </span>
    </label>
  );
}

/** The generated device, drawn to fit the box. */
function DevicePreview({ layout }: { layout: AnalogPcellLayout }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cw = Math.max(1, Math.round(rect.width * dpr));
    const ch = Math.max(1, Math.round(rect.height * dpr));
    canvas.width = cw;
    canvas.height = ch;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const w = layout.cropRect.width;
    const h = layout.cropRect.height;
    if (w <= 0 || h <= 0) return;
    // Fit the device into the box, keeping the aspect.
    const pad = 8 * dpr;
    const zoom = Math.min((cw - pad * 2) / w, (ch - pad * 2) / h);
    ctx.setTransform(zoom, 0, 0, zoom, (cw - w * zoom) / 2, (ch - h * zoom) / 2);
    // The cell box.
    ctx.strokeStyle = "var(--l2)";
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(0, 0, w, h);
    const bounds: TileBounds = {
      size: 0,
      i: 0,
      j: 0,
      world: { x: 0, y: 0, width: 0, height: 0 },
      dpr,
      zoom
    };
    drawCellLayers(ctx, layout.layers, bounds, { outline: true });
  }, [layout]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height: 150,
        background: "var(--panel)",
        border: "1px solid var(--l1)",
        borderRadius: 4
      }}
    />
  );
}

/**
 * The "Lib" tab of the right panel: the analog library.
 *
 * Pick a device, set its parameters and the scale it is generated at,
 * look at the preview, and press "Place" — that arms the placement tool on
 * the die viewer, where the device sticks to the pointer: a click drops it
 * over the transistor in the image, the corners set its size and Enter
 * places it.
 */
export function AnalogLibPanel({ tool }: { tool: AnalogCellTool }) {
  const draft = useLiveValue(tool.draftLive);
  const p = tool.params;
  const isMos = p.kind === "mos";
  const isBjt = p.kind === "bjt";
  const isLpnp = isBjt && p.bjtType === "lpnp";

  const setParams = (next: AnalogLibParams) => tool.setParams(next);
  /** Patch the size parameters (both device kinds share them). */
  const patch = (fields: Record<string, number | string>) =>
    setParams({ ...p, ...fields } as AnalogLibParams);

  // The die's calibration: the scale that makes one template pixel one
  // die pixel, so the extracted W/L match the parameters.
  const fromUm = tool.umPerPx && tool.umPerPx > 0 ? 1 / tool.umPerPx : null;
  const offByCalibration = fromUm != null && Math.abs(tool.scale - fromUm) / fromUm > 0.01;

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="u" style={{ fontSize: 10 }}>
        Analog library
      </div>

      <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
        {tool.templates.map((t) => (
          <button
            key={t.id}
            type="button"
            className={"chip" + (tool.template === t.id ? " on" : "")}
            style={{ cursor: "pointer" }}
            title={t.hint}
            onClick={() => tool.chooseTemplate(t.id as AnalogLibTemplate)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <DevicePreview layout={tool.layout} />

      {tool.problem && (
        <div className="m" style={{ fontSize: 10.5, color: "var(--err)" }}>
          {tool.problem}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <AnalogNumField
            label="W"
            value={p.W_um}
            title="Width of one finger, in micrometres"
            onCommit={(v) => patch({ W_um: v })}
          />
          <AnalogNumField
            label="L"
            value={p.L_um}
            title="Length of one finger, in micrometres"
            onCommit={(v) => patch({ L_um: v })}
          />
          <AnalogNumField
            label="fingers"
            value={p.fingers}
            title="Number of parallel fingers"
            onCommit={(v) => patch({ fingers: Math.max(1, Math.round(v)) })}
          />
        </div>

        {isMos && (
          <div className="row" style={{ gap: 8 }}>
            <span className="m" style={{ fontSize: 10.5, color: "var(--ink3)" }}>
              bulk
            </span>
            {(["none", "tap"] as AnalogLibBulk[]).map((b) => (
              <button
                key={b}
                type="button"
                className={"chip" + (p.bulk === b ? " on" : "")}
                style={{ cursor: "pointer" }}
                title={b === "none" ? "No well contact in the cell" : "A well tap inside the well"}
                onClick={() => patch({ bulk: b })}
              >
                {b === "none" ? "none" : "tap"}
              </button>
            ))}
          </div>
        )}

        {isMos && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <AnalogNumField
              label="multiplier"
              value={p.multiplier}
              title="How many copies of the structure stand side by side"
              onCommit={(v) => patch({ multiplier: Math.max(1, Math.round(v)) })}
            />
            <AnalogNumField
              label="mult. gap"
              value={p.multiplierGap_um}
              title="The clear space between two copies of the structure, in micrometres"
              onCommit={(v) => patch({ multiplierGap_um: v })}
              width={58}
            />
          </div>
        )}

        {isBjt && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <AnalogNumField
              label="emitter–collector"
              value={p.emitterCollectorGap_um ?? 0.8}
              title="The distance from the emitter to the collector, in micrometres"
              onCommit={(v) => patch({ emitterCollectorGap_um: v })}
              width={58}
            />
            {isLpnp ? (
              <AnalogNumField
                label="collector–base"
                value={p.collectorBaseGap_um ?? 0.8}
                title="How far the base reaches past the collector ring, on the side of the base contact, in micrometres"
                onCommit={(v) => patch({ collectorBaseGap_um: v })}
                width={58}
              />
            ) : (
              <AnalogNumField
                label="emitter–base"
                value={p.emitterBaseGap_um ?? 0.4}
                title="How far the base reaches past the emitter, on the side of the base contact, in micrometres"
                onCommit={(v) => patch({ emitterBaseGap_um: v })}
                width={58}
              />
            )}
          </div>
        )}

        {isBjt && (
          <div className="row" style={{ gap: 6, alignItems: "center" }}>
            <span className="m" style={{ fontSize: 10.5, color: "var(--ink3)" }}>
              base contact
            </span>
            {(["left", "right", "top", "bottom"] as AnalogLibBaseContactSide[]).map((s) => (
              <button
                key={s}
                type="button"
                className={"chip" + (p.baseContactSide === s ? " on" : "")}
                style={{ cursor: "pointer" }}
                title={`Put the base contact on the ${s} side`}
                onClick={() => patch({ baseContactSide: s })}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <div className="row" style={{ gap: 8 }}>
          <AnalogNumField
            label="px/µm"
            value={tool.scale}
            title="Pixels per micrometre — the scale the device is generated at"
            onCommit={(v) => tool.setScale(v)}
            width={62}
          />
          {fromUm != null && (
            <button
              type="button"
              className={"chip" + (offByCalibration ? " warn" : "")}
              style={{ cursor: "pointer" }}
              title={`Set the scale to the die's calibration (${fromUm.toFixed(3)} px/µm)`}
              onClick={() => tool.setScale(fromUm)}
            >
              {offByCalibration ? "scale ≠ µm/px" : "scale = µm/px"}
            </button>
          )}
          <span className="m" style={{ fontSize: 10, color: "var(--ink3)" }}>
            lib scale {tool.dieScale}
          </span>
        </div>
      </div>

      <div className="row" style={{ gap: 4 }}>
        <button
          type="button"
          className="btn ghost"
          title="Rotate 90° counter-clockwise"
          onClick={() => tool.orient("rotateCcw")}
        >
          {Ic.rotateCcw}
        </button>
        <button
          type="button"
          className="btn ghost"
          title="Rotate 90° clockwise"
          onClick={() => tool.orient("rotateCw")}
        >
          {Ic.rotateCw}
        </button>
        <button
          type="button"
          className="btn ghost"
          title="Flip horizontally"
          onClick={() => tool.orient("flipH")}
        >
          {Ic.flipH}
        </button>
        <button
          type="button"
          className="btn ghost"
          title="Flip vertically"
          onClick={() => tool.orient("flipV")}
        >
          {Ic.flipV}
        </button>
        <span className="m" style={{ fontSize: 10.5, color: "var(--ink2)" }}>
          {tool.orientation.rotation}°{tool.orientation.flippedH ? " ⇄" : ""}
          {tool.orientation.flippedV ? " ⇵" : ""}
          {draft ? ` · ×${draft.k.toFixed(3)}` : ""}
        </span>
      </div>

      <button
        type="button"
        className="btn accent"
        disabled={!!tool.problem}
        title="Arm the placement tool — the device sticks to the mouse; click to drop it, drag the corners to set the size, Enter places it"
        onClick={() => tool.startPlacing()}
      >
        {tool.editing ? "Place (replace the device)" : "Place"}
      </button>

      {tool.editing && (
        <button
          type="button"
          className="btn ghost"
          title="Leave the edit and place a new device instead"
          onClick={() => tool.stopEditing()}
        >
          New device
        </button>
      )}

      {tool.error && (
        <div className="m" style={{ fontSize: 10.5, color: "var(--err)" }}>
          {tool.error}
        </div>
      )}
      {tool.notice && (
        <div className="m" style={{ fontSize: 10.5, color: "var(--ink2)" }}>
          {tool.notice}
        </div>
      )}
      {!draft && (
        <div className="m" style={{ fontSize: 10.5, color: "var(--ink3)", fontStyle: "italic" }}>
          Press “Place” — the device sticks to the mouse over the die; click to drop it, drag
          the corners to set the size, Enter places it.
        </div>
      )}
    </div>
  );
}
