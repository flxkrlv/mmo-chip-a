import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { McpAccessEntry, McpHistoryItem, McpStatus, McpWriteMode } from "shared";
import { annotationKeys } from "./annotations";
import { subscribeGlobal, subscribeToDie } from "./annotationsWebSocket";
import { apiGet, apiPost, apiPut } from "./client";

export const mcpKeys = {
  forDie: (dieId: string) => ["mcp", dieId] as const,
  access: ["mcp-access"] as const
};

export function getMcpAccess(signal?: AbortSignal): Promise<{ endpointPath: string; dies: McpAccessEntry[] }> {
  return apiGet(`/api/mcp/access`, signal);
}

/** Approve or deny MCP clients' access to a die. */
export function setMcpAccess(dieId: string, state: "approved" | "denied"): Promise<{ ok: true }> {
  return apiPut(`/api/mcp/access/${dieId}`, { state });
}

/**
 * Access entries of every die, refreshed by the server's `mcp/access`
 * broadcast (a new request or a decision), with a slow poll as fallback.
 */
export function useMcpAccess() {
  const qc = useQueryClient();
  useEffect(
    () =>
      subscribeGlobal((msg) => {
        if (msg.type === "mcp/access") void qc.invalidateQueries({ queryKey: mcpKeys.access });
      }),
    [qc]
  );
  return useQuery({
    queryKey: mcpKeys.access,
    queryFn: ({ signal }) => getMcpAccess(signal),
    refetchInterval: 30_000
  });
}

export function getMcpStatus(dieId: string, signal?: AbortSignal): Promise<McpStatus> {
  return apiGet<McpStatus>(`/api/dies/${dieId}/mcp`, signal);
}

export function setMcpSettings(
  dieId: string,
  settings: { mode?: McpWriteMode; wires?: boolean; full?: boolean }
): Promise<{ ok: true }> {
  return apiPut(`/api/dies/${dieId}/mcp/settings`, settings);
}

/** Undo / redo the newest MCP change (server-side, separate from Ctrl+Z). */
export function stepMcpHistory(
  dieId: string,
  direction: "undo" | "redo"
): Promise<{ ok: true; rev: number; entry: McpHistoryItem }> {
  return apiPost(`/api/dies/${dieId}/mcp/${direction}`, {});
}

/**
 * MCP status for a die. Every MCP write (and MCP undo / redo) bumps the
 * annotation revision, so the annotation WS notification is what refreshes
 * the history list while an MCP client is working.
 */
export function useMcpStatus(dieId: string) {
  const qc = useQueryClient();
  useEffect(
    () =>
      subscribeToDie(dieId, (msg) => {
        if ((msg.type === "annotations" && msg.dieId === dieId) || msg.type === "mcp/access") {
          void qc.invalidateQueries({ queryKey: mcpKeys.forDie(dieId) });
        }
      }),
    [dieId, qc]
  );
  return useQuery({
    queryKey: mcpKeys.forDie(dieId),
    queryFn: ({ signal }) => getMcpStatus(dieId, signal)
  });
}

export function useInvalidateMcp(dieId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: mcpKeys.forDie(dieId) }),
      qc.invalidateQueries({ queryKey: mcpKeys.access }),
      qc.invalidateQueries({ queryKey: annotationKeys.forDie(dieId) })
    ]);
}
