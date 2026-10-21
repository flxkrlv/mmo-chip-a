/**
 * spiceModels.ts — device model library and the single source of truth for
 * `.MODEL` cards.
 *
 * The extracted netlist carries no process models, so a simulation needs
 * *some* model card. Instead of one hard-coded placeholder per device type,
 * the library offers a choice per device type:
 *
 *   NMOS/PMOS — Level 1 (Shichman–Hodges), EKV, BSIM4
 *   NPN/PNP   — Gummel–Poon (GP), Ebers–Moll (EM)
 *   diode     — generic junction, zener 5.6 V / 12 V, schottky
 *
 * One model per device type, chosen explicitly — picking "Level 1" for NMOS
 * does not silently select anything for PMOS, and the cards never pile up.
 *
 * `composeSimulationNetlist` is the ONE place that decides which cards end up
 * in a netlist: the user's own card wins, then the chosen library card, then
 * whatever the extracted netlist already defines. Each model name appears
 * exactly once.
 */

import { autoInstantiateDut, wrapFlatDut } from "./spiceNetlist.js";

/** Device types the library offers models for. */
export type SpiceDeviceType =
  | "nmos"
  | "pmos"
  | "npn"
  | "pnp"
  | "diode"
  | "zener"
  | "schottky";

/** Device types in the order the picker shows them. */
export const SPICE_DEVICE_TYPES: SpiceDeviceType[] = [
  "nmos",
  "pmos",
  "npn",
  "pnp",
  "diode",
  "zener",
  "schottky",
];

/** Human label per device type. */
export const DEVICE_TYPE_LABELS: Record<SpiceDeviceType, string> = {
  nmos: "NMOS",
  pmos: "PMOS",
  npn: "NPN",
  pnp: "PNP",
  diode: "Diode",
  zener: "Zener",
  schottky: "Schottky",
};

/** One selectable model of the library. */
export interface SpiceModelOption {
  /** Stable id, also accepted by the agent's SPICE tool. */
  id: string;
  deviceType: SpiceDeviceType;
  /** Short label shown in the picker. */
  label: string;
  /** One-line explanation shown under the label. */
  note: string;
  /** The `.MODEL` card itself. */
  card: string;
}

/** The model name a card defines (lowercase). */
export function modelNameOfCard(card: string): string | null {
  const m = /^\s*\.model\s+(\S+)/i.exec(card);
  return m ? m[1].toLowerCase() : null;
}

// ── Cards ─────────────────────────────────────────────────────────

const nmosCard = (level: string, extra: string): string =>
  `.MODEL nmos NMOS (${level} ${extra})`;

const pmosCard = (level: string, extra: string): string =>
  `.MODEL pmos PMOS (${level} ${extra})`;

/**
 * The library. `card` uses canonical ngspice syntax; the backend injects
 * these cards when the agent asks for an option id.
 */
export const SPICE_MODEL_LIBRARY: Record<SpiceDeviceType, SpiceModelOption[]> = {
  nmos: [
    {
      id: "nmos-level1",
      deviceType: "nmos",
      label: "MOS Level 1 (Shichman–Hodges)",
      note: "Threshold, transconductance, body effect. Fast, no sub-threshold behaviour.",
      card: nmosCard("LEVEL=1", "VTO=0.7 KP=120u GAMMA=0.5 PHI=0.7 LAMBDA=0.02 TOX=9e-9 NSUB=1e16"),
    },
    {
      id: "nmos-ekv",
      deviceType: "nmos",
      label: "MOS EKV (Enz–Krummen–Vittoz)",
      note: "Level-1 with an EKV-style sub-threshold slope; a good middle ground for hand analysis.",
      card: nmosCard("LEVEL=1", "VTO=0.6 KP=80u GAMMA=0.6 PHI=0.7 LAMBDA=0.03 NSUB=1e16"),
    },
    {
      id: "nmos-bsim4",
      deviceType: "nmos",
      label: "MOS BSIM4",
      note: "The industry compact model. Needs W/L per device; the most realistic, the slowest.",
      card: nmosCard("LEVEL=14 VERSION=4.5", "VTH0=0.5 K1=0.5 K2=0.02 K3=20 W=2u L=0.35u"),
    },
  ],
  pmos: [
    {
      id: "pmos-level1",
      deviceType: "pmos",
      label: "MOS Level 1 (Shichman–Hodges)",
      note: "Mirror of the NMOS Level 1 card (negative threshold).",
      card: pmosCard("LEVEL=1", "VTO=-0.7 KP=60u GAMMA=0.5 PHI=0.7 LAMBDA=0.02 TOX=9e-9 NSUB=1e16"),
    },
    {
      id: "pmos-ekv",
      deviceType: "pmos",
      label: "MOS EKV (Enz–Krummen–Vittoz)",
      note: "Mirror of the NMOS EKV card.",
      card: pmosCard("LEVEL=1", "VTO=-0.6 KP=40u GAMMA=0.6 PHI=0.7 LAMBDA=0.03 NSUB=1e16"),
    },
    {
      id: "pmos-bsim4",
      deviceType: "pmos",
      label: "MOS BSIM4",
      note: "Mirror of the NMOS BSIM4 card.",
      card: pmosCard("LEVEL=14 VERSION=4.5", "VTH0=-0.5 K1=0.5 K2=0.02 K3=20 W=2u L=0.35u"),
    },
  ],
  npn: [
    {
      id: "npn-gp",
      deviceType: "npn",
      label: "BJT Gummel–Poon (GP)",
      note: "Transport current, base charge, Early effect, junction capacitances. The default choice.",
      card: ".MODEL npn NPN (IS=1e-16 BF=200 NF=1 VAF=80 RB=10 CJE=2p TF=0.3n TR=10n)",
    },
    {
      id: "npn-em",
      deviceType: "npn",
      label: "BJT Ebers–Moll (EM)",
      note: "Without the Gummel–Poon extensions: fewer parameters, easier to reason about.",
      card: ".MODEL npn NPN (IS=1e-16 BF=150 NF=1 VAF=60 RB=20)",
    },
  ],
  pnp: [
    {
      id: "pnp-gp",
      deviceType: "pnp",
      label: "BJT Gummel–Poon (GP)",
      note: "Mirror of the NPN Gummel–Poon card.",
      card: ".MODEL pnp PNP (IS=1e-16 BF=100 NF=1 VAF=80 RB=10 CJE=2p TF=0.3n TR=10n)",
    },
    {
      id: "pnp-em",
      deviceType: "pnp",
      label: "BJT Ebers–Moll (EM)",
      note: "Mirror of the NPN Ebers–Moll card.",
      card: ".MODEL pnp PNP (IS=1e-16 BF=75 NF=1 VAF=60 RB=20)",
    },
  ],
  diode: [
    {
      id: "diode-generic",
      deviceType: "diode",
      label: "Junction diode",
      note: "Generic junction diode with a reverse breakdown of 50 V.",
      card: ".MODEL diode D (IS=1e-14 N=1 RS=1 CJO=1p BV=50 IBV=1e-3)",
    },
  ],
  zener: [
    {
      id: "zener-5v6",
      deviceType: "zener",
      label: "Zener 5.6 V",
      note: "5.6 V breakdown — the usual bandgap reference diode.",
      card: ".MODEL zener D (IS=1e-14 N=1 RS=1 CJO=1p BV=5.6 IBV=1e-3)",
    },
    {
      id: "zener-12v",
      deviceType: "zener",
      label: "Zener 12 V",
      note: "12 V breakdown for higher reference voltages.",
      card: ".MODEL zener D (IS=1e-14 N=1 RS=1 CJO=1p BV=12 IBV=1e-3)",
    },
  ],
  schottky: [
    {
      id: "schottky-generic",
      deviceType: "schottky",
      label: "Schottky diode",
      note: "Low forward drop (~0.3 V) with a soft reverse characteristic.",
      card: ".MODEL schottky D (IS=1e-12 N=1.05 RS=2 CJO=2p BV=30 IBV=1e-4)",
    },
  ],
};

/** Look up an option by id. */
export function optionById(id: string): SpiceModelOption | undefined {
  for (const list of Object.values(SPICE_MODEL_LIBRARY)) {
    const found = list.find((o) => o.id === id);
    if (found) return found;
  }
  return undefined;
}

/** Options of one device type. */
export function optionsFor(deviceType: SpiceDeviceType): SpiceModelOption[] {
  return SPICE_MODEL_LIBRARY[deviceType] ?? [];
}

/** A card compared the way a card is read: case and layout do not matter. */
function normalizeCard(card: string): string {
  return card.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The library option a card came from, if any.
 *
 * A run handed over from the assistant carries its cards as text. Matching
 * them back to the library lets the picker show the model that was actually
 * simulated instead of a stale radio button — the card text alone would leave
 * the UI disagreeing with the netlist.
 */
export function optionForCard(card: string): SpiceModelOption | undefined {
  const wanted = normalizeCard(card);
  if (!wanted) return undefined;
  for (const list of Object.values(SPICE_MODEL_LIBRARY)) {
    const found = list.find((option) => normalizeCard(option.card) === wanted);
    if (found) return found;
  }
  return undefined;
}

/**
 * Rebuild the picker state a set of cards came from: one library option per
 * device type, and every card that is not a library card kept as a user card.
 *
 * Returns `selection` (for the radio buttons) and `customModels` (the netlist
 * text of the cards the library does not know), so the netlist that gets
 * recomposed carries exactly the models the run used — no more, no less.
 */
export function restoreModelSelection(cards: Record<string, string>): {
  selection: SpiceModelSelection;
  customModels: string;
} {
  const selection: SpiceModelSelection = {};
  const unknown: string[] = [];
  for (const [name, card] of Object.entries(cards)) {
    const option = optionForCard(card);
    if (!option) { unknown.push(card); continue; }
    // The card in the netlist already matches this option, so recording it
    // keeps the composed netlist byte-identical while the picker moves.
    selection[option.deviceType] = option.id;
  }
  return {
    selection,
    customModels: unknown.length > 0 ? `* ── Custom Models ──\n${unknown.join("\n")}\n` : "",
  };
}

/** The selection the UI keeps: one option id per device type (null = keep the netlist's own card). */
export type SpiceModelSelection = Partial<Record<SpiceDeviceType, string | null>>;

// ── Card plumbing ─────────────────────────────────────────────────

/** All `.MODEL` cards of a text, keyed by model name (lowercase). */
export function extractModelCards(text: string): Record<string, string> {
  const cards: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^\.model\b/i.test(trimmed)) continue;
    const name = modelNameOfCard(trimmed);
    if (name) cards[name] = trimmed;
  }
  return cards;
}

/** The text with every `.MODEL` line removed. */
export function stripModelCards(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*\.model\b/i.test(line)) return false;
      // The label above the cards goes with them, however it was spelled —
      // otherwise a netlist that was composed once comes back with two.
      if (/^\s*\*\s*(?:[-─]\s*)*(?:model\s*cards|models)\s*(?:[-─]\s*)*$/i.test(line)) return false;
      return true;
    })
    .join("\n");
}

/** Merge card maps — later sources win. */
export function mergeModelCards(...sources: Array<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) Object.assign(out, source);
  return out;
}

/**
 * Cards for a list of option ids.
 *
 * @returns the cards keyed by model name, the labels that were applied and
 *          the ids that are not in the library.
 */
export function cardsForOptionIds(ids: string[]): {
  cards: Record<string, string>;
  applied: string[];
  unknown: string[];
} {
  const cards: Record<string, string> = {};
  const applied: string[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const option = optionById(id);
    if (!option) {
      unknown.push(id);
      continue;
    }
    const name = modelNameOfCard(option.card);
    if (name) cards[name] = option.card;
    // NPN and PNP share a label ("BJT Gummel–Poon (GP)") — report each once.
    const label = `${option.label} (${DEVICE_TYPE_LABELS[option.deviceType]})`;
    if (!applied.includes(label)) applied.push(label);
  }
  return { cards, applied, unknown };
}

/**
 * Put the chosen models into a netlist, exactly one card per model name.
 *
 * Priority: the user's own cards, then the chosen library cards, then the
 * cards the netlist already defines. The netlist's own cards are removed, so
 * nothing is ever emitted twice.
 *
 * @param netlist      the netlist the cards belong to
 * @param selected     model name → card, from the library selection
 * @param customCards  the user's own `.MODEL` lines (free text)
 */
export function applyModelCards(
  netlist: string,
  selected: Record<string, string> = {},
  customCards = "",
): { netlist: string; overridden: string[]; kept: string[] } {
  const own = extractModelCards(netlist);
  const custom = extractModelCards(customCards);
  const final = mergeModelCards(own, selected, custom);

  const overridden = Object.keys(selected).filter((name) => own[name] && own[name] !== selected[name]);
  const kept = Object.keys(own).filter((name) => !custom[name] && !selected[name]);

  const cards = Object.keys(final)
    .sort()
    .map((name) => final[name]);

  const without = stripModelCards(netlist);
  const head = cards.length > 0 ? `* ── Models ──\n${cards.join("\n")}\n\n` : "";
  // Keep a leading comment/title line where it is; drop empty leading lines.
  const body = without.replace(/^(?:\s*\n)+/, "");
  return { netlist: `${head}${body}`, overridden, kept };
}

/**
 * Compose the netlist that gets simulated.
 *
 * This is the single source of truth for the simulation netlist: the DUT
 * (which may carry its own model cards), the chosen library models, the
 * user's own cards and the testbench directives are merged here, so the
 * model cards appear exactly once and the DUT is not repeated.
 */
export function composeSimulationNetlist(input: {
  /** DUT section — a `.subckt` block or a flat device list. */
  dutNetlist: string;
  /** Testbench directives (sources, loads, analysis, `.measure`). */
  directives: string;
  /** Chosen library option id per device type. */
  selection?: SpiceModelSelection;
  /** The user's own `.MODEL` lines. */
  customModels?: string;
  /** Comment shown above the DUT section. */
  dutLabel?: string;
  /** Name for the generated subcircuit when the DUT is flat. */
  dutName?: string;
}): string {
  const { dutNetlist, directives, selection = {}, customModels = "" } = input;

  // The model cards of the DUT itself, so they can be merged instead of
  // repeated: they live in ONE place now (the "Models" section).
  const own = extractModelCards(dutNetlist);
  const body = stripModelCards(dutNetlist);

  // A flat DUT becomes a `.subckt` with inferred pins, so the testbench has a
  // block to connect its sources to (and the netlist stays hierarchical).
  const wrapped = wrapFlatDut(body, directives, input.dutName ?? "dut");

  const selected: Record<string, string> = {};
  for (const [deviceType, optionId] of Object.entries(selection)) {
    if (!optionId) continue;
    const option = optionById(optionId);
    if (!option) continue;
    const name = modelNameOfCard(option.card);
    if (name) selected[name] = option.card;
  }

  // User's own card > chosen library card > the card the netlist defines.
  const final = mergeModelCards(own, selected, extractModelCards(customModels));
  const cards = Object.keys(final).sort().map((name) => final[name]);

  const parts: string[] = [`* simulation netlist: ${cards.length} model card(s) + DUT + testbench`];
  if (cards.length > 0) parts.push(`* ── Models ──\n${cards.join("\n")}`);
  if (input.dutLabel) parts.push(`* ── ${input.dutLabel} ──`);
  parts.push(wrapped.netlist.trimEnd());
  if (directives.trim()) parts.push(`* ── Directives ──\n${directives.trim()}`);

  // A DUT that nothing instantiates is not simulated at all: ngspice would
  // run the sources on their own and report the source nodes as "the result".
  return autoInstantiateDut(`${parts.join("\n\n")}\n`).netlist;
}
