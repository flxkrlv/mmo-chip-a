import type { OverlayLayerEntry } from "../state/overlayLayers";

/** Response from GET /api/overlay-images/list. */
interface OverlayImagesListResponse {
  images: { name: string; size: number }[];
}

/**
 * Fetch the list of available overlay images from the backend.
 */
export async function fetchOverlayImageList(): Promise<OverlayImagesListResponse> {
  const res = await fetch("/api/overlay-images/list");
  if (!res.ok) throw new Error(`Failed to fetch overlay image list: ${res.statusText}`);
  return res.json();
}

/**
 * Load an overlay image from the backend and return a loaded HTMLImageElement.
 * Also returns the original filename (minus extension) for use as a layer name.
 */
export function loadOverlayImageFromServer(filename: string): Promise<{ image: HTMLImageElement; name: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const name = filename.replace(/\.[^.]+$/, "");
      resolve({ image: img, name });
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${filename}`));
    img.src = `/api/overlay-images/${encodeURIComponent(filename)}`;
  });
}

/**
 * Load an overlay image from a File object (via file input).
 */
export function loadOverlayImageFromFile(file: File): Promise<{ image: HTMLImageElement; name: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const name = file.name.replace(/\.[^.]+$/, "");
      resolve({ image: img, name });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to load image: ${file.name}`));
    };
    img.src = url;
  });
}
