import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import type { Cell, CellType, DieMetadata } from "shared";
import { cellFootprint } from "../../lib/cellDetection";
import { dieRegion } from "../../renderer/dieRegion";
import { THUMB_PREVIEW_PX, THUMB_PX, withCropPx } from "../../lib/progressiveImage";

interface ImageProps {
  /** Crop URL (cellCropUrl); the pyramid size is added here. */
  src: string;
  /** Size / border / radius of the thumbnail box. */
  style?: CSSProperties;
  /** Extra overlays drawn on top (e.g. the "merged" check). */
  children?: ReactNode;
}

interface CanvasProps {
  /** The die's tile pyramid the cell's pixels are drawn from. */
  die: DieMetadata | null;
  cell: Cell;
  cellType: CellType;
}

type CellThumbProps = ImageProps | CanvasProps;

/**
 * Cell miniature, either from a per-cell crop URL (progressive: a tiny preview
 * paints almost at once, then a sharper one replaces it) or drawn directly
 * from the die's tile pyramid at the size the box needs.
 */
export function CellThumb(props: CellThumbProps) {
  if ("src" in props) return <CropThumb {...props} />;
  return <CanvasThumb {...props} />;
}

function CropThumb({ src, style, children }: ImageProps) {
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

/**
 * A cell's die pixels as a thumbnail filling its box (like `object-fit:
 * cover`), as they lie on the die — drawn from the die's tile pyramid at the
 * level the thumbnail's size needs, rather than from a per-cell crop. Only
 * draws once scrolled into view, so a long candidate list pulls just the
 * tiles it shows.
 */
function CanvasThumb({ die, cell, cellType }: CanvasProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [seen, setSeen] = useState(false);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !seen || !die) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const fp = cellFootprint(cell, cellType);
    if (!width || !height || fp.width <= 0 || fp.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Cover: CSS px per die px. The level follows CSS px (as the die viewer
    // does) — a thumbnail doesn't need retina-sharp tiles.
    const scale = Math.max(width / fp.width, height / fp.height);
    const region = dieRegion(die, fp, scale, () => {
      if (alive.current) redraw();
    });
    if (!region) return;
    const k = scale * dpr;
    ctx.setTransform(
      k,
      0,
      0,
      k,
      canvas.width / 2 - (fp.x + fp.width / 2) * k,
      canvas.height / 2 - (fp.y + fp.height / 2) * k
    );
    const r = region.rect;
    ctx.drawImage(region.canvas, r.x, r.y, r.width, r.height);
  });

  return <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} />;
}
