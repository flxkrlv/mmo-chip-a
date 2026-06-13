/**
 * React hook around the per-cell structural extractor.
 *
 *   cellType  ──extractCell──▶ CellExtraction (nets, transistors, domains, …)
 *
 * Pure compute: no network, no React Query. We memoise on the `cellType`
 * reference because the action dispatcher returns a fresh `CellType` object on
 * every annotation edit, so identity-equality is the right invalidation key.
 *
 * Clipper2 is WASM — `loadClipper()` is awaited once at mount. While that
 * load is in flight the hook reports `loading: true`. On load failure the
 * error is surfaced so the panel can show a useful message instead of an
 * empty list.
 */

import { useEffect, useMemo, useState } from "react";
import type { CellType } from "shared";
import type { LayerShape } from "shared";
import {
  extractCell,
  loadClipper,
  type CellExtraction,
  type InferredCellExtraction,
} from "../lib/extraction";
import { extractMarkedDevices } from "../lib/extraction/simpleAnalog";

interface UseCellExtraction {
  data: CellExtraction | null;
  loading: boolean;
  /** Set when Clipper itself failed to load — `extractCell` failures fall
   *  through to `data: null` (logged to the console for now). */
  error: string | null;
}

export function useCellExtraction(
  cellType: CellType | null,
): UseCellExtraction {
  const [clipperReady, setClipperReady] = useState<boolean>(false);
  const [clipperError, setClipperError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadClipper()
      .then(() => {
        if (!cancelled) setClipperReady(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setClipperError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const data = useMemo<CellExtraction | null>(() => {
    if (!cellType || !clipperReady) return null;
    try {
      const extraction = extractCell(cellType);

      // ── Analog device detection (Phase 1) ────────────────────
      // Uses marker-based detection (npn_id/pnp_id/res_id/cap_id/diode_id
      // markers + terminal layers: collector/base/emitter for BJT,
      // drain/gate/source/bulk for MOS). This matches what users draw
      // in the Cell RE panel and is simpler than full geometry detection.
      if (extraction.kind === "inferred") {
        const inf = extraction as InferredCellExtraction;
        try {
          const analogDevices = extractMarkedDevices(
            cellType.layers,
            cellType.id,
            1.0, // umPerPx — Cell RE doesn't have per-die scale
          );
          return { ...inf, analogDevices } as InferredCellExtraction;
        } catch (ae) {
          console.warn("extractMarkedDevices warning:", ae);
          return extraction;
        }
      }

      return extraction;
    } catch (e) {
      // The pipeline shouldn't throw on a well-formed cell — pre-flight
      // validation catches the obvious issues. If we land here, something
      // unexpected went wrong; log it but don't crash the panel.
      console.error("extractCell failed for", cellType.id, e);
      return null;
    }
  }, [cellType, clipperReady]);

  return {
    data,
    loading: !clipperReady && !clipperError,
    error: clipperError,
  };
}
