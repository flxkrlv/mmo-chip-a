import { useState, type CSSProperties, type ReactNode } from "react";

/**
 * Cell crop miniature with a visible loading state. Cold crops are rendered
 * server-side on first request, so the image can take a moment: until it
 * arrives the slot shows a pulsing placeholder + spinner instead of a flat
 * black box, and a failed crop says so.
 */
export function CellThumb({
  src,
  style,
  children
}: {
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
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  return (
    <>
      <img
        src={src}
        alt=""
        loading="lazy"
        onLoad={() => setState("loaded")}
        onError={() => setState("error")}
        className={state === "loaded" ? "cell-thumb-img loaded" : "cell-thumb-img"}
      />
      {state === "loading" && (
        <div className="cell-thumb-status loading" aria-label="Loading image">
          <span className="cell-thumb-spinner" />
        </div>
      )}
      {state === "error" && (
        <div className="cell-thumb-status" title="Image could not be loaded">
          no image
        </div>
      )}
    </>
  );
}
