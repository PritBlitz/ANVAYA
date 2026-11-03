"use client";

import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { useWorkspaceId } from "@/lib/workspace/context";
import { isActiveRun } from "@/lib/domain/status";
import { runBudgetLimits } from "./mappers";
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
  invitations: (ws: string) => ["ws", ws, "invitations"] as const,
  aiPolicy: (ws: string) => ["ws", ws, "ai-policy"] as const,
  usage: (ws: string) => ["ws", ws, "usage"] as const,
  audit: (ws: string, params: object) => ["ws", ws, "audit", params] as const,
  installations: (ws: string) => ["ws", ws, "installations"] as const,
  available: (ws: string, installationId: string) =>
    ["ws", ws, "installations", installationId, "available"] as const,
  repositories: (ws: string) => ["ws", ws, "repositories"] as const,
  repository: (ws: string, id: string) => ["ws", ws, "repositories", id] as const,
  indexStatus: (ws: string, id: string) => ["ws", ws, "repositories", id, "index-status"] as const,
  tree: (ws: string, id: string, path: string) =>
    ["ws", ws, "repositories", id, "tree", path] as const,
  file: (ws: string, id: string, path: string, sha: string | null) =>
    ["ws", ws, "repositories", id, "file", path, sha] as const,
  search: (ws: string, id: string, req: T.SearchRequest) =>
    ["ws", ws, "repositories", id, "search", req] as const,
  symbols: (ws: string, id: string, params: object) =>
    ["ws", ws, "repositories", id, "symbols", params] as const,
  symbol: (ws: string, id: string, symbolId: string, snapshot: string) =>
    ["ws", ws, "repositories", id, "symbol", symbolId, snapshot] as const,
  dependencyMap: (ws: string, id: string, path: string, snapshot: string) =>
    ["ws", ws, "repositories", id, "dependency-map", path, snapshot] as const,
  questions: (ws: string, id: string) => ["ws", ws, "repositories", id, "questions"] as const,
  callGraph: (ws: string, id: string, symbolId: string, params: object) =>
    ["ws", ws, "repositories", id, "call-graph", symbolId, params] as const,
  templates: (ws: string, includeArchived = false) =>
    ["ws", ws, "templates", includeArchived] as const,
  runImpact: (ws: string, id: string) => ["ws", ws, "run", id, "impact"] as const,
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

/** Raw workspace (settings incl. run budget ceilings). */
export function useWorkspaceSettings() {
  const ws = useWorkspaceId();
  return useQuery({ queryKey: qk.workspace(ws), queryFn: () => api.workspaces.getRaw(ws) });
}

/** Run budget ceilings: workspace limits over the server defaults. */
export function useRunBudgetLimits() {
  const settings = useWorkspaceSettings();
  return { ...settings, data: settings.data ? runBudgetLimits(settings.data) : undefined };
}

export function useMembers() {
  const ws = useWorkspaceId();
  return useQuery({ queryKey: qk.members(ws), queryFn: () => api.workspaces.members(ws) });
}

export function useInvitations(enabled = true) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.invitations(ws),
    queryFn: () => api.workspaces.invitations(ws),
    enabled,
  });
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

/**
 * Follow `next_cursor` for up to `maxPages` pages of 100 so lists aren't silently cut
 * at the first page; the bound keeps polling cheap and protects the UI.
 */
export async function collectPages<X>(
  fetchPage: (cursor: string | undefined) => Promise<T.Page<X>>,
  maxPages = 10,
): Promise<X[]> {
  const items: X[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return items;
}

export function useRepositories() {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.repositories(ws),
    queryFn: () => collectPages((cursor) => api.repositories.list({ limit: 100, cursor })),
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
    // Poll while an indexing job is active (backend: active_job non-null).
    refetchInterval: (q) => (q.state.data?.active ? 1500 : false),
  });
}

/**
 * Lazily loaded tree: one query per directory level ("" is the root). A level at a
 * snapshot never changes, so levels are cached for the session.
 */
export function useTreeLevels(id: string, paths: string[], enabled = true) {
  const ws = useWorkspaceId();
  return useQueries({
    queries: paths.map((path) => ({
      queryKey: qk.tree(ws, id, path),
      queryFn: () => api.repositories.tree(id, path),
      enabled,
      staleTime: 10 * 60_000,
    })),
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

/** Symbol explorer: cursor-paged, 50 per page (GAP-15). */
export function useSymbols(id: string, params: Omit<T.SymbolListParams, "cursor" | "limit">) {
  const ws = useWorkspaceId();
  return useInfiniteQuery({
    queryKey: qk.symbols(ws, id, params),
    queryFn: ({ pageParam }) =>
      api.repositories.symbols(id, { ...params, limit: 50, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useSymbol(id: string, symbolId: string | null, snapshot = "latest") {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.symbol(ws, id, symbolId ?? "", snapshot),
    queryFn: () => api.repositories.symbol(id, symbolId!, snapshot),
    enabled: !!symbolId,
    staleTime: 5 * 60_000,
  });
}

/** Call graph around a symbol; nodes are paged 25 at a time. */
export function useCallGraph(
  id: string,
  symbolId: string | null,
  direction: T.CallGraphDirection,
  depth: number,
) {
  const ws = useWorkspaceId();
  return useInfiniteQuery({
    queryKey: qk.callGraph(ws, id, symbolId ?? "", { direction, depth }),
    queryFn: ({ pageParam }) =>
      api.repositories.callGraph(id, symbolId!, {
        direction,
        depth,
        limit: 25,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: !!symbolId,
    staleTime: 5 * 60_000,
  });
}

export function useTemplates(includeArchived = false) {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.templates(ws, includeArchived),
    queryFn: () => api.templates.list(ws, includeArchived),
    staleTime: 60_000,
  });
}

/** Heuristic impact and test selection for a run. Refreshes when the run's plan or patch changes. */
export function useRunImpact(id: string, enabled = true) {
  const ws = useWorkspaceId();
  return useQuery({ queryKey: qk.runImpact(ws, id), queryFn: () => api.runs.impact(id), enabled });
}

export function useDependencyMap(id: string, path: string, snapshot = "latest") {
  const ws = useWorkspaceId();
  return useQuery({
    queryKey: qk.dependencyMap(ws, id, path, snapshot),
    queryFn: () => api.repositories.dependencyMap(id, path || undefined, snapshot),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
}

/** B-8: saved Q&A history for the current user, 20 per page, newest first. */
export function useQuestionHistory(id: string) {
  const ws = useWorkspaceId();
  return useInfiniteQuery({
    queryKey: qk.questions(ws, id),
    queryFn: ({ pageParam }) =>
      api.repositories.questions(id, { limit: 20, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
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
    queryFn: () => collectPages((cursor) => api.tasks.list({ limit: 100, ...params, cursor })),
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
    queryFn: () => collectPages((cursor) => api.runs.list({ limit: 100, ...params, cursor })),
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
