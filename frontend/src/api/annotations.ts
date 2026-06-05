import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { DieAnnotations } from "shared";
import { apiGet } from "./client";

// ── Keys & basic read ────────────────────────────────────────────────

export const annotationKeys = {
  all: ["annotations"] as const,
  forDie: (dieId: string) => [...annotationKeys.all, dieId] as const
};

export function getAnnotations(dieId: string, signal?: AbortSignal): Promise<DieAnnotations> {
  return apiGet<DieAnnotations>(`/api/dies/${dieId}/annotations`, signal);
}

type AnnotationsQueryOptions = Omit<
  UseQueryOptions<DieAnnotations, Error, DieAnnotations, ReturnType<typeof annotationKeys.forDie>>,
  "queryKey" | "queryFn"
>;

export function useAnnotations(dieId: string | undefined, options?: AnnotationsQueryOptions) {
  return useQuery({
    queryKey: annotationKeys.forDie(dieId ?? ""),
    queryFn: ({ signal }) => getAnnotations(dieId!, signal),
    enabled: !!dieId,
    ...options
  });
}

// ── Pure list helpers ───────────────────────────────────────────────
//
// Used by both `applyAction` (in api/actions.ts) and any future code that
// needs to compose larger transforms over annotation collections.

export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((e) => e.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function removeById<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((e) => e.id !== id);
}
