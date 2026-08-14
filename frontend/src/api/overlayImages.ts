import { apiGet, apiUpload } from "./client";

export interface OverlayTileLevel {
  z: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  scale: number;
}

/** A server-side tiled source. `legacy` is only used for old static files. */
export interface OverlayImageSource {
  id: string;
  name: string;
  originalFilename: string;
  size: number;
  width: number;
  height: number;
  tileSize: number;
  tileFormat: "jpg" | "png";
  hasAlpha: boolean;
  maxZoomLevel: number;
  levels: OverlayTileLevel[];
  ready: boolean;
  createdAt: string;
  updatedAt: string;
  legacy?: boolean;
}

interface OverlayImagesListResponse {
  images: OverlayImageSource[];
}

export async function fetchOverlayImageList(dieId: string): Promise<OverlayImagesListResponse> {
  return apiGet<OverlayImagesListResponse>(
    `/api/dies/${encodeURIComponent(dieId)}/overlay-images/list`
  );
}

export async function uploadOverlayImage(
  dieId: string,
  file: File
): Promise<{ image: OverlayImageSource }> {
  const form = new FormData();
  form.append("file", file);
  return apiUpload<{ image: OverlayImageSource }>(
    `/api/dies/${encodeURIComponent(dieId)}/overlay-images/upload`,
    form
  );
}

/** Legacy-only loader. New manifest-backed sources must never decode the original in the browser. */
export function loadOverlayImageFromServer(
  dieId: string,
  filename: string
): Promise<{ image: HTMLImageElement; name: string; serverFilename: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve({
      image: img,
      name: filename.replace(/\.[^.]+$/, ""),
      serverFilename: filename
    });
    img.onerror = () => reject(new Error(`Failed to load image: ${filename}`));
    img.src = `/api/dies/${encodeURIComponent(dieId)}/overlay-images/${encodeURIComponent(filename)}`;
  });
}

export function loadOverlayImageFromFile(file: File): Promise<{ image: HTMLImageElement; name: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ image: img, name: file.name.replace(/\.[^.]+$/, "") });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Failed to load image: ${file.name}`)); };
    img.src = url;
  });
}