/**
 * AnalogDeviceLayer.tsx — Canvas overlay for detected analog devices.
 *
 * Renders detected BJT, JFET, resistor, capacitor, and diode outlines
 * with labels (instance name, W/L, AE, etc.) on the cell image canvas.
 * Devices can be selected/hovered for inspection.
 *
 * Colors indicate device type:
 *   MOS:      blue/red gradient
 *   BJT:      green (NPN) / orange (PNP)
 *   JFET:     purple
 *   Resistor: amber
 *   Capacitor: cyan
 *   Diode:    red
 */

import { useMemo } from "react";
import type { AnalogDevice, DeviceGeometry, DeviceKind } from "shared";
import type { Rect } from "../../lib/geometry";

const DEVICE_COLORS: Record<DeviceKind, string> = {
  mos: "#4488ff",
  bjt_npn: "#22cc66",
  bjt_pnp: "#ff8844",
  jfet_n: "#aa44ff",
  jfet_p: "#aa44ff",
  resistor: "#ffaa44",
  capacitor: "#44ddff",
  diode: "#ff4444",
  zener: "#ff6666",
  schottky: "#dd6666",
  inductor: "#66aaff",
  unknown: "#888888",
};

/** Label for the param string (W/L, AE, R, etc.) */
function paramLabel(device: AnalogDevice): string {
  const g = device.geometry as unknown as Record<string, unknown>;
  switch (device.kind) {
    case "mos":
      return `W=${(g.W_um as number)?.toFixed(1)} L=${(g.L_um as number)?.toFixed(2)}` +
        ((g.fingers as number) > 1 ? `/${g.fingers}` : "") +
        ((g.multiplier as number) > 1 ? ` M=${g.multiplier}` : "");
    case "bjt_npn":
    case "bjt_pnp":
      return `AE=${(g.AE_um2 as number)?.toFixed(1)}` +
        ((g.multiplier as number) > 1 ? ` ×${g.multiplier}` : "");
    case "resistor":
      return `R=${(g.resistance_ohms as number)?.toFixed(0)}Ω`;
    case "capacitor":
      return `C=${(g.capacitance_fF as number)?.toFixed(1)}fF`;
    case "diode":
      return `A=${(g.area_um2 as number)?.toFixed(1)}`;
    default:
      return "";
  }
}

interface Props {
  devices: AnalogDevice[];
  /** Viewport transform for mapping device coords to screen */
  cellToScreen: (x: number, y: number) => { x: number; y: number };
  zoom: number;
  /** Selected device id (for highlight) */
  selectedDeviceId?: string | null;
  onSelect?: (deviceId: string | null) => void;
}

export function AnalogDeviceLayer({
  devices,
  cellToScreen,
  zoom,
  selectedDeviceId,
  onSelect,
}: Props) {
  const visible = useMemo(() => devices.length > 0, [devices]);

  if (!visible) return null;

  return (
    <g className="analog-device-layer">
      {devices.map((dev) => {
        const color = DEVICE_COLORS[dev.kind] ?? "#888";
        const outline = dev.outline;
        const bbox = dev.bbox;
        const isSelected = selectedDeviceId === dev.id;
        if (!outline || outline.length < 3) return null;

        const pts = outline.map((p: { x: number; y: number }) => {
          const s = cellToScreen(p.x, p.y);
          return `${s.x},${s.y}`;
        });

        const cx = bbox ? bbox.x + bbox.width / 2 : 0;
        const cy = bbox ? bbox.y + bbox.height / 2 : 0;
        const screenC = cellToScreen(cx, cy);
        const label = dev.instanceName ?? "";
        const params = paramLabel(dev);
        const fontSize = Math.max(8, 12 * zoom);

        return (
          <g
            key={dev.id}
            onClick={() => onSelect?.(isSelected ? null : dev.id)}
            style={{ cursor: "pointer" }}
          >
            {/* Device body fill */}
            <polygon
              points={pts.join(" ")}
              fill={color}
              fillOpacity={isSelected ? 0.35 : 0.15}
              stroke={isSelected ? "#fff" : color}
              strokeWidth={isSelected ? 2.5 : 1.2}
              strokeOpacity={0.9}
            />
            {/* Device name label */}
            {label && (
              <text
                x={screenC.x}
                y={screenC.y - 4}
                textAnchor="middle"
                fill={isSelected ? "#fff" : color}
                fontSize={fontSize}
                fontWeight="bold"
                style={{
                  textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                  pointerEvents: "none",
                  fontFamily: "monospace",
                }}
              >
                {label}
              </text>
            )}
            {/* Parameter label */}
            {params && (
              <text
                x={screenC.x}
                y={screenC.y + fontSize + 2}
                textAnchor="middle"
                fill={isSelected ? "#ddd" : "#aaa"}
                fontSize={fontSize * 0.8}
                style={{
                  textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                  pointerEvents: "none",
                  fontFamily: "monospace",
                }}
              >
                {params}
              </text>
            )}
            {/* Terminal dots for devices with connections */}
            {dev.terminals.map((t: { name: string; netId: number }, i: number) => {
              if (t.netId < 0) return null;
              // Show terminal dots at approximate positions around the bbox
              const cx2 = bbox ? bbox.x + bbox.width * (i + 1) / (dev.terminals.length + 1) : 0;
              const cy2 = bbox ? bbox.y + (i < dev.terminals.length / 2 ? 0 : bbox.height) : 0;
              const sc = cellToScreen(cx2, cy2);
              return (
                <circle
                  key={t.name}
                  cx={sc.x}
                  cy={sc.y}
                  r={3}
                  fill={color}
                  stroke="#fff"
                  strokeWidth={1}
                />
              );
            })}
          </g>
        );
      })}
    </g>
  );
}
