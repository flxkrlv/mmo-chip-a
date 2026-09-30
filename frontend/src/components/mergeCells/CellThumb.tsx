import { useState, type CSSProperties, type ReactNode } from "react";
import { THUMB_PREVIEW_PX, THUMB_PX, withCropPx } from "../../lib/progressiveImage";

/**
 * Cell crop miniature. Loads progressively from the tile pyramid: a tiny
 * preview paints almost at once, then a sharper one (still far below full
 * resolution — thumbs are ~84px) replaces it. Until the first stage arrives
 * the slot shows a pulsing placeholder + spinner; a failed crop says so.
 */
export function CellThumb({
  src,
  style,
  children
}: {
  /** Crop URL (cellCropUrl); the pyramid size is added here. */
  src: string;
  /** Size / border / radius of the thumbnail box. */
  style?: CSSProperties;
  /** Extra overlays drawn on top (e.g. the "merged" check). */
  children?: ReactNode;
}) {
  // Keyed on `src` so a new crop (other cell, realigned, resized) restarts
  // the loading state instead of showing the previous image's status.
  return (
    <div className="cell-thumb" style={style}>
      <ThumbImage key={src} src={src} />
      {children}
    </div>
  );
}

function ThumbImage({ src }: { src: string }) {
  const previewSrc = withCropPx(src, THUMB_PREVIEW_PX);
  const sharpSrc = withCropPx(src, THUMB_PX);
  const [stage, setStage] = useState<"none" | "preview" | "sharp">("none");
  // Stage 2 starts once stage 1 settled (loaded or failed). Stage 1 is the
  // lazy one, so off-screen thumbs request nothing.
  const [previewSettled, setPreviewSettled] = useState(false);
  const [sharpFailed, setSharpFailed] = useState(false);
  const failed = sharpFailed && stage === "none";
  return (
    <>
      {stage !== "sharp" && (
        <img
          src={previewSrc}
          alt=""
          loading="lazy"
          onLoad={() => {
            setStage((s) => (s === "none" ? "preview" : s));
            setPreviewSettled(true);
          }}
          onError={() => setPreviewSettled(true)}
          className={stage === "preview" ? "cell-thumb-img loaded" : "cell-thumb-img"}
        />
      )}
      {previewSettled && !sharpFailed && (
        <img
          src={sharpSrc}
          alt=""
          onLoad={() => setStage("sharp")}
          onError={() => setSharpFailed(true)}
          className={stage === "sharp" ? "cell-thumb-img loaded" : "cell-thumb-img"}
        />
      )}
      {stage === "none" && !failed && (
        <div className="cell-thumb-status loading" aria-label="Loading image">
          <span className="cell-thumb-spinner" />
        </div>
      )}
      {failed && (
        <div className="cell-thumb-status" title="Image could not be loaded">
          no image
        </div>
      )}
    </>
  );
}
