/**
 * spectreToNgspice.ts — Convert Spectre-format netlist to valid ngspice SPICE.
 *
 * The extraction pipeline generates Spectre syntax by default:
 *   Q10 (Net_35 Net_35 GND 0) npn m=1.23
 *   R8 (ref Net_29) resistor r=4858
 *   D1 (Net_94 Net_95) diode
 *   .subckt bandgap (GND_1 net230 ref VCC GND)
 *
 * ngspice needs standard SPICE/CDL format:
 *   Q10 Net_35 Net_35 GND 0 npn m=1.23
 *   R8 ref Net_29 4858
 *   D1 Net_94 Net_95 d_model
 *   .subckt bandgap GND_1 net230 ref VCC GND
 *
 * The conversion itself lives in `shared/spiceNetlist` so the backend SPICE
 * agent tool and this frontend converter cannot drift apart.
 *
 * This module also generates default .model cards for device types found in
 * the netlist, so the simulation can run without external model libraries.
 */

import { convertNetlistToNgspice } from "shared/spiceNetlist";
import { extractModelCards as extractModelCardsShared } from "shared/spiceModels";

/**
 * Convert a Spectre netlist to valid ngspice SPICE format.
 *
 * Handles:
 *   - Parenthesized terminal lists → positional
 *   - Type keywords (resistor/capacitor/inductor) → stripped
 *   - keyword=value params → positional for passives
 *   - Arithmetic values ("16.8*250") → evaluated to a number
 *   - .subckt/.ends parentheses stripped
 *   - Backslash escapes stripped
 *   - Default .model cards injected for device types found
 *   - A title line is added when the netlist starts with a directive
 *
 * @param spectreNetlist — raw Spectre-format netlist
 * @param extraDirectives — user directives to append (sources, analysis, etc.)
 * @returns valid ngspice netlist with .model cards
 */
export function spectreToNgspice(
  spectreNetlist: string,
  extraDirectives?: string,
): string {
  const { netlist } = convertNetlistToNgspice(spectreNetlist);

  if (!extraDirectives) return netlist;
  return `${netlist}\n\n${extraDirectives}`;
}

/**
 * Extract all .MODEL lines from a netlist string.
 * Used to include model cards when simulating a subcircuit subset.
 *
 * @deprecated Use `extractModelCards` from `shared/spiceModels` — it returns
 * the cards keyed by model name and is the single source of truth.
 */
export function extractModelCards(netlist: string): string[] {
  return Object.values(extractModelCardsShared(netlist));
}
