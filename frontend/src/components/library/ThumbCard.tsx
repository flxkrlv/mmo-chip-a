import { useState } from "react";
import type { DieSummary, DieTileInfo, ImportJob, MLInferenceJob } from "shared";
import type { UseQueryResult } from "@tanstack/react-query";
import { useDeleteDie, useDieTileInfo, useExportProject, useRenameDie, useTilePrebuildControl } from "../../api/dies";
import { Menu, type MenuItemDef } from "../Menu";
import { formatBytes, formatPercent, formatPixels, formatTileProgress } from "../../lib/format";
import { formatTileEta } from "../../lib/tileEta";
import { useToast } from "../Toast";
import { useDialog } from "../Dialog";

function thumbnailUrl(dieId: string): string {
  return `/api/dies/${dieId}/tiles/0/0/0`;
}

type Props =
  | {
      kind: "die";
      die: DieSummary;
      inferenceJob?: MLInferenceJob;
    }
  | { kind: "importing"; job: ImportJob };

export function ThumbCard(props: Props) {
  const tileProgress = props.kind === "die" ? props.die.tileProgress : undefined;
  const overlayTileProgress = props.kind === "die" ? props.die.overlayTileProgress : undefined;
  const importing = props.kind === "importing";
  const inferenceJob =
    props.kind === "die" ? props.inferenceJob : undefined;
  const inferenceProgress =
    inferenceJob?.status === "running" ? inferenceJob.percentage : undefined;
  const totalTiles = (tileProgress?.totalTiles ?? 0) + (overlayTileProgress?.totalTiles ?? 0);
  const completedTiles = (tileProgress?.completedTiles ?? 0) + (overlayTileProgress?.completedTiles ?? 0);
  const combinedPercentage = totalTiles > 0 ? (completedTiles / totalTiles) * 100 : 100;
  const hasPendingTiles = totalTiles > completedTiles;
  const isPaused = Boolean(tileProgress?.isPaused || overlayTileProgress?.isPaused);
  const [showTileInfo, setShowTileInfo] = useState(false);
  const tileInfo = useDieTileInfo(props.kind === "die" ? props.die.id : undefined, showTileInfo);

  const inner = (
    <>
      <Thumbnail
        kind={importing ? "importing" : isPaused ? "paused" : hasPendingTiles ? "tiling" : "ready"}
        progress={importing ? props.job.progress.percentage : totalTiles > 0 ? combinedPercentage : undefined}
        caption={
          importing
            ? captionForImportJob(props.job)
            : hasPendingTiles || isPaused
            ? [
                tileProgress && `base ${formatTileProgress(tileProgress.completedTiles, tileProgress.totalTiles)}`,
                overlayTileProgress && `overlay ${formatTileProgress(overlayTileProgress.completedTiles, overlayTileProgress.totalTiles)}`,
                isPaused ? "paused" : tileProgress ? formatTileEta(tileProgress.etaSeconds) : "preparing overlay cache…"
              ].filter(Boolean).join(" · ")
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
            <DieCardActions die={props.die} onShowTileInfo={() => setShowTileInfo(true)} />
          ) : (
            <JobStatusChip status={props.job.status} />
          )}
        </div>
        <div className="m" style={{ fontSize: 10.5, color: "var(--ink3)", marginTop: 3 }}>
          {props.kind === "die"
            ? formatPixels(props.die.width, props.die.height)
            : "preparing import…"}
        </div>
        {props.kind === "die" && totalTiles > 0 && (
          <div className="m" style={{ fontSize: 10, color: "var(--ink3)", marginTop: 2 }}>
            {formatTileProgress(completedTiles, totalTiles)} · {formatPercent(combinedPercentage)}
            {hasPendingTiles && !isPaused && tileProgress ? ` · ${formatTileEta(tileProgress.etaSeconds)}` : ""}
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
      <article
        className="thumb-card"
        style={{ position: "relative" }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest(".thumb-card-actions")) return;
          window.location.assign(`/die/${encodeURIComponent(props.die.id)}`);
        }}
      >
        {inner}
        {showTileInfo && (
          <TileInfoPanel
            dieName={props.die.name}
            query={tileInfo}
            onClose={() => setShowTileInfo(false)}
          />
        )}
        <a
          href={`/die/${encodeURIComponent(props.die.id)}`}
          aria-label={`open ${props.die.name}`}
          className="thumb-card-link"
          onClick={(event) => event.stopPropagation()}
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

function DieCardActions({ die, onShowTileInfo }: { die: DieSummary; onShowTileInfo: () => void }) {
  const deleteMutation = useDeleteDie();
  const exportMutation = useExportProject();
  const renameMutation = useRenameDie();
  const prebuildMutation = useTilePrebuildControl();
  const toast = useToast();
  const dialog = useDialog();
  const [pending, setPending] = useState<string | null>(null);

  async function doExport(mode: "light" | "full") {
    if (pending) return;
    setPending(`Preparing ${mode} export… (this may take a while for large images)`);
    const includePreferences = await dialog.confirm(
      `Include browser preferences (net colors, viewport, …)?\n\n` +
      `Cancel = export project data only.\nOK = include preferences too.`
    );
    exportMutation.mutate(
      {
        dieId: die.id,
        mode,
        includePreferences
      },
      {
        onSuccess: ({ blob, filename }) => {
          setPending(null);
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);
        },
        onError: (err) => {
          setPending(null);
          toast.error("Export failed", err.message);
        }
      }
    );
  }

  async function doRename() {
    if (pending) return;
    const newName = await dialog.prompt(`Rename "${die.name}" to:`, die.name);
    if (!newName || newName.trim() === die.name) return;
    setPending("renaming…");
    renameMutation.mutate(
      { dieId: die.id, name: newName.trim() },
      {
        onSuccess: () => setPending(null),
        onError: (err) => {
          setPending(null);
          toast.error("Rename failed", err.message);
        }
      }
    );
  }

  const isBusy = pending !== null;
  const isTiling = Boolean(
    (die.tileProgress && die.tileProgress.completedTiles < die.tileProgress.totalTiles) ||
    (die.overlayTileProgress && die.overlayTileProgress.completedTiles < die.overlayTileProgress.totalTiles)
  );
  const isPaused = Boolean(die.tileProgress?.isPaused || die.overlayTileProgress?.isPaused);
  const prebuildActionBusy = prebuildMutation.isPending;

  const items: MenuItemDef[] = [
    {
      label: isBusy ? pending! : "Rename",
      disabled: isBusy,
      onSelect: doRename
    },
    ...(isTiling
      ? [{
          label: prebuildActionBusy
            ? "updating tile generation…"
            : isPaused
            ? "Resume tile generation"
            : "Pause tile generation",
          disabled: isBusy || prebuildActionBusy,
          onSelect: () => {
            prebuildMutation.mutate(
              { dieId: die.id, action: isPaused ? "resume" : "pause" },
              { onError: (error) => toast.error("Tile generation update failed", error.message) }
            );
          }
        }]
      : []),
    {
      label: isBusy ? "" : "Export (light)",
      disabled: isBusy,
      onSelect: () => doExport("light")
    },
    {
      label: isBusy ? "" : "Export (full)",
      disabled: isBusy,
      onSelect: () => doExport("full")
    },
    {
      label: pending === "deleting…" ? "deleting…" : "Delete",
      danger: true,
      disabled: isBusy,
      onSelect: async () => {
        if (!await dialog.confirm(`Delete "${die.name}"? This cannot be undone.`)) return;
        setPending("deleting…");
        deleteMutation.mutate(die.id, {
          onSettled: () => setPending(null)
        });
      }
    }
  ];

  return (
    <div className="thumb-card-actions" style={{ position: "relative", zIndex: 2, display: "flex", alignItems: "center", gap: 3 }}>
      <button
        type="button"
        aria-label={`tile cache information for ${die.name}`}
        title="Tile cache information"
        onClick={(event) => { event.stopPropagation(); onShowTileInfo(); }}
        style={{
          width: 20,
          height: 20,
          border: "1px solid var(--line, #555)",
          background: "transparent",
          color: "var(--ink3)",
          borderRadius: "50%",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1,
          padding: 0
        }}
      >
        i
      </button>
      <Menu items={items} ariaLabel={`actions for ${die.name}`} />
    </div>
  );
}

function TileInfoPanel({
  dieName,
  query,
  onClose
}: {
  dieName: string;
  query: UseQueryResult<DieTileInfo, Error>;
  onClose: () => void;
}) {
  const info = query.data;
  return (
    <div
      role="presentation"
      onClick={(event) => { event.stopPropagation(); onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.48)",
        display: "grid",
        placeItems: "center",
        padding: 20
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`Tile cache information for ${dieName}`}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(720px, 100%)",
          maxHeight: "min(80vh, 680px)",
          overflow: "auto",
          background: "var(--surface, #202020)",
          color: "var(--ink, #f4f4f4)",
          border: "1px solid var(--line, #444)",
          borderRadius: 8,
          boxShadow: "0 18px 60px rgba(0,0,0,.45)",
          padding: 16
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="m" style={{ fontSize: 11, letterSpacing: .7 }}>PROJECT TILE CACHE</div>
            <strong style={{ fontSize: 14 }}>{dieName}</strong>
          </div>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
        {query.isLoading && <p className="m">Calculating disk usage…</p>}
        {query.isError && <p className="m" style={{ color: "var(--danger, #e66)" }}>Could not load tile cache details: {query.error.message}</p>}
        {info && (
          <>
            <div className="m" style={{ fontSize: 11, color: "var(--ink3)", marginBottom: 8 }}>
              Full project on disk: <strong style={{ color: "var(--ink)" }}>{formatBytes(info.storage.totalBytes)}</strong>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, marginBottom: 16 }}>
              <tbody>
                <StorageRow label="Base image and metadata" value={formatBytes(info.storage.otherProjectBytes)} />
                <StorageRow label="Base image tiles" value={formatBytes(info.storage.baseTileBytes)} />
                <StorageRow label="Overlay originals" value={formatBytes(info.storage.overlayOriginalBytes)} />
                <StorageRow label="Overlay tile cache" value={formatBytes(info.storage.overlayTileBytes)} />
              </tbody>
            </table>
            <div className="m" style={{ fontSize: 11, letterSpacing: .7, marginBottom: 7 }}>OVERLAY SOURCES</div>
            {info.overlayTileProgress.sources.length === 0 ? (
              <p className="m" style={{ color: "var(--ink3)" }}>This project has no overlay images.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead><tr style={{ textAlign: "left", color: "var(--ink3)" }}><th style={{ padding: "5px 4px" }}>Image</th><th style={{ padding: "5px 4px" }}>Tiles</th><th style={{ padding: "5px 4px" }}>Status</th><th style={{ padding: "5px 4px" }}>Original</th><th style={{ padding: "5px 4px" }}>Cache</th></tr></thead>
                <tbody>
                  {info.overlayTileProgress.sources.map((source) => (
                    <tr key={source.id} style={{ borderTop: "1px solid var(--line, #444)" }}>
                      <td style={{ padding: "6px 4px", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={source.name}>{source.name}</td>
                      <td className="m" style={{ padding: "6px 4px" }}>{source.completedTiles.toLocaleString()} / {source.totalTiles.toLocaleString()} ({Math.round(source.percentage)}%)</td>
                      <td className="m" style={{ padding: "6px 4px" }}>{source.status}</td>
                      <td className="m" style={{ padding: "6px 4px" }}>{formatBytes(source.originalBytes ?? 0)}</td>
                      <td className="m" style={{ padding: "6px 4px" }}>{formatBytes(source.tileBytes ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function StorageRow({ label, value }: { label: string; value: string }) {
  return <tr><td style={{ padding: "5px 4px", color: "var(--ink3)" }}>{label}</td><td className="m" style={{ padding: "5px 4px", textAlign: "right" }}>{value}</td></tr>;
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
  kind: "ready" | "tiling" | "paused" | "importing";
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
            {kind === "importing" ? "IMPORTING" : kind === "paused" ? "TILES PAUSED" : "GENERATING TILES"}
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
