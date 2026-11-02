"use client";

import { useInfiniteQuery, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { useWorkspaceId } from "@/lib/workspace/context";
import { isActiveRun } from "@/lib/domain/status";
import { api } from "./runtime";
import type * as T from "./types";

/**
 * Query keys. Every tenant-owned key starts with ["ws", workspaceId] so switching
 * workspaces can never show cached data from another tenant.
 */
export const qk = {
  me: ["me"] as const,
  workspaces: ["workspaces"] as const,
  ws: (ws: string) => ["ws", ws] as const,
  workspace: (ws: string) => ["ws", ws, "detail"] as const,
  members: (ws: string) => ["ws", ws, "members"] as const,
  aiPolicy: (ws: string) => ["ws", ws, "ai-policy"] as const,
  usage: (ws: string) => ["ws", ws, "usage"] as const,
  audit: (ws: string, params: object) => ["ws", ws, "audit", params] as const,
  installations: (ws: string) => ["ws", ws, "installations"] as const,
  available: (ws: string, installationId: string) =>
    ["ws", ws, "installations", installationId, "available"] as const,
  repositories: (ws: string) => ["ws", ws, "repositories"] as const,
  repository: (ws: string, id: string) => ["ws", ws, "repositories", id] as const,
  indexStatus: (ws: string, id: string) => ["ws", ws, "repositories", id, "index-status"] as const,
  tree: (ws: string, id: string, sha: string | null) =>
    ["ws", ws, "repositories", id, "tree", sha] as const,
  file: (ws: string, id: string, path: string, sha: string | null) =>
    ["ws", ws, "repositories", id, "file", path, sha] as const,
  search: (ws: string, id: string, req: T.SearchRequest) =>
    ["ws", ws, "repositories", id, "search", req] as const,
  knowledge: (ws: string, id: string) => ["ws", ws, "repositories", id, "knowledge"] as const,
  knowledgeDoc: (ws: string, docId: string) => ["ws", ws, "knowledge", docId] as const,
  tasks: (ws: string, params?: T.TaskListParams) =>
    params ? (["ws", ws, "tasks", params] as const) : (["ws", ws, "tasks"] as const),
  task: (ws: string, id: string) => ["ws", ws, "task", id] as const,
  taskRuns: (ws: string, id: string) => ["ws", ws, "task", id, "runs"] as const,
  runs: (ws: string, params?: T.RunListParams) =>
    params ? (["ws", ws, "runs", params] as const) : (["ws", ws, "runs"] as const),
  run: (ws: string, id: string) => ["ws", ws, "run", id] as const,
  runPart: (
    ws: string,
    id: string,
    part: "steps" | "plan" | "diff" | "verification" | "review" | "artifacts",
  ) => ["ws", ws, "run", id, part] as const,
};

type Opts<D> = Omit<UseQueryOptions<D, Error, D, readonly unknown[]>, "queryKey" | "queryFn">;

// ── identity ─────────────────────────────────────────────────────────────

export function useMe(options?: Opts<T.Me>) {
  return useQuery({ queryKey: qk.me, queryFn: api.me.get, staleTime: 60_000, ...options });
}

export function useWorkspaces(options?: Opts<T.Workspace[]>) {
  return useQuery({
    queryKey: qk.workspaces,
    queryFn: api.workspaces.list,
    staleTime: 60_000,
    ...options,
  });
}

export function useMembers() {
  const ws = useWorkspaceId();
  return useQuery({ queryKey: qk.members(ws), queryFn: () => api.workspaces.members(ws) });
}

export function useAiPolicy() {
  const ws = useWorkspaceId();
  return useQuery({ queryKey: qk.aiPolicy(ws), queryFn: () => api.workspaces.aiPolicy(ws) });
}

export function useUsage() {
  const ws = useWorkspaceId();
  return useQuery({ queryKey: qk.usage(ws), queryFn: () => api.workspaces.usage(ws) });
}

export function useAuditEvents(params: Omit<T.AuditListParams, "cursor"> = {}, enabled = true) {
  const ws = useWorkspaceId();
  return useInfiniteQuery({
    queryKey: qk.audit(ws, params),
    queryFn: ({ pageParam }) =>
      api.workspaces.auditEvents(ws, { ...params, limit: 25, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled,
  });
}

// ── git & repositories ───────────────────────────────────────────────────

export function useInstallations() {
  const ws = useWorkspaceId();
  return useQuery({ queryKey: qk.installations(ws), queryFn: api.github.installations });
}

export function useAvailableRepositories(installationId: string | null) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.available(ws, installationId ?? "none"),
    queryFn: () => api.github.availableRepositories(installationId!),
    enabled: !!installationId,
  });
}

export function useRepositories() {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.repositories(ws),
    queryFn: async () => (await api.repositories.list({ limit: 100 })).items,
    // Keep list badges fresh while any repository is indexing.
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.indexing_status === "queued" || r.indexing_status === "indexing")
        ? 3000
        : false,
  });
}

export function useRepository(id: string | null | undefined) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.repository(ws, id ?? ""),
    queryFn: () => api.repositories.get(id!),
    enabled: !!id,
  });
}

export function useIndexStatus(id: string) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.indexStatus(ws, id),
    queryFn: () => api.repositories.indexStatus(id),
    refetchInterval: (q) => {
      const s = q.state.data?.indexing_status;
      return s === "queued" || s === "indexing" ? 1500 : false;
    },
  });
}

export function useTree(id: string, commitSha: string | null, enabled = true) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.tree(ws, id, commitSha),
    queryFn: () => api.repositories.tree(id, commitSha ? { snapshot: commitSha } : undefined),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useFileContent(id: string, path: string | null, commitSha: string | null) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.file(ws, id, path ?? "", commitSha),
    queryFn: () => api.repositories.fileContent(id, path!, commitSha ?? undefined),
    enabled: !!path,
    staleTime: Infinity, // content at a commit SHA is immutable
  });
}

export function useSearch(id: string, request: T.SearchRequest | null) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.search(ws, id, request ?? { query: "", snapshot: "latest", top_k: 0 }),
    queryFn: async ({ signal }) => {
      // Retrieval latency is measured independently from model generation (PRD §9).
      const started = performance.now();
      const response = await api.repositories.search(id, request!, signal);
      return { ...response, latency_ms: Math.round(performance.now() - started) };
    },
    enabled: !!request && request.query.trim().length >= 2,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useKnowledge(id: string, enabled = true) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.knowledge(ws, id),
    queryFn: () => api.repositories.knowledge(id),
    enabled,
  });
}

export function useKnowledgeDocument(docId: string | null) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.knowledgeDoc(ws, docId ?? ""),
    queryFn: () => api.knowledge.get(docId!),
    enabled: !!docId,
  });
}

// ── tasks & runs ─────────────────────────────────────────────────────────

export function useTasks(params: T.TaskListParams = {}) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.tasks(ws, params),
    queryFn: async () => (await api.tasks.list({ limit: 100, ...params })).items,
    refetchInterval: (q) =>
      q.state.data?.some((t) => t.latest_run && isActiveRun(t.latest_run.status)) ? 5000 : false,
  });
}

export function useTask(id: string) {
  const ws = useWorkspaceId();
  return useQuery({ queryKey: qk.task(ws, id), queryFn: () => api.tasks.get(id) });
}

export function useTaskRuns(id: string) {
  const ws = useWorkspaceId();
  return useQuery({ queryKey: qk.taskRuns(ws, id), queryFn: () => api.tasks.runs(id) });
}

export function useRuns(params: T.RunListParams = {}, options?: Opts<T.RunListItem[]>) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.runs(ws, params),
    queryFn: async () => (await api.runs.list({ limit: 100, ...params })).items,
    refetchInterval: (q) =>
      q.state.data?.some((r) => isActiveRun(r.status) && !r.status.startsWith("awaiting"))
        ? 5000
        : false,
    ...options,
  });
}

/**
 * Run detail. The SSE stream invalidates this query on every event; polling is only a
 * fallback while the stream is disconnected (see useRunEvents).
 */
export function useRun(id: string, pollWhileActive = false) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.run(ws, id),
    queryFn: () => api.runs.get(id),
    refetchInterval: (q) =>
      pollWhileActive && q.state.data && isActiveRun(q.state.data.status) ? 4000 : false,
  });
}

function useRunPart<D>(
  id: string,
  part: Parameters<typeof qk.runPart>[2],
  fn: () => Promise<D>,
  enabled = true,
) {
  const ws = useWorkspaceId();
  return useQuery({ queryKey: qk.runPart(ws, id, part), queryFn: fn, enabled });
}

export const useRunSteps = (id: string) => useRunPart(id, "steps", () => api.runs.steps(id));
export const useRunPlan = (id: string, enabled = true) =>
  useRunPart(id, "plan", () => api.runs.plan(id), enabled);
export const useRunDiff = (id: string, enabled = true) =>
  useRunPart(id, "diff", () => api.runs.diff(id), enabled);
export const useRunVerification = (id: string, enabled = true) =>
  useRunPart(id, "verification", () => api.runs.verification(id), enabled);
export const useRunReview = (id: string, enabled = true) =>
  useRunPart(id, "review", () => api.runs.review(id), enabled);
export const useRunArtifacts = (id: string) =>
  useRunPart(id, "artifacts", () => api.runs.artifacts(id));
