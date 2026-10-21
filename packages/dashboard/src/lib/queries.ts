import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { DesktopSummary } from "@deskhand/shared";
import { api, type LockResult } from "./api";

export const keys = {
  system: ["system"] as const,
  desktops: ["desktops"] as const,
  desktop: (id: string) => ["desktops", id] as const,
  log: (id: string) => ["log", id] as const,
  recent: (id: string) => ["log", id, "recent"] as const,
  templates: ["templates"] as const,
  template: (name: string) => ["templates", name] as const,
  tokens: ["tokens"] as const,
};

/** Poll intervals (ms). Polling pauses while the tab is hidden (TanStack default). */
export const POLL = { desktops: 2000, desktop: 1500, system: 5000, log: 4000, templates: 15000 };

export function useSystem() {
  return useQuery({ queryKey: keys.system, queryFn: api.system, refetchInterval: POLL.system });
}

export function useDesktops() {
  return useQuery({ queryKey: keys.desktops, queryFn: api.desktops, refetchInterval: POLL.desktops });
}

export function useDesktop(id: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: keys.desktop(id),
    queryFn: () => api.desktop(id),
    refetchInterval: POLL.desktop,
    initialData: () => qc.getQueryData<DesktopSummary[]>(keys.desktops)?.find((d) => d.id === id),
    initialDataUpdatedAt: () => qc.getQueryState(keys.desktops)?.dataUpdatedAt,
  });
}

export function useRecentActions(id: string, limit = 5) {
  return useQuery({ queryKey: keys.recent(id), queryFn: () => api.log(id, { limit }), refetchInterval: POLL.log });
}

export function useLog(id: string, pageSize = 30) {
  return useInfiniteQuery({
    queryKey: keys.log(id),
    queryFn: ({ pageParam }) => api.log(id, { before: pageParam, limit: pageSize }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length < pageSize ? undefined : last[last.length - 1]!.id),
    refetchInterval: POLL.log,
  });
}

export function useTemplates() {
  return useQuery({ queryKey: keys.templates, queryFn: api.templates, refetchInterval: POLL.templates });
}

export function useTemplate(name: string) {
  return useQuery({ queryKey: keys.template(name), queryFn: () => api.template(name) });
}

export function useTokens() {
  return useQuery({ queryKey: keys.tokens, queryFn: api.tokens });
}

/** Write a desktop into both the detail and list caches. */
export function putDesktop(qc: QueryClient, d: DesktopSummary) {
  qc.setQueryData(keys.desktop(d.id), d);
  qc.setQueryData<DesktopSummary[]>(keys.desktops, (list) => (list ? list.map((x) => (x.id === d.id ? d : x)) : list));
}

function patchDesktop(qc: QueryClient, id: string, patch: (d: DesktopSummary) => DesktopSummary) {
  const cur = qc.getQueryData<DesktopSummary>(keys.desktop(id)) ?? qc.getQueryData<DesktopSummary[]>(keys.desktops)?.find((d) => d.id === id);
  if (cur) putDesktop(qc, patch(cur));
}

function invalidateDesktop(qc: QueryClient, id: string) {
  void qc.invalidateQueries({ queryKey: keys.desktop(id) });
  void qc.invalidateQueries({ queryKey: keys.desktops, exact: true });
  void qc.invalidateQueries({ queryKey: keys.log(id) });
}

export function useTakeOver(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.takeOver(id),
    onSuccess: (r: LockResult) => patchDesktop(qc, id, (d) => ({ ...d, lock: r.lock, generation: r.generation })),
    onSettled: () => invalidateDesktop(qc, id),
  });
}

export function useHandBack(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (note: string | null) => api.handBack(id, note),
    onSuccess: (r: LockResult, note) =>
      patchDesktop(qc, id, (d) => ({
        ...d,
        lock: null,
        attention: null,
        generation: r.generation,
        lastHandback: { note, at: new Date().toISOString(), generation: r.generation },
      })),
    onSettled: () => invalidateDesktop(qc, id),
  });
}

export function useDesktopMutation<T>(id: string, fn: (arg: T) => Promise<DesktopSummary | void>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (d) => {
      if (d) putDesktop(qc, d);
    },
    onSettled: () => invalidateDesktop(qc, id),
  });
}
