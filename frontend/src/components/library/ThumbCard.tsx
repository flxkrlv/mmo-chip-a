import { useState } from "react";
import { Link } from "react-router-dom";
import type { DieSummary, ImportJob, MLInferenceJob } from "shared";
import { useDeleteDie } from "../../api/dies";
import { Menu, type MenuItemDef } from "../Menu";
import { formatPercent, formatPixels, formatTileProgress } from "../../lib/format";

function thumbnailUrl(dieId: string): string {
  return `/api/dies/${dieId}/tiles/0/0/0`;
}

type Props =
  | { kind: "die"; die: DieSummary; inferenceJob?: MLInferenceJob }
  | { kind: "importing"; job: ImportJob };

export function ThumbCard(props: Props) {
  const tileProgress = props.kind === "die" ? props.die.tileProgress : undefined;
  const importing = props.kind === "importing";
  const inferenceJob =
    props.kind === "die" ? props.inferenceJob : undefined;
  const inferenceProgress =
    inferenceJob?.status === "running" ? inferenceJob.percentage : undefined;

  const inner = (
    <>
      <Thumbnail
        key={props.kind === "die" ? `${props.die.id}:${tileProgress?.completedTiles ?? "ready"}` : props.job.id}
        kind={importing ? "importing" : tileProgress ? "tiling" : "ready"}
        progress={tileProgress?.percentage ?? (importing ? props.job.progress.percentage : undefined)}
        caption={
          importing
            ? captionForImportJob(props.job)
            : tileProgress
            ? formatTileProgress(tileProgress.completedTiles, tileProgress.totalTiles)
            : undefined
        }
        imageUrl={props.kind === "die" ? thumbnailUrl(props.die.id) : undefined}
        inferenceProgress={inferenceProgress}
      />
      <div style={{ padding: "8px 10px" }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--ink)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            minHeight: 22
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0
            }}
          >
            {props.kind === "die" ? props.die.name : props.job.originalFilename}
          </span>
          {props.kind === "die" ? (
            <DieCardActions die={props.die} />
          ) : (
            <JobStatusChip status={props.job.status} />
          )}
        </div>
        <div className="m" style={{ fontSize: 10.5, color: "var(--ink3)", marginTop: 3 }}>
          {props.kind === "die"
            ? formatPixels(props.die.width, props.die.height)
            : "preparing import…"}
        </div>
        {props.kind === "die" && tileProgress && (
          <div className="m" style={{ fontSize: 10, color: "var(--ink3)", marginTop: 2 }}>
            {formatTileProgress(tileProgress.completedTiles, tileProgress.totalTiles)} ·{" "}
            {formatPercent(tileProgress.percentage)}
          </div>
        )}
        {importing && (
          <div className="m" style={{ fontSize: 10, color: "var(--ink3)", marginTop: 2 }}>
            {props.job.progress.phase} · {formatPercent(props.job.progress.percentage)}
          </div>
        )}
      </div>
    </>
  );

  if (props.kind === "die") {
    return (
      <article className="thumb-card" style={{ position: "relative" }}>
        {inner}
        <Link
          to={`/die/${props.die.id}`}
          aria-label={`open ${props.die.name}`}
          className="thumb-card-link"
        />
      </article>
    );
  }

  return (
    <div className="thumb-card disabled" aria-disabled="true">
      {inner}
    </div>
  );
}

function DieCardActions({ die }: { die: DieSummary }) {
  const deleteMutation = useDeleteDie();
  const [pending, setPending] = useState(false);

  const items: MenuItemDef[] = [
    {
      label: pending ? "deleting…" : "Delete",
      danger: true,
      disabled: pending,
      onSelect: () => {
        if (!window.confirm(`Delete "${die.name}"? This cannot be undone.`)) return;
        setPending(true);
        deleteMutation.mutate(die.id, {
          onSettled: () => setPending(false)
        });
      }
    }
  ];

  return (
    <div className="thumb-card-actions" style={{ position: "relative", zIndex: 2 }}>
      <Menu items={items} ariaLabel={`actions for ${die.name}`} />
    </div>
  );
}

function JobStatusChip({ status }: { status: ImportJob["status"] }) {
  if (status === "queued") return <span className="chip">queued</span>;
  return <span className="chip warn">importing</span>;
}

function captionForImportJob(job: ImportJob): string | undefined {
  if (job.progress.totalTiles > 0) {
    return formatTileProgress(job.progress.processedTiles, job.progress.totalTiles);
  }
  return job.progress.message || undefined;
}

function Thumbnail({
  kind,
  progress,
  caption,
  imageUrl,
  inferenceProgress
}: {
  kind: "ready" | "tiling" | "importing";
  progress?: number;
  caption?: string;
  imageUrl?: string;
  /** 0..100 when a die-wide ML inference job is running, else undefined. */
  inferenceProgress?: number;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const showOverlay = kind !== "ready";
  const showImage = !!imageUrl && !failed;
  return (
    <div
      style={{
        height: 140,
        position: "relative",
        overflow: "hidden",
        background: "#1c1c1c",
        backgroundImage:
          "repeating-linear-gradient(135deg, #2c2c2c 0 1px, transparent 1px 6px), repeating-linear-gradient(45deg, #181818 0 1px, transparent 1px 9px)"
      }}
    >
      {/* ML inference runs in the background — a small corner badge rather
          than a full overlay, since the die is still usable meanwhile. */}
      {inferenceProgress !== undefined && (
        <div
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            gap: 5,
            background: "rgba(0,0,0,0.72)",
            color: "#fff",
            fontSize: 9.5,
            letterSpacing: 0.5,
            padding: "3px 7px",
            borderRadius: 3
          }}
          title={`ML inference ${Math.round(inferenceProgress)}%`}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--accent, #7fb2ff)"
            }}
          />
          INFERENCE {Math.round(inferenceProgress)}%
        </div>
      )}
      {showImage && (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: loaded ? 1 : 0,
            transition: "opacity 0.15s ease"
          }}
        />
      )}
      {showOverlay && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "#fff",
            padding: "0 12px",
            textAlign: "center"
          }}
        >
          <span className="m" style={{ fontSize: 10.5, letterSpacing: 0.6 }}>
            {kind === "importing" ? "IMPORTING" : "GENERATING TILES"}
            {progress !== undefined ? ` — ${Math.round(progress)}%` : ""}
          </span>
          <div style={{ width: "70%", height: 4, background: "rgba(255,255,255,0.2)" }}>
            <div
              style={{
                width: `${Math.max(0, Math.min(100, progress ?? 0))}%`,
                height: "100%",
                background: "#fff",
                transition: "width 0.3s ease"
              }}
            />
          </div>
          {caption && (
            <span className="m" style={{ fontSize: 9.5, opacity: 0.7 }}>
              {caption}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
