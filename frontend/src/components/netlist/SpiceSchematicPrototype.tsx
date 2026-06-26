/**
 * SpiceSchematicPrototype.tsx — quick prototype of @spice-ts/ui SchematicView
 *
 * Takes a SPICE netlist string, parses it with @spice-ts/core, and renders
 * the schematic via @spice-ts/ui/react SchematicView component.
 */

import { useMemo } from "react";
import { parse, type CircuitIR } from "@spice-ts/core";
import { SchematicView } from "@spice-ts/ui/react";

interface Props {
  /** SPICE netlist as a string */
  netlist: string;
  /** Height of the schematic view pane (default 500) */
  height?: number;
}

export function SpiceSchematicPrototype({ netlist, height = 500 }: Props) {
  const circuit = useMemo<CircuitIR | null>(() => {
    try {
      const ckt = parse(netlist);
      return ckt.toIR();
    } catch (err) {
      console.error("spice-ts parse error:", err);
      return null;
    }
  }, [netlist]);

  if (!circuit) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height,
          color: "var(--ink3)",
          fontStyle: "italic",
        }}
      >
        Could not parse netlist
      </div>
    );
  }

  return (
    <div style={{ background: "var(--card)", borderRadius: 8, overflow: "hidden" }}>
      <SchematicView
        circuit={circuit}
        theme="dark"
        height={height}
        onNodeClick={(net) => console.log("net click:", net)}
      />
    </div>
  );
}

/**
 * A sample 5-transistor OTA (diff pair + current mirror load + tail)
 * SPICE netlist for quick testing.
 */
export const SAMPLE_OTA_NETLIST = `* 5-transistor OTA (simple op-amp)
VDD vdd 0 DC 5
VSS vss 0 DC -5
VINP inp 0 DC 0 AC 1
VINN inn 0 DC 0

* Bias
IBIAS bias 0 DC 50u

* Tail current source (NMOS)
M5 tail bias vss vss NMOS W=10u L=1u M=1

* Diff pair (NMOS)
M1 inp1 inp vss NMOS W=20u L=1u M=1
M2 outn inn vss NMOS W=20u L=1u M=1

* Current mirror load (PMOS)
M3 outn outn vdd vdd PMOS W=20u L=1u M=1
M4 out outn vdd vdd PMOS W=20u L=1u M=1

* Output
CL out vss 1p

.MODEL NMOS NMOS (VTO=0.7 KP=120u LAMBDA=0.01)
.MODEL PMOS PMOS (VTO=-0.7 KP=40u LAMBDA=0.02)

.op
.end
`;

/**
 * A simpler test circuit: resistor divider + RC filter
 */
export const SAMPLE_RC_NETLIST = `* RC low-pass filter
V1 in 0 DC 5 AC 1
R1 in out 1k
C1 out 0 1u
.op
.ac dec 10 1 100k
.end
`;

/**
 * Single transistor amplifier
 */
export const SAMPLE_BJT_AMP = `* BJT common-emitter amplifier
VCC vcc 0 DC 12
VIN in 0 DC 1.5 AC 1
R1 vcc base 100k
R2 base 0 10k
RC vcc out 5k
RE emit 0 1k
Q1 out base emit 0 NPN
C1 in base 10u
C2 out load 10u
RL load 0 10k
.MODEL NPN NPN (BF=200 IS=1e-14 VAF=100)
.op
.end
`;

/**
 * Your actual LMV341 netlist from mmo-chip, adapted for @spice-ts parsing:
 *   - Unwrapped from .SUBCKT (spice-ts SchematicView renders top-level only)
 *   - Inline .PARAM resolved: Rp=25 → R=47.5, 2160, 1500
 *   - Added .MODEL stubs for custom models
 *   - Resistor lines use plain values (no model name between pins and value)
 */
export const SAMPLE_LMV341 = `* LMV341 analog netlist (from mmo-chip, adapted for spice-ts)
VDD VDD 0 DC 5
VSS GND 0 DC 0

M1 Net_54 in1 Net_21 VDD PMOS W=48.538u L=4.883u
Q1 Net_67 Net_58 Net_67 NPN_GEN
Q2 Net_62 net2021 Net_61 NPN_GEN
D1 inp VDD_1 D_GEN
M2 Net_76 net2041 net2042 net2043 PMOS W=48.251u L=4.595u
M3 net2050 inp net2052 GND NMOS W=60.314u L=12.063u
M4 Net_41 Net_40 Net_37 GND NMOS W=60.314u L=12.063u
M5 Net_44 Net_43 Net_42 GND NMOS W=60.314u L=12.063u
M6 Net_47 Net_46 Net_45 GND NMOS W=60.314u L=12.063u
M7 out1__2_ net2091 net2092 GND NMOS W=60.314u L=12.063u
M8 out1__2_ net2101 net2102 GND NMOS W=60.314u L=12.063u
M9 net2110 net2111 net2112 GND NMOS W=60.314u L=12.063u
M10 Net_78 Net_78 net2122 GND NMOS W=60.314u L=12.063u
M11 net2130 VDD_1 net2132 GND NMOS W=60.026u L=1.723u
M12 Net_38 Net_49 Net_39 GND NMOS W=60.026u L=1.723u
M13 in1 Net_48 net2152 GND NMOS W=60.026u L=1.723u
M14 Net_79 net2161 net2162 VDD PMOS W=24.413u L=6.606u
M15 Net_54 net2171 Net_79 net2173 NMOS W=24.413u L=6.031u
M16 Net_60 net2181 net2182 Net_60 PMOS W=47.102u L=12.350u m=2
M17 net2190 Net_59 Net_60 Net_60 PMOS W=47.102u L=12.350u m=2
M18 net2200 net2201 net2202 net2203 PMOS W=47.102u L=12.350u m=2
M19 net2210 net2211 net2200 net2203 PMOS W=47.102u L=12.350u m=2
M20 Net_63 Net_64 net2222 GND NMOS W=45.379u L=11.776u
M21 net2230 Net_65 net2232 GND NMOS W=45.379u L=11.776u
M22 Net_69 net2241 net2242 GND NMOS W=45.379u L=11.776u
M23 net2250 net2251 net2252 GND NMOS W=45.379u L=11.776u
M24 net2260 net2261 Net_66 GND NMOS W=45.379u L=11.776u
M25 Net_69 Net_70 net2272 GND NMOS W=45.379u L=11.776u
M26 net2280 Net_70 net2282 GND NMOS W=45.379u L=11.776u
M27 Net_72 Net_71 net2292 GND NMOS W=45.379u L=11.776u
M28 Net_73 net2301 net2302 GND NMOS W=45.379u L=11.776u
M29 Net_73 net2311 net2312 GND NMOS W=45.379u L=11.776u
M30 net2320 Net_73 net2322 GND NMOS W=45.379u L=11.776u
M31 net2330 net2331 net2332 GND NMOS W=45.379u L=11.776u
M32 net2340 net2341 net2342 VDD PMOS W=47.389u L=3.734u
M33 net2350 net2351 net2352 VDD PMOS W=47.389u L=3.159u
M34 Net_77 net2361 net2362 VDD PMOS W=47.676u L=3.159u
M35 net2370 net2371 Net_80 VDD PMOS W=47.964u L=2.872u
M36 Net_80 net2381 Net_68 VDD PMOS W=47.389u L=2.585u
M37 net2390 Net_75 Net_74 VDD PMOS W=48.251u L=12.924u m=2
M38 Net_74 Net_75 net2390 VDD PMOS W=48.251u L=12.924u m=2
R1 net2410 net2411 47.5
R2 net2420 net2421 2160
R3 net2430 net2431 1500

.MODEL PMOS PMOS (VTO=-0.7 KP=40u LAMBDA=0.02)
.MODEL NMOS NMOS (VTO=0.7 KP=120u LAMBDA=0.01)
.MODEL NPN_GEN NPN (BF=200 IS=1e-14 VAF=100)
.MODEL D_GEN D (IS=1e-14 BV=50)

.op
.end
`;
