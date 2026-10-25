import { useState } from "react";
import { setMcpAccess, useInvalidateMcp, useMcpAccess } from "../api/mcp";

/**
 * App-wide prompt for MCP clients asking for a die nobody approved yet. The
 * MCP endpoint serves every die, but the first call on a new die waits for
 * a user to approve or deny it here (or in the die viewer's MCP tab).
 */
export function McpAccessPrompt() {
  const { data } = useMcpAccess();
  const pending = (data?.dies ?? []).filter((d) => d.state === "pending");
  if (pending.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: "min(360px, calc(100vw - 32px))"
      }}
    >
      {pending.map((entry) => (
        <PendingCard key={entry.dieId} dieId={entry.dieId} dieName={entry.dieName} clientName={entry.clientName} />
      ))}
    </div>
  );
}

function PendingCard({ dieId, dieName, clientName }: { dieId: string; dieName: string; clientName: string | null }) {
  const invalidate = useInvalidateMcp(dieId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (state: "approved" | "denied") => {
    setBusy(true);
    setErr(null);
    try {
      await setMcpAccess(dieId, state);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await invalidate();
    }
  };
  return (
    <div
      role="alertdialog"
      aria-label="MCP access request"
      style={{
        background: "var(--panel)",
        border: "1px solid var(--l2, var(--l1))",
        borderRadius: 6,
        padding: "10px 12px",
        boxShadow: "0 6px 24px rgba(0, 0, 0, 0.35)",
        fontSize: 12,
        color: "var(--ink)"
      }}
    >
      <div className="u" style={{ fontSize: 10, marginBottom: 4 }}>
        MCP access request
      </div>
      <div style={{ marginBottom: 8 }}>
        <b>{clientName ?? "An MCP client"}</b> wants to use the die <b>{dieName}</b>. It could then read it, and
        write whatever that die's MCP tab allows.
      </div>
      {err && (
        <div className="m" style={{ fontSize: 10.5, color: "var(--danger, #e36854)", marginBottom: 6 }}>
          {err}
        </div>
      )}
      <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void decide("denied")}>
          Deny
        </button>
        <button type="button" className="btn accent" disabled={busy} onClick={() => void decide("approved")}>
          Approve
        </button>
      </div>
    </div>
  );
}
