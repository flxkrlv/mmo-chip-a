// ── Progressive cell crops ───────────────────────────────────────────
//
// A full-resolution crop of a big die can take seconds on a cold cache (the
// server may have to decode the original). The crop endpoints also accept
// `px=N`: the coarsest tile-pyramid level whose long side is still >= N px,
// assembled from already-built tiles in milliseconds. Callers show that
// preview at once and swap in the sharper image when it arrives; both are
// drawn stretched to the cell box, so the swap is only a gain in detail.

/** Preview size for the Merge / RE canvases (long side, px). */
export const CANVAS_PREVIEW_PX = 256;
/** Thumbnail sizes: a tiny first paint, then one sharp enough for ~84px thumbs on HiDPI. */
export const THUMB_PREVIEW_PX = 48;
export const THUMB_PX = 192;

/** `url` asking for a pyramid preview whose long side is >= `px`. */
export function withCropPx(url: string, px: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}px=${px}`;
}

interface Entry {
  preview: HTMLImageElement;
  full: HTMLImageElement | null;
}

function ready(img: HTMLImageElement | null): img is HTMLImageElement {
  return !!img && img.complete && img.naturalWidth > 0;
}

/**
 * Canvas image cache that loads each crop as preview → full resolution.
 * `get(url)` returns the best image loaded so far (or null) and kicks off
 * loading on first sight; `onChange` fires whenever a stage finishes, so the
 * canvas redraws with the sharper image.
 *
 * The full image is requested only once the preview settled, so previews of
 * everything on screen are served first instead of queueing behind slow
 * full-resolution crops.
 */
export function createProgressiveImageCache(
  onChange: () => void,
  previewPx: number = CANVAS_PREVIEW_PX
) {
  const cache = new Map<string, Entry>();

  const load = (src: string, done: () => void) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = done;
    img.onerror = done;
    img.src = src;
    return img;
  };

  return (url: string | null): HTMLImageElement | null => {
    if (!url) return null;
    const hit = cache.get(url);
    if (hit) {
      if (ready(hit.full)) return hit.full;
      return ready(hit.preview) ? hit.preview : null;
    }
    const entry: Entry = { preview: null as unknown as HTMLImageElement, full: null };
    entry.preview = load(withCropPx(url, previewPx), () => {
      onChange();
      if (!entry.full) entry.full = load(url, onChange);
    });
    cache.set(url, entry);
    return null;
  };
}
