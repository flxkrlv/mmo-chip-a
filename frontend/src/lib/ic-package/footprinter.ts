import { fp as fpFn } from "@tscircuit/footprinter";
import type { PackagePin } from "shared";

interface RawPad {
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rect_pad_width?: number;
  rect_pad_height?: number;
  port_hints?: string[];
}

function isRawPad(e: unknown): e is RawPad {
  if (!e || typeof e !== "object") return false;
  const t = (e as { type?: string }).type;
  return (
    (t === "pcb_smtpad" || t === "pcb_plated_hole") &&
    typeof (e as RawPad).x === "number" &&
    typeof (e as RawPad).y === "number"
  );
}

/** Curated footprint descriptors shown in the package selector. */
export const PACKAGE_PRESETS = [
  { value: "soic8", label: "SOIC-8" },
  { value: "soic16", label: "SOIC-16" },
  { value: "sot23", label: "SOT-23 (3)" },
  { value: "sot25", label: "SOT-23-5" },
  { value: "sot89", label: "SOT-89" },
  { value: "sot223", label: "SOT-223" },
  { value: "dip8", label: "DIP-8" },
  { value: "dip14", label: "DIP-14" },
  { value: "dip16", label: "DIP-16" },
  { value: "tssop20", label: "TSSOP-20" },
  { value: "msop10", label: "MSOP-10" },
  { value: "qfn16", label: "QFN-16" },
  { value: "qfn32", label: "QFN-32" },
  { value: "qfp32", label: "QFP-32" },
  { value: "qfp64", label: "QFP-64" },
  { value: "qfp128", label: "QFP-128" },
] as const;

export interface PackageGeom {
  pins: PackagePin[];
  /** Bounding box of the package in mm (min/max x/y around pin positions,
   *  excluding pin extents — used to draw the body outline). */
  body: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Parse a footprinter descriptor (e.g. "soic8", "sot25") into normalized
 *  pins in mm. Accepts any valid descriptor; throws on unknown. */
export function loadPackageGeom(descriptor: string): PackageGeom {
  const elements = fpFn.string(descriptor).circuitJson() as unknown[];
  const pads: RawPad[] = elements.filter(isRawPad);

  const pins: PackagePin[] = pads.map((p, i) => {
    const num = Number(p.port_hints?.[0]) || i + 1;
    return {
      number: num,
      name: "",
      x: p.x,
      y: p.y,
      w: p.width ?? p.rect_pad_width ?? 0.5,
      h: p.height ?? p.rect_pad_height ?? 0.25,
    };
  });
  pins.sort((a, b) => a.number - b.number);

  // Body outline: expand the pin bounding box by a margin. Footprinter's
  // courtyard gives the true outline but varies by package; a simple
  // expansion of the pin extents is good enough for the bond-mapper view.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pins) {
    const hw = (p.w ?? 0.5) / 2, hh = (p.h ?? 0.25) / 2;
    minX = Math.min(minX, p.x - hw); maxX = Math.max(maxX, p.x + hw);
    minY = Math.min(minY, p.y - hh); maxY = Math.max(maxY, p.y + hh);
  }
  const margin = 0.6;
  return {
    pins,
    body: { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin },
  };
}
