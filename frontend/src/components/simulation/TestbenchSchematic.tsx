/**
 * TestbenchSchematic.tsx — the testbench drawn with the app's own schematic
 * engine.
 *
 * The DUT appears as one rectangle with its pins; the supply sources and the
 * loads the testbench connects to it are drawn around it. The picture is
 * produced by `parseTestbenchNetlist` and rendered by
 * `InteractiveAnalogSchematic` — the same canvas renderer the Netlist tab
 * uses — so the wires are routed to the real pin anchors by ELK instead of
 * being drawn by hand, and the layout can be dragged around.
 */

import { useMemo } from "react";
import { InteractiveAnalogSchematic } from "../netlist/InteractiveAnalogSchematic";
import { scopeKey as interactiveScopeKey } from "../../state/interactiveSchematic";
import { parseTestbenchNetlist } from "../../lib/schematic/testbench";

type Props = {
  /** The netlist that gets simulated (DUT + testbench). */
  netlist: string;
  dieId: string;
  moduleName: string;
  /** Power net names for the VDD/GND symbols. */
  vdd?: string;
  gnd?: string;
};

export function TestbenchSchematic({ netlist, dieId, moduleName, vdd, gnd }: Props) {
  const tb = useMemo(
    () => parseTestbenchNetlist(netlist, { vdd, gnd }),
    [netlist, vdd, gnd],
  );

  if (!tb.ok) {
    return (
      <div style={{ padding: 16, color: "var(--ink3)", fontSize: 11, lineHeight: 1.5 }}>
        {tb.message ?? "Nothing to draw in this netlist."}
        <div style={{ fontSize: 10, marginTop: 6, opacity: 0.8 }}>
          A testbench picture needs the DUT instantiated next to its sources and loads,
          e.g. <code>X1 OUT VCC 0 ref &lt;subckt&gt;</code>.
        </div>
      </div>
    );
  }

  return (
    <InteractiveAnalogSchematic
      devices={tb.devices}
      namedNets={tb.namedNets}
      scopeKey={interactiveScopeKey(dieId, moduleName, "testbench")}
      vdd={tb.vdd ?? "VDD"}
      gnd={tb.gnd ?? "0"}
      blocks={tb.blocks}
      layoutDirection="RIGHT"
    />
  );
}
