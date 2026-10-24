/**
 * Layer purpose resolution for overlay images.
 *
 * An overlay's stored `purpose` is the user's explicit choice. When it is not
 * set, the UI/agent still gets a *suggested* purpose from the layer name
 * (`sirtl` → diffusion, `me1` → metal1, …). The resolver keeps the two apart:
 * `source` says whether the effective value is `user`, `auto` or `none`, so an
 * agent can tell "explicitly diffusion" from "guessed from the name".
 */

export const LAYER_PURPOSE_OPTIONS = [
  "diffusion",
  "poly",
  "active",
  "nwell",
  "pwell",
  "implant",
  "metal1",
  "metal2",
  "metal3",
  "metal4",
  "metal5",
  "metal6",
  "via",
  "passivation",
  "other"
] as const;

export type LayerPurpose = (typeof LAYER_PURPOSE_OPTIONS)[number] | string;

export interface LayerPurposeResolution {
  /** Effective purpose, or null when neither the user nor the name gives one. */
  purpose: string | null;
  /** Where `purpose` came from. */
  source: "user" | "auto" | "none";
  /** Auto-detected candidate even when the user set an explicit value. */
  suggested: string | null;
  /** The explicit user value (`null` when unset; the string `"none"` forces none). */
  explicit: string | null;
}

/** Name-only heuristic. Returns null when the name is not recognised. */
export function autoLayerPurpose(name: string): string | null {
  const compact = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  if (!compact) return null;

  // Developed silicon / diffusion. `sirtl` is the usual name in this app.
  if (
    compact.includes("sirtl") ||
    compact.includes("diffusion") ||
    compact.includes("diffused") ||
    compact === "si" ||
    compact.includes("silicon") ||
    compact === "hf"
  ) {
    return "diffusion";
  }

  // me1, metal1, metal-1, m1 …
  const metal = /^(?:me|metal|m)([1-6])$/.exec(compact);
  if (metal) return `metal${metal[1]}`;

  // via12, via1, v12, v1 …
  if (/^(?:via|v)(?:[1-6]){0,2}$/.test(compact)) return "via";

  if (/poly|polysi|polysilicon|gate/.test(compact)) return "poly";
  if (/nwell|nwell/.test(compact)) return "nwell";
  if (/pwell|pwell/.test(compact)) return "pwell";
  if (/implant|implanted/.test(compact)) return "implant";
  if (/passiv|protective|scratch/.test(compact)) return "passivation";
  if (/^(?:active|od|aa)$/.test(compact)) return "active";

  return null;
}

/**
 * Resolve the stored explicit value + the layer name into the effective
 * purpose. `"none"` is a user choice that suppresses auto-detection; `null` /
 * `undefined` means "not set, try the name".
 */
export function resolveLayerPurpose(
  explicit: string | null | undefined,
  name: string
): LayerPurposeResolution {
  const suggested = autoLayerPurpose(name);
  const raw = typeof explicit === "string" ? explicit.trim() : "";
  if (raw) {
    if (raw.toLowerCase() === "none") {
      return { purpose: null, source: "user", suggested, explicit: "none" };
    }
    return { purpose: raw, source: "user", suggested, explicit: raw };
  }
  return suggested
    ? { purpose: suggested, source: "auto", suggested, explicit: null }
    : { purpose: null, source: "none", suggested: null, explicit: null };
}
