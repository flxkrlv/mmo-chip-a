import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useImportDie, useImportProject } from "../api/dies";
import { useLibraryItems, type LibraryItem } from "../api/library";
import { AppShell } from "../components/shell/AppShell";
import { StatusBar } from "../components/shell/StatusBar";
import { ThumbCard } from "../components/library/ThumbCard";
import { Ic } from "../icons";

export function LibraryPage() {
  const { items, isLoading, error, refetch } = useLibraryItems();
  const importMutation = useImportDie();
  const importProjectMutation = useImportProject();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => filterItems(items, filter), [items, filter]);

  const totals = useMemo(() => {
    let importing = 0;
    let tiling = 0;
    for (const it of items) {
      if (it.kind === "importing") importing += 1;
      else if (it.die.tileProgress) tiling += 1;
    }
    return { importing, tiling, total: items.length };
  }, [items]);

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      await importMutation.mutateAsync(file);
    } catch {
      // toast/error UI will be wired later — for now keep mutation.error visible
    }
  }

  const handleProjectFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      try {
        const result = await importProjectMutation.mutateAsync({ file });
        navigate(`/die/${result.dieId}`);
      } catch (err: unknown) {
        // Check for 409 conflict
        const apiErr = err as { status?: number; body?: { error?: string; dieId?: string; name?: string } };
        if (apiErr?.status === 409 && apiErr.body) {
          const b = apiErr.body;
          const action = window.prompt(
            `Die "${b.name}" already exists (ID: ${b.dieId}).` +
            `\nEnter a new name to import as a copy, or leave empty to cancel.` +
            `\n\n(To overwrite, first delete the existing die and retry.)`
          );
          if (action && action.trim()) {
            try {
              const result2 = await importProjectMutation.mutateAsync({
                file,
                renameTo: action.trim()
              });
              navigate(`/die/${result2.dieId}`);
            } catch (err2: unknown) {
              alert(`Import failed: ${(err2 as Error).message}`);
            }
          }
        } else {
          alert(`Import failed: ${(err as Error).message}`);
        }
      }
    },
    [importProjectMutation, navigate]
  );

  return (
    <AppShell>
      <div style={{ padding: "24px 24px 0", display: "flex", alignItems: "center", gap: 10 }}>
        <h1
          style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 600,
            color: "var(--ink)",
            letterSpacing: -0.2
          }}
        >
          All chips
        </h1>
        <span className="m" style={{ color: "var(--ink3)", fontSize: 11 }}>
          {totals.total} total
        </span>
        <div style={{ flex: 1 }} />
        <label className="input m" style={{ width: 240 }}>
          <span style={{ color: "var(--ink3)", display: "inline-flex" }}>{Ic.search}</span>
          <input
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <button
          className="btn accent"
          onClick={handleImportClick}
          disabled={importMutation.isPending}
        >
          {Ic.plus} {importMutation.isPending ? "uploading…" : "import image"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
        <button
          className="btn"
          onClick={() => projectFileInputRef.current?.click()}
          disabled={importProjectMutation.isPending}
        >
          {importProjectMutation.isPending ? "importing…" : "Import Project"}
        </button>
        <input
          ref={projectFileInputRef}
          type="file"
          accept=".zip"
          style={{ display: "none" }}
          onChange={handleProjectFileChange}
        />
      </div>

      <div
        style={{
          flex: "1 1 auto",
          overflow: "auto",
          padding: "18px 24px 24px"
        }}
      >
        {error && <ErrorState message={error.message} onRetry={() => void refetch()} />}
        {!error && isLoading && <EmptyState>loading…</EmptyState>}
        {!error && !isLoading && filtered.length === 0 && (
          <EmptyState>
            {items.length === 0
              ? "no chips yet — import a die image to get started"
              : "no matches"}
          </EmptyState>
        )}
        {!error && filtered.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 14,
              alignContent: "start"
            }}
          >
            {filtered.map((it) => (
              <ThumbCard key={it.id} {...itemProps(it)} />
            ))}
          </div>
        )}
      </div>

      <StatusBar items={buildStatusItems(totals, importMutation.error?.message)} />
    </AppShell>
  );
}

function itemProps(item: LibraryItem) {
  if (item.kind === "die") {
    return {
      kind: "die" as const,
      die: item.die,
      inferenceJob: item.inferenceJob
    };
  }
  return { kind: "importing" as const, job: item.job };
}

function filterItems(items: LibraryItem[], filter: string): LibraryItem[] {
  const q = filter.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    if (it.kind === "die") return it.die.name.toLowerCase().includes(q);
    return it.job.originalFilename.toLowerCase().includes(q);
  });
}

function buildStatusItems(
  totals: { total: number; importing: number; tiling: number },
  uploadError?: string
): string[] {
  const items: string[] = [`${totals.total} chips`];
  if (totals.importing) items.push(`${totals.importing} importing`);
  if (totals.tiling) items.push(`${totals.tiling} tiling`);
  if (!totals.importing && !totals.tiling) items.push("idle");
  if (uploadError) items.push(`upload failed: ${uploadError}`);
  return items;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        color: "var(--ink3)",
        fontSize: 11,
        padding: "40px 0",
        textAlign: "center",
        letterSpacing: 0.4
      }}
    >
      {children}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      style={{
        border: "1px solid var(--l2)",
        background: "var(--errBg)",
        color: "var(--err)",
        padding: "12px 14px",
        borderRadius: 3,
        display: "flex",
        alignItems: "center",
        gap: 10
      }}
    >
      <span className="m" style={{ fontSize: 11 }}>
        failed to load library: {message}
      </span>
      <div style={{ flex: 1 }} />
      <button className="btn" onClick={onRetry}>
        retry
      </button>
    </div>
  );
}
