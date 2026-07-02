/**
 * netlist2svgSkin.ts — Custom SVG skin for netlist2svg with NMOS/PMOS symbols.
 *
 * Based on the netlist2svg analog.svg with added:
 *   - nmos_v: 4-terminal NMOS (D/G/S/B) — vertical orientation
 *   - pmos_v: 4-terminal PMOS (D/G/S/B) — vertical orientation, bubble on gate
 *
 * Layout direction: DOWN (VDD at top, GND at bottom) — optimal for analog schematics.
 */

/** ELK layered layout strategies for the schematic renderer */
export type LayoutStrategy = "BRANDES_KOEPF" | "INTERACTIVE" | "SIMPLE";

export const LAYOUT_STRATEGIES: { value: LayoutStrategy; label: string; desc: string }[] = [
  { value: "BRANDES_KOEPF", label: "BK (best)", desc: "Brandes & Koepf — good quality, may crash on large graphs" },
  { value: "INTERACTIVE", label: "Interactive", desc: "Interactive — medium quality, preserves layer order" },
  { value: "SIMPLE", label: "Simple", desc: "Simple — worst quality, but never crashes" },
];

/** ELK layout direction — controls signal flow and power rail placement */
export type LayoutDirection = "UP" | "DOWN" | "LEFT" | "RIGHT";

export const LAYOUT_DIRECTIONS: { value: LayoutDirection; label: string; desc: string }[] = [
  { value: "DOWN", label: "↓ Down", desc: "VDD top, GND bottom — optimal for analog schematics" },
  { value: "UP", label: "↑ Up", desc: "VDD bottom, GND top — less natural" },
  { value: "RIGHT", label: "→ Right", desc: "Inputs left, outputs right — for block/functional diagrams" },
  { value: "LEFT", label: "← Left", desc: "Inputs right, outputs left" },
];

/** ELK post-compaction strategy — controls how tightly nodes are packed after layout */
export type CompactionLevel = 0 | 1 | 2 | 3 | 4;

export const COMPACTION_LEVELS: { value: CompactionLevel; label: string; desc: string }[] = [
  { value: 0, label: "Off", desc: "No post-compaction — safest, more whitespace" },
  { value: 1, label: "LUT", desc: "Look-up table — light compaction, safe" },
  { value: 2, label: "Scanline", desc: "Scanline — good density, stable on most graphs" },
  { value: 3, label: "Scanline+Sweep", desc: "Scanline + sweep — denser, may crash on complex graphs" },
  { value: 4, label: "Pocket", desc: "Pocket — max density, prone to hitbox errors on dense graphs" },
];

/** Colors used for power net highlighting (VDD red, GND blue) */
export const POWER_COLORS = {
  vdd: "#ff3344",
  gnd: "#3388ff",
} as const;

/**
 * Build skin with a specific ELK layout strategy, direction, and compaction level.
 *
 * @param strategy   - Node placement algorithm (default: BRANDES_KOEPF)
 * @param direction  - Layout flow direction (default: DOWN)
 * @param compaction - Post-compaction level 0-4 (default: 2 = SCANLINE)
 */
export function buildSkin(strategy?: LayoutStrategy, direction?: LayoutDirection, compaction?: CompactionLevel): string {
  const np = LAYOUT_STRATEGIES.find(s => s.value === strategy) ?? LAYOUT_STRATEGIES[0];
  const dir = LAYOUT_DIRECTIONS.find(d => d.value === direction) ?? LAYOUT_DIRECTIONS[0];
  const comp = COMPACTION_LEVELS.find(c => c.value === compaction) ?? COMPACTION_LEVELS[2];
  return CUSTOM_ANALOG_SKIN
    .replace(
      /org\.eclipse\.elk\.layered\.nodePlacement\.strategy="[^"]*"/,
      `org.eclipse.elk.layered.nodePlacement.strategy="${np.value}"`
    )
    .replace(
      /org\.eclipse\.elk\.layered\.compaction\.postCompaction\.strategy="[^"]*"/,
      `org.eclipse.elk.layered.compaction.postCompaction.strategy="${comp.value}"`
    )
    .replace(
      /org\.eclipse\.elk\.direction="[^"]*"/,
      `org.eclipse.elk.direction="${dir.value}"`
    );
}

export const CUSTOM_ANALOG_SKIN = `<svg xmlns="http://www.w3.org/2000/svg"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:s="https://github.com/ajsb85/netlist2svg"><style>
  .n2s-svg { stroke: #000; fill: none; }
  .n2s-svg text {
    fill: #000; stroke: none;
    font-size: 10px; font-weight: bold;
    font-family: "Courier New", monospace;
  }
  .n2s-svg .nodelabel { text-anchor: middle; }
  .n2s-svg .valuelabel {
    white-space: pre;
    line-height: 1.3;
    font-size: 9px;
    fill: #888;
  }
  .n2s-svg .inputPortLabel { text-anchor: end; }
  .n2s-svg .splitjoinBody { fill: #000; }
  .n2s-svg .junction { fill: #000; }
  .n2s-svg .labelBackground { fill: #fff; stroke: none; }
  .n2s-svg .detail, .n2s-svg .symbol { stroke-linejoin: round; stroke-linecap: round; }
  .n2s-svg .symbol { stroke-width: 2; }
  .n2s-svg .detail { fill: #000; }

  /* Dark theme (forced via .n2s-svg class) */
  .n2s-svg {
    stroke: #fff !important;
  }
  .n2s-svg text { fill: #fff !important; }
  .n2s-svg .splitjoinBody { fill: #fff !important; }
  .n2s-svg .junction { fill: #fff !important; }
  .n2s-svg .labelBackground { fill: #0a192f !important; }
  .n2s-svg .detail { fill: #fff !important; }
  .n2s-svg .valuelabel { fill: #88aacc !important; }
  .n2s-svg circle, .n2s-svg path, .n2s-svg rect, .n2s-svg line { stroke: #fff; }
  .n2s-svg .subModuleOdd { fill: #0e2238 !important; }
  .n2s-svg .subModuleEven { fill: #16365a !important; }
  /* Power net colors — VDD red, GND blue */
  .n2s-svg [s\\:type="vcc"] path { stroke: #ff3344 !important; fill: none !important; }
  .n2s-svg [s\\:type="vcc"] .detail { fill: #ff3344 !important; stroke: #ff3344 !important; }
  .n2s-svg [s\\:type="vcc"] text { fill: #ff3344 !important; }
  .n2s-svg [s\\:type="gnd"] path { stroke: #3388ff !important; fill: none !important; }
  .n2s-svg [s\\:type="gnd"] .detail { fill: #3388ff !important; stroke: #3388ff !important; }
  .n2s-svg [s\\:type="gnd"] text { fill: #3388ff !important; }
  .n2s-svg [style*="fill:#000"], .n2s-svg [style*="fill:#000000"] { fill: #fff !important; }
  .n2s-svg [style*="stroke:#000"], .n2s-svg [style*="stroke:#000000"] { stroke: #fff !important; }
  /* Light theme variant — used for white-background SVG download */
  .n2s-light {
    stroke: #000 !important;
    fill: none !important;
  }
  .n2s-light text { fill: #000 !important; stroke: none !important; font-size: 10px; font-weight: bold; font-family: "Courier New", monospace; }
  .n2s-light .nodelabel { text-anchor: middle; }
  .n2s-light .inputPortLabel { text-anchor: end; }
  .n2s-light .splitjoinBody { fill: #000 !important; }
  .n2s-light .junction { fill: #000 !important; }
  .n2s-light .labelBackground { fill: #fff !important; stroke: none !important; }
  .n2s-light .detail, .n2s-light .symbol { stroke-linejoin: round; stroke-linecap: round; }
  .n2s-light .symbol { stroke-width: 2; }
  .n2s-light .detail { fill: #000 !important; }
  .n2s-light .valuelabel { fill: #555 !important; font-size: 9px; }
  .n2s-light circle, .n2s-light path, .n2s-light rect, .n2s-light line { stroke: #000; }
  .n2s-light .subModuleOdd { fill: #e9e9e9 !important; }
  .n2s-light .subModuleEven { fill: #ffffff !important; }
  /* Power net colors for light theme (SVG export) */
  .n2s-light [s\\:type="vcc"] path { stroke: #cc2233 !important; fill: none !important; }
  .n2s-light [s\\:type="vcc"] .detail { fill: #cc2233 !important; stroke: #cc2233 !important; }
  .n2s-light [s\\:type="vcc"] text { fill: #cc2233 !important; }
  .n2s-light [s\\:type="gnd"] path { stroke: #2266cc !important; fill: none !important; }
  .n2s-light [s\\:type="gnd"] .detail { fill: #2266cc !important; stroke: #2266cc !important; }
  .n2s-light [s\\:type="gnd"] text { fill: #2266cc !important; }
  .n2s-light [style*="fill:#000"], .n2s-light [style*="fill:#000000"] { fill: #000 !important; }
  .n2s-light [style*="stroke:#000"], .n2s-light [style*="stroke:#000000"] { stroke: #000 !important; }
</style>

  <s:properties
    constants="false"
    splitsAndJoins="false"
    genericsLaterals="true">
    <s:layoutEngine
        org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers="5"
        org.eclipse.elk.layered.compaction.postCompaction.strategy="0"
        org.eclipse.elk.layered.nodePlacement.strategy="BRANDES_KOEPF"
        org.eclipse.elk.spacing.nodeNode= "35"
        org.eclipse.elk.direction="DOWN"/>
  </s:properties>

  <!-- ===== POWER ===== -->
  <g s:type="vcc" s:width="20" s:height="30" transform="translate(5,20)">
    <s:alias val="vcc" />
    <text x="10" y="-4" class="nodelabel $cell_id" s:attribute="name">name</text>
    <path d="M0,0 H20 L10,15 Z M10,15 V30" class="$cell_id"/>
    <g s:x="10" s:y="30" s:pid="A" s:position="bottom"/>
  </g>

  <g s:type="vee" s:width="20" s:height="30" transform="translate(40,35)">
    <s:alias val="vee" />
    <text x="10" y="10" class="nodelabel $cell_id" s:attribute="name">name</text>
    <path d="M0,0 H20 L10,-15 Z M10,-15 V-30" class="$cell_id"/>
    <g s:x="10" s:y="-30" s:pid="A" s:position="top"/>
  </g>

  <g s:type="gnd" s:width="20" s:height="30" transform="translate(80,35)">
    <s:alias val="gnd"/>
    <text x="30" y="20" class="nodelabel $cell_id" s:attribute="name">name</text>
    <path d="M0,0 H20 M3,5 H17 M7,10 H13 M10,0 V-15" class="$cell_id"/>
    <g s:x="10" s:y="-15" s:pid="A" s:position="top"/>
  </g>

  <!-- ===== SIGNALS ===== -->
  <g s:type="inputExt" s:width="30" s:height="20" transform="translate(5,70)">
    <text x="15" y="-4" class="$cell_id" s:attribute="ref">input</text>
    <s:alias val="$_inputExt_"/>
    <path d="M0,0 V20 H15 L30,10 15,0 Z" class="$cell_id"/>
    <g s:x="30" s:y="10" s:pid="Y" s:position="right"/>
  </g>

  <g s:type="outputExt" s:width="30" s:height="20" transform="translate(60,70)">
    <text x="15" y="-4" class="$cell_id" s:attribute="ref">output</text>
    <s:alias val="$_outputExt_"/>
    <path d="M30,0 V20 H15 L0,10 15,0 Z" class="$cell_id"/>
    <g s:x="0" s:y="10" s:pid="A" s:position="left"/>
  </g>

  <!-- ===== PASSIVES ===== -->
  <g s:type="resistor_h" s:width="50" s:height="10" transform="translate(5,110)">
    <s:alias val="r_h"/>
    <text class="nodelabel $cell_id" x="25" y="-5" s:attribute="ref">X1</text>
    <text class="nodelabel $cell_id" x="25" y="20" s:attribute="value">Xk</text>
    <path d="M10,0 H40 V10 H10 Z" class="symbol $cell_id"/>
    <path d="M0,5 H10 M40,5 H50" class="connect $cell_id"/>
    <g s:x="0" s:y="5" s:pid="A" s:position="left"/>
    <g s:x="50" s:y="5" s:pid="B" s:position="right"/>
  </g>

  <g s:type="resistor_v" s:width="10" s:height="50" transform="translate(25,130)">
    <s:alias val="r_v"/>
    <text x="15" y="15" s:attribute="ref" class="$cell_id">X1</text>
    <text x="15" y="30" s:attribute="value" class="$cell_id">Xk</text>
    <path d="M0,10 V40 H10 V10 Z" class="symbol $cell_id"/>
    <path d="M5,0 V10 M5,40 V50" class="connect $cell_id"/>
    <g s:x="5" s:y="0" s:pid="A" s:position="top"/>
    <g s:x="5" s:y="50" s:pid="B" s:position="bottom"/>
  </g>

  <g s:type="capacitor_h" s:width="50" s:height="30" transform="translate(60,100)">
    <s:alias val="c_h"/>
    <text x="35" y="5" s:attribute="ref" class="$cell_id">X1</text>
    <text x="35" y="30" s:attribute="value" class="$cell_id">Xu</text>
    <path d="M20,0 V30 M30,0 V30" class="symbol $cell_id"/>
    <path d="M0,15 H20 M30,15 H50" class="connect $cell_id"/>
    <g s:x="0" s:y="15" s:pid="A" s:position="left"/>
    <g s:x="50" s:y="15" s:pid="B" s:position="right"/>
  </g>

  <g s:type="capacitor_v" s:width="30" s:height="50" transform="translate(70,130)">
    <s:alias val="c_v"/>
    <text x="25" y="10" s:attribute="ref" class="$cell_id">X1</text>
    <text x="25" y="45" s:attribute="value" class="$cell_id">Xu</text>
    <path d="M0,20 H30 M0,30 H30" class="symbol $cell_id"/>
    <path d="M15,0 V20 M15,30 V50" class="connect $cell_id"/>
    <g s:x="15" s:y="0" s:pid="A" s:position="top"/>
    <g s:x="15" s:y="50" s:pid="B" s:position="bottom"/>
  </g>

  <g s:type="inductor_h" s:width="50" s:height="10" transform="translate(115,110)">
    <s:alias val="l_h"/>
    <text class="nodelabel $cell_id" x="25" y="-5" s:attribute="ref">X1</text>
    <text class="nodelabel $cell_id" x="25" y="20" s:attribute="value">XpF</text>
    <path d="M5,5 A5,5 0 0 1 15,5 A5,5 0 0 1 25,5 A5,5 0 0 1 35,5 A5,5 0 0 1 45,5" class="$cell_id"/>
    <path d="M0,5 H5 M45,5 H50" class="connect $cell_id"/>
    <g s:x="0" s:y="5" s:pid="A" s:position="left"/>
    <g s:x="50" s:y="5" s:pid="B" s:position="right"/>
  </g>

  <g s:type="inductor_v" s:width="10" s:height="50" transform="translate(135,130)">
    <s:alias val="l_v"/>
    <text x="15" y="15" s:attribute="ref" class="$cell_id">X1</text>
    <text x="15" y="35" s:attribute="value" class="$cell_id">XpF</text>
    <path d="M5,5 A5,5 0 0 1 5,15 A5,5 0 0 1 5,25 A5,5 0 0 1 5,35 A5,5 0 0 1 5,45" class="$cell_id"/>
    <path d="M5,0 V5 M5,45 V50" class="connect $cell_id"/>
    <g s:x="5" s:y="0" s:pid="A" s:position="top"/>
    <g s:x="5" s:y="50" s:pid="B" s:position="bottom"/>
  </g>

  <!-- ===== SOURCES ===== -->
  <g s:type="voltage_source" s:width="32" s:height="52" transform="translate(20,180)">
    <s:alias val="v"/>
    <text x="35" y="20" s:attribute="ref" class="$cell_id">X1</text>
    <text x="35" y="35" s:attribute="value" class="$cell_id">XV</text>
    <circle cx="16" cy="26" r="16" class="symbol $cell_id"/>
    <path d="M16,10 V42" class="detail $cell_id"/>
    <path d="M16,0 V10 M16,42 V52" class="connect $cell_id"/>
    <g s:x="16" s:y="0" s:pid="+" s:position="top"/>
    <g s:x="16" s:y="52" s:pid="-" s:position="bottom"/>
  </g>

  <g s:type="current_source" s:width="32" s:height="52" transform="translate(75,180)">
    <s:alias val="i"/>
    <text x="35" y="20" s:attribute="ref" class="$cell_id">X1</text>
    <text x="35" y="35" s:attribute="value" class="$cell_id">XA</text>
    <circle cx="16" cy="26" r="16" class="symbol $cell_id"/>
    <path d="M0,26 H32" class="detail $cell_id"/>
    <path d="M16,0 V10 M16,42 V52" class="connect $cell_id"/>
    <g s:x="16" s:y="0" s:pid="+" s:position="top"/>
    <g s:x="16" s:y="52" s:pid="-" s:position="bottom"/>
  </g>

  <!-- ===== DIODES ===== -->
  <g s:type="diode_h" s:width="50" s:height="20" transform="translate(5,250)">
    <s:alias val="d_h"/>
    <text class="nodelabel $cell_id" x="25" y="-5" s:attribute="ref">X1</text>
    <path d="M15,0 V20 L35,10 Z M35,0 V20" class="symbol $cell_id"/>
    <path d="M0,10 H15 M35,10 H50" class="connect $cell_id"/>
    <g s:x="0" s:y="10" s:pid="+" s:position="left"/>
    <g s:x="50" s:y="10" s:pid="-" s:position="right"/>
  </g>

  <g s:type="diode_v" s:width="20" s:height="50" transform="translate(20,280)">
    <s:alias val="d_v"/>
    <text x="25" y="25" s:attribute="ref" class="$cell_id">X1</text>
    <path d="M0,15 H20 L10,35 Z M0,35 H20" class="symbol $cell_id"/>
    <path d="M10,0 V15 M10,35 V50" class="connect $cell_id"/>
    <g s:x="10" s:y="0" s:pid="+" s:position="top"/>
    <g s:x="10" s:y="50" s:pid="-" s:position="bottom"/>
  </g>

  <g s:type="diode_schottky_h" s:width="50" s:height="20" transform="translate(60,250)">
    <s:alias val="d_sk_h"/>
    <text class="nodelabel $cell_id" x="25" y="-5" s:attribute="ref">X1</text>
    <path d="M15,0 V20 L35,10 Z M35,0 V20" class="symbol $cell_id"/>
    <path d="M0,10 H15 M35,10 H50" class="connect $cell_id"/>
    <path d="M35,0 H40 M35,20 H30" class="symbol $cell_id"/>
    <g s:x="0" s:y="10" s:pid="+" s:position="left"/>
    <g s:x="50" s:y="10" s:pid="-" s:position="right"/>
  </g>

  <g s:type="diode_schottky_v" s:width="20" s:height="50" transform="translate(75,280)">
    <s:alias val="d_sk_v"/>
    <text x="25" y="25" s:attribute="ref" class="$cell_id">X1</text>
    <path d="M0,15 H20 L10,35 Z M0,35 H20" class="symbol $cell_id"/>
    <path d="M10,0 V15 M10,35 V50" class="connect $cell_id"/>
    <path d="M0,35 V40 M20,35 V30" class="symbol $cell_id"/>
    <g s:x="10" s:y="0" s:pid="+" s:position="top"/>
    <g s:x="10" s:y="50" s:pid="-" s:position="bottom"/>
  </g>

  <!-- ===== TRANSISTORS: BJT ===== -->
  <g s:type="transistor_npn" s:width="32" s:height="32" transform="translate(15,350)">
    <s:alias val="q_npn"/>
    <text x="35" y="20" s:attribute="ref" class="$cell_id">X1</text>
    <circle r="16" cx="16" cy="16" class="symbol $cell_id"/>
    <path d="M0,16 H12 M12,6 V26" class="detail $cell_id"/>
    <path d="m12,10 11,-8" class="detail $cell_id"/>
    <path d="m12,21 11,8" class="detail $cell_id"/>
    <path d="m23,29 -6,-1 3,-5 z" style="fill:#000000" class="$cell_id"/>
    <g s:x="22" s:y="2" s:pid="C" s:position="top"/>
    <g s:x="0" s:y="16" s:pid="B" s:position="left"/>
    <g s:x="23" s:y="29" s:pid="E" s:position="bottom"/>
  </g>

  <g s:type="transistor_pnp" s:width="32" s:height="32" transform="translate(85,350)">
    <s:alias val="q_pnp"/>
    <text x="35" y="20" s:attribute="ref" class="$cell_id">X1</text>
    <circle r="16" cx="16" cy="16" class="symbol $cell_id"/>
    <path d="M0,16 H12 M12,6 V26" class="detail $cell_id"/>
    <path d="m12,10 11,-8" class="detail $cell_id"/>
    <path d="m12,21 11,8" class="detail $cell_id"/>
    <path d="m14,9 6,-1 -3,-5 z" style="fill:#000000" class="$cell_id"/>
    <g s:x="22" s:y="2" s:pid="C" s:position="top"/>
    <g s:x="0" s:y="16" s:pid="B" s:position="left"/>
    <g s:x="23" s:y="29" s:pid="E" s:position="bottom"/>
  </g>

  <!-- ===== TRANSISTORS: MOS ===== -->
  <!--
    Based on user's reference SVGs (nmos.svg / pmos.svg).
    Gate on LEFT (vertical bar at x=20 with horizontal connection to left edge),
    bulk/substrate (B) on RIGHT (body connection from channel to right edge).
    NMOS: S=bottom (arrow right/outward toward G), D=top, G=left, B=right.
    PMOS: S=top (arrow left/inward toward channel), D=bottom, G=left, B=right.

    Multi-line value display: the <text s:attribute="value"> element uses
    white-space:pre so \n in the attribute string renders as line breaks.
  -->
  <g s:type="transistor_nmos" s:width="42" s:height="36" transform="translate(130,340)">
    <s:alias val="nmos_v"/>
    <text x="16" y="42" class="nodelabel $cell_id" s:attribute="ref">M1</text>
    <text x="16" y="56" class="nodelabel $cell_id valuelabel $cell_id" s:attribute="value"></text>
    <!-- Gate C-shape (body+gate combined) -->
    <path d="M30,36 V30 H20 V6 H30 V0" class="symbol $cell_id"/>
    <!-- Gate connection from left edge to C-shape left side — G port on left -->
    <path d="M 0,18 H20" class="connect $cell_id"/>
    <!-- Body connection from channel area to right — B port offset right of D/S -->
    <path d="M 15.501953,18 H36" class="connect $cell_id"/>
    <!-- Drain from top-right corner to C-shape top bar -->
    <path d="M30,0 V6" class="connect $cell_id"/>
    <!-- Internal channel -->
    <path d="M 16,6 V 30" class="symbol $cell_id"/>
    <!-- Source from bottom-right corner, up to C-shape bottom bar, with arrow -->
    <path d="M30,30 V36" class="connect $cell_id"/>
    <!-- Source arrow (NMOS → right on C bottom bar) -->
    <path d="M20,30 H27 M27,30 L25,28 L25,32 Z" class="detail $cell_id"/>
    <g s:x="30" s:y="0" s:pid="D" s:position="top"/>
    <g s:x="0" s:y="18" s:pid="G" s:position="left"/>
    <g s:x="30" s:y="36" s:pid="S" s:position="bottom"/>
    <g s:x="36" s:y="18" s:pid="B" s:position="right"/>
  </g>

  <g s:type="transistor_pmos" s:width="42" s:height="36" transform="translate(180,340)">
    <s:alias val="pmos_v"/>
    <text x="16" y="42" class="nodelabel $cell_id" s:attribute="ref">M1</text>
    <text x="16" y="56" class="nodelabel $cell_id valuelabel $cell_id" s:attribute="value"></text>
    <!-- Gate C-shape (body+gate combined) -->
    <path d="M30,36 V30 H20 V6 H30 V0" class="symbol $cell_id"/>
    <!-- Gate connection from left edge to C-shape — G port on left -->
    <path d="M 0,18 H20" class="connect $cell_id"/>
    <!-- Body connection from channel area to right — B port offset right of D/S -->
    <path d="M 16.424168,18 H36" class="connect $cell_id"/>
    <!-- Source from top-right corner to C-shape top bar with arrow -->
    <path d="M30,0 V6" class="connect $cell_id"/>
    <!-- Source arrow (PMOS ← left on C top bar) -->
    <path d="m 29.294009,6 h -7 m 0,0 2,-2 v 4 z" class="detail $cell_id"/>
    <!-- Internal channel -->
    <path d="M 16.758323,6 V 30" class="symbol $cell_id"/>
    <!-- Drain from bottom-right corner to C-shape bottom bar -->
    <path d="M30,30 V36" class="connect $cell_id"/>
    <g s:x="30" s:y="0" s:pid="S" s:position="top"/>
    <g s:x="0" s:y="18" s:pid="G" s:position="left"/>
    <g s:x="30" s:y="36" s:pid="D" s:position="bottom"/>
    <g s:x="36" s:y="18" s:pid="B" s:position="right"/>
  </g>

  <!-- ===== GENERIC ===== -->
  <g s:type="generic" s:width="30" s:height="40" transform="translate(150, 400)">
    <text x="15" y="-4" class="nodelabel $cell_id" s:attribute="ref">generic</text>
    <rect width="30" height="40" x="0" y="0" s:generic="body" class="$cell_id"/>
    <g transform="translate(30,10)"
       s:x="30" s:y="10" s:pid="out0" s:position="right">
      <text x="5" y="-4" class="$cell_id">out0</text>
    </g>
    <g transform="translate(30,30)"
       s:x="30" s:y="30" s:pid="out1" s:position="right">
      <text x="5" y="-4" class="$cell_id">out1</text>
    </g>
    <g transform="translate(0,10)"
       s:x="0" s:y="10" s:pid="in0" s:position="left">
      <text x="-3" y="-4" class="inputPortLabel $cell_id">in0</text>
    </g>
    <g transform="translate(0,30)"
       s:x="0" s:y="30" s:pid="in1" s:position="left">
      <text x="-3" y="-4" class="inputPortLabel $cell_id">in1</text>
    </g>
  </g>

  <g s:type="sub_odd" s:width="30" s:height="40" transform="translate(200, 400)">
    <text x="15" y="-4" class="nodelabel $cell_id" s:attribute="ref">sub_odd</text>
    <rect width="30" height="40" x="0" y="0" s:generic="body" fill="#e9e9e9" rx="4" class="subModuleOdd $cell_id"/>
    <g transform="translate(30,10)"
       s:x="30" s:y="10" s:pid="out0" s:position="right">
      <text x="5" y="-4" class="$cell_id">out0</text>
    </g>
    <g transform="translate(30,30)"
       s:x="30" s:y="30" s:pid="out1" s:position="right">
      <text x="5" y="-4" class="$cell_id">out1</text>
    </g>
    <g transform="translate(0,10)"
       s:x="0" s:y="10" s:pid="in0" s:position="left">
      <text x="-3" y="-4" class="inputPortLabel $cell_id">in0</text>
    </g>
    <g transform="translate(0,30)"
       s:x="0" s:y="30" s:pid="in1" s:position="left">
      <text x="-3" y="-4" class="inputPortLabel $cell_id">in1</text>
    </g>
  </g>

  <g s:type="sub_even" s:width="30" s:height="40" transform="translate(250, 400)">
    <text x="15" y="-4" class="nodelabel $cell_id" s:attribute="ref">sub_even</text>
    <rect width="30" height="40" x="0" y="0" s:generic="body" fill="#ffffff" rx="4" class="subModuleEven $cell_id"/>
    <g transform="translate(30,10)"
       s:x="30" s:y="10" s:pid="out0" s:position="right">
      <text x="5" y="-4" class="$cell_id">out0</text>
    </g>
    <g transform="translate(30,30)"
       s:x="30" s:y="30" s:pid="out1" s:position="right">
      <text x="5" y="-4" class="$cell_id">out1</text>
    </g>
    <g transform="translate(0,10)"
       s:x="0" s:y="10" s:pid="in0" s:position="left">
      <text x="-3" y="-4" class="inputPortLabel $cell_id">in0</text>
    </g>
    <g transform="translate(0,30)"
       s:x="0" s:y="30" s:pid="in1" s:position="left">
      <text x="-3" y="-4" class="inputPortLabel $cell_id">in1</text>
    </g>
  </g>

  <!-- ===== MISC ===== -->
  <g s:type="opamp" s:width="60" s:height="40" transform="translate(20,450)">
    <s:alias val="op"/>
    <text x="40" y="35" s:attribute="ref" class="$cell_id">X1</text>
    <path d="M10,0 V40 L50,20 Z" class="symbol $cell_id"/>
    <path d="M0,10 H10 M0,30 H10 M50,20 H60 M30,0 V10 M30,40 V30" class="connect $cell_id"/>
    <path d="m15,10 5,0 m-2.5,-2.5 0,5" class="detail $cell_id"/>
    <path d="m15,30 5,0" class="detail $cell_id"/>
    <g s:x="0" s:y="10" s:pid="+" s:position="left"/>
    <g s:x="0" s:y="30" s:pid="-" s:position="left"/>
    <g s:x="60" s:y="20" s:pid="OUT" s:position="right"/>
    <g s:x="30" s:y="0" s:pid="VCC" s:position="top"/>
    <g s:x="30" s:y="40" s:pid="VEE" s:position="bottom"/>
  </g>

  <!-- ===== BLOCK DIAGRAM — custom types for functional mode ===== -->
  <!-- Block name shown via s:attribute="name" on the <text> element.
       We set attributes: { name: blockName } on the Yosys cell. -->
  <g s:type="block_odd" s:width="30" s:height="40">
    <s:alias val="block_odd"/>
    <text x="15" y="-6" class="nodelabel $cell_id" s:attribute="name">Block</text>
    <rect width="30" height="40" x="0" y="0" s:generic="body" class="subModuleOdd" rx="6" />
    <g s:x="0" s:y="10" s:pid="p0" s:position="left">
      <text x="-3" y="-4" class="inputPortLabel $cell_id">p0</text>
    </g>
    <g s:x="30" s:y="10" s:pid="p1" s:position="right">
      <text x="5" y="-4" class="$cell_id">p1</text>
    </g>
  </g>

  <g s:type="block_even" s:width="30" s:height="40">
    <s:alias val="block_even"/>
    <text x="15" y="-6" class="nodelabel $cell_id" s:attribute="name">Block</text>
    <rect width="30" height="40" x="0" y="0" s:generic="body" class="subModuleEven" rx="6" />
    <g s:x="0" s:y="10" s:pid="p0" s:position="left">
      <text x="-3" y="-4" class="inputPortLabel $cell_id">p0</text>
    </g>
    <g s:x="30" s:y="10" s:pid="p1" s:position="right">
      <text x="5" y="-4" class="$cell_id">p1</text>
    </g>
  </g>
</svg>`;
