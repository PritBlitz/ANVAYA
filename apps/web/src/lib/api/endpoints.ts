import type { ApiClient, RequestOptions } from "./client";
import * as M from "./mappers";
import type * as T from "./types";
import type * as W from "./wire";

const enc = encodeURIComponent;

/** List endpoints return `data: Item[]` with the cursor in `meta.page.next_cursor`. */
async function list<Wire, Item>(
  client: ApiClient,
  path: string,
  map: (w: Wire) => Item,
  options?: RequestOptions,
): Promise<T.Page<Item>> {
  const { data, meta } = await client.getWithMeta<Wire[]>(path, options);
  return { items: data.map(map), next_cursor: meta.page?.next_cursor ?? null };
}

/** Fetch every page of a (small) collection, bounded to protect the UI. */
async function listAll<Wire, Item>(
  client: ApiClient,
  path: string,
  map: (w: Wire) => Item,
  query: RequestOptions["query"] = {},
  maxPages = 10,
): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await list<Wire, Item>(client, path, map, {
      query: { ...query, limit: 100, cursor },
    });
    items.push(...page.items);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return items;
}

/**
 * Every control-plane endpoint the UI uses, with request bodies exactly as the backend
 * validates them (strict: unknown fields are rejected) and responses mapped to UI models.
 */
export function createEndpoints(client: ApiClient) {
  const ws = () => client.getWorkspace() ?? undefined;

  return {
    auth: {
      providers: () => client.get<W.WProviders>("/auth/providers"),
      /** Development only (404 when disabled). */
      devLogin: (email: string) => client.post<W.WDevLogin>("/auth/dev-login", { email }),
      logout: () => client.post<void>("/auth/logout"),
    },

    me: {
      get: async () => M.toMe(await client.get<W.WMe>("/me")),
    },

    workspaces: {
      list: async () => (await client.get<W.WWorkspace[]>("/workspaces")).map(M.toWorkspace),
      create: async (body: T.CreateWorkspaceRequest, idempotencyKey: string) =>
        M.toWorkspace(await client.post<W.WWorkspace>("/workspaces", body, { idempotencyKey })),
      get: async (workspaceId: string) =>
        M.toWorkspace(await client.get<W.WWorkspace>(`/workspaces/${enc(workspaceId)}`)),
      /** Raw workspace including settings (run budget ceilings). */
      getRaw: (workspaceId: string) => client.get<W.WWorkspace>(`/workspaces/${enc(workspaceId)}`),
      update: async (
        workspaceId: string,
        body: { name?: string; settings?: W.WWorkspace["settings"] },
      ) => M.toWorkspace(await client.patch<W.WWorkspace>(`/workspaces/${enc(workspaceId)}`, body)),
      members: (workspaceId: string) =>
        listAll(client, `/workspaces/${enc(workspaceId)}/members`, M.toMember),
      invite: async (workspaceId: string, body: T.InviteMemberRequest, idempotencyKey: string) =>
        M.toInvitation(
          await client.post<W.WInvitation>(`/workspaces/${enc(workspaceId)}/invitations`, body, {
            idempotencyKey,
          }),
        ),
      invitations: (workspaceId: string) =>
        listAll(client, `/workspaces/${enc(workspaceId)}/invitations`, M.toInvitation),
      revokeInvitation: (workspaceId: string, invitationId: string) =>
        client.delete(`/workspaces/${enc(workspaceId)}/invitations/${enc(invitationId)}`),
      acceptInvitation: async (token: string) =>
        M.toWorkspace(await client.post<W.WWorkspace>("/invitations/accept", { token })),
      changeRole: async (workspaceId: string, userId: string, role: T.WorkspaceRole) =>
        M.toMember(
          await client.patch<W.WMember>(`/workspaces/${enc(workspaceId)}/members/${enc(userId)}`, {
            role,
          }),
        ),
      removeMember: (workspaceId: string, userId: string) =>
        client.delete(`/workspaces/${enc(workspaceId)}/members/${enc(userId)}`),
      aiPolicy: (workspaceId: string) =>
        client.get<T.AiPolicy>(`/workspaces/${enc(workspaceId)}/ai-policy`),
      updateAiPolicy: (workspaceId: string, body: T.UpdateAiPolicyRequest) =>
        client.patch<T.AiPolicy>(`/workspaces/${enc(workspaceId)}/ai-policy`, body),
      usage: async (workspaceId: string, query?: { from?: string; to?: string }) =>
        M.toUsage(await client.get<W.WUsage>(`/workspaces/${enc(workspaceId)}/usage`, { query })),
      auditEvents: (workspaceId: string, params: T.AuditListParams = {}) =>
        list(client, `/workspaces/${enc(workspaceId)}/audit-events`, M.toAuditEvent, {
          query: { ...params },
        }),
    },

    github: {
      /** Server-issued install URL + single-use state (GAP-14). */
      installUrl: (workspaceId: string) =>
        client.get<T.GitHubInstallUrl>("/integrations/github/install-url", {
          query: { workspace_id: workspaceId },
        }),
      installations: async () =>
        (
          await client.get<W.WInstallation[]>("/integrations/github/installations", {
            query: { workspace_id: ws() },
          })
        ).map(M.toInstallation),
      complete: async (body: T.CompleteInstallationRequest, idempotencyKey: string) =>
        M.toInstallation(
          await client.post<W.WInstallation>("/integrations/github/complete", body, {
            idempotencyKey,
          }),
        ),
      disconnect: (installationId: string) =>
        client.delete(`/integrations/github/installations/${enc(installationId)}`),
      /** GitHub-paged (100 per page): fetch pages while page * 100 < total_count (max 10). */
      availableRepositories: async (installationId: string) => {
        const out: T.AvailableRepository[] = [];
        for (let page = 1; page <= 10; page++) {
          const res = await client.get<W.WAvailableRepositoriesPage>(
            `/integrations/github/installations/${enc(installationId)}/repositories`,
            { query: { page } },
          );
          out.push(...M.selectableRepositories(res, installationId));
          if (page * 100 >= res.total_count || res.repositories.length === 0) break;
        }
        return out;
      },
    },

    repositories: {
      list: (params: T.PageParams = {}) =>
        list(client, "/repositories", M.toRepository, { query: { ...params, workspace_id: ws() } }),
      register: async (body: T.RegisterRepositoryRequest, idempotencyKey: string) =>
        M.toRepository(
          await client.post<W.WRepository>(
            "/repositories",
            { workspace_id: ws(), ...body },
            { idempotencyKey },
          ),
        ),
      get: async (repositoryId: string) =>
        M.toRepository(await client.get<W.WRepository>(`/repositories/${enc(repositoryId)}`)),
      update: async (repositoryId: string, body: T.UpdateRepositoryRequest) =>
        M.toRepository(
          await client.patch<W.WRepository>(`/repositories/${enc(repositoryId)}`, body),
        ),
      disconnect: (repositoryId: string) => client.delete(`/repositories/${enc(repositoryId)}`),
      /** 202: the job is accepted; poll index-status for progress. */
      queueIndex: (repositoryId: string, idempotencyKey: string) =>
        client.post<unknown>(`/repositories/${enc(repositoryId)}/index`, {}, { idempotencyKey }),
      indexStatus: async (repositoryId: string) =>
        M.toIndexStatus(
          await client.get<W.WIndexStatus>(`/repositories/${enc(repositoryId)}/index-status`),
        ),
      /** One directory level; `path` "" is the root. */
      tree: async (repositoryId: string, path = "", snapshot?: string) =>
        M.toTree(
          await client.get<W.WTree>(`/repositories/${enc(repositoryId)}/tree`, {
            query: { path: path || undefined, snapshot },
          }),
        ),
      fileContent: async (repositoryId: string, path: string, commitSha?: string) =>
        M.toFileContent(
          await client.get<W.WFile>(`/repositories/${enc(repositoryId)}/files/content`, {
            query: { path, commit_sha: commitSha },
          }),
        ),
      search: async (repositoryId: string, body: T.SearchRequest, signal?: AbortSignal) =>
        M.toSearchResponse(
          await client.post<W.WSearch>(`/repositories/${enc(repositoryId)}/search`, body, {
            signal,
          }),
        ),
      /** Symbol explorer (GAP-15): paged, ordered by name; `kind` may repeat. */
      symbols: (repositoryId: string, params: T.SymbolListParams = {}) =>
        list(client, `/repositories/${enc(repositoryId)}/symbols`, M.toSymbol, {
          query: {
            snapshot: params.snapshot,
            q: params.q || undefined,
            kind: params.kind?.length ? params.kind : undefined,
            path: params.path || undefined,
            limit: params.limit,
            cursor: params.cursor,
          },
        }),
      symbol: async (repositoryId: string, symbolId: string, snapshot?: string) =>
        M.toSymbolDetail(
          await client.get<W.WSymbolDetail>(
            `/repositories/${enc(repositoryId)}/symbols/${enc(symbolId)}`,
            { query: { snapshot } },
          ),
        ),
      /** File-level import graph, optionally scoped to a directory. */
      dependencyMap: async (repositoryId: string, path?: string, snapshot?: string) =>
        M.toDependencyMap(
          await client.get<W.WDependencyMap>(`/repositories/${enc(repositoryId)}/dependency-map`, {
            query: { path: path || undefined, snapshot },
          }),
        ),
      /** Callers/callees of a symbol (bounded depth, offset-paged nodes). */
      callGraph: (
        repositoryId: string,
        symbolId: string,
        params: {
          direction?: T.CallGraphDirection;
          depth?: number;
          limit?: number;
          cursor?: string;
        } = {},
      ) =>
        client.get<T.CallGraph>(
          `/repositories/${enc(repositoryId)}/symbols/${enc(symbolId)}/call-graph`,
          { query: { ...params } },
        ),
      /** Heuristic change-impact prediction and test selection. Never a verification result. */
      impact: (repositoryId: string, changedFiles: string[], maxTests?: number) =>
        client.post<T.ImpactPrediction>(`/repositories/${enc(repositoryId)}/impact`, {
          changed_files: changedFiles,
          ...(maxTests ? { max_tests: maxTests } : {}),
        }),
      snapshots: (repositoryId: string) =>
        client.get<T.RepositorySnapshot[]>(`/repositories/${enc(repositoryId)}/snapshots`),
      ask: async (repositoryId: string, body: T.AskQuestionRequest, signal?: AbortSignal) =>
        M.toQuestionAnswer(
          body.question,
          await client.post<W.WQuestionAnswer>(
            `/repositories/${enc(repositoryId)}/questions`,
            body,
            { signal },
          ),
        ),
      /** B-8: the caller's own saved questions, newest first. */
      questions: (repositoryId: string, params: T.PageParams = {}) =>
        list(client, `/repositories/${enc(repositoryId)}/questions`, M.toQuestionHistoryItem, {
          query: { ...params },
        }),
      knowledge: (repositoryId: string) =>
        listAll(client, `/repositories/${enc(repositoryId)}/knowledge`, M.toKnowledge),
      addKnowledge: async (
        repositoryId: string,
        body: T.CreateKnowledgeRequest,
        idempotencyKey: string,
      ) =>
        M.toKnowledge(
          await client.post<W.WKnowledge>(`/repositories/${enc(repositoryId)}/knowledge`, body, {
            idempotencyKey,
          }),
        ),
      createTask: async (repositoryId: string, body: T.CreateTaskRequest, idempotencyKey: string) =>
        M.toTask(
          await client.post<W.WTask>(`/repositories/${enc(repositoryId)}/tasks`, body, {
            idempotencyKey,
          }),
        ),
    },

    questions: {
      get: async (questionId: string) =>
        M.toQuestionHistoryItem(
          await client.get<W.WQuestionHistoryItem>(`/questions/${enc(questionId)}`),
        ),
      remove: (questionId: string) => client.delete(`/questions/${enc(questionId)}`),
    },

    knowledge: {
      get: async (documentId: string) =>
        M.toKnowledge(await client.get<W.WKnowledge>(`/knowledge/${enc(documentId)}`)),
      remove: (documentId: string) => client.delete(`/knowledge/${enc(documentId)}`),
    },

    tasks: {
      list: (params: T.TaskListParams = {}) =>
        list(client, "/tasks", M.toTask, { query: { ...params, workspace_id: ws() } }),
      get: async (taskId: string) => M.toTask(await client.get<W.WTask>(`/tasks/${enc(taskId)}`)),
      update: async (taskId: string, body: T.UpdateTaskRequest) =>
        M.toTask(await client.patch<W.WTask>(`/tasks/${enc(taskId)}`, body)),
      startRun: async (taskId: string, body: T.StartRunRequest, idempotencyKey: string) =>
        M.toRun(await client.post<W.WRun>(`/tasks/${enc(taskId)}/runs`, body, { idempotencyKey })),
      runs: async (taskId: string) =>
        (await listAll(client, `/tasks/${enc(taskId)}/runs`, (r: W.WRun) => M.toRun(r))).sort(
          (a, b) => b.run_number - a.run_number,
        ),
    },

    runs: {
      list: (params: T.RunListParams = {}) =>
        list(client, "/runs", M.toRunListItem, {
          query: {
            limit: params.limit,
            cursor: params.cursor,
            repository_id: params.repository_id,
            status: params.status,
            workspace_id: ws(),
          },
        }),
      get: async (runId: string) => M.toRun(await client.get<W.WRun>(`/runs/${enc(runId)}`)),
      eventsPath: (runId: string) => `/runs/${enc(runId)}/events`,
      cancel: async (runId: string, idempotencyKey: string) =>
        M.toRun(await client.post<W.WRun>(`/runs/${enc(runId)}/cancel`, {}, { idempotencyKey })),
      retry: async (runId: string, idempotencyKey: string) =>
        M.toRun(await client.post<W.WRun>(`/runs/${enc(runId)}/retry`, {}, { idempotencyKey })),
      steps: async (runId: string) =>
        (await client.get<W.WStep[]>(`/runs/${enc(runId)}/steps`)).map(M.toStep),
      artifacts: async (runId: string) =>
        M.toArtifacts(await client.get<W.WArtifacts>(`/runs/${enc(runId)}/artifacts`)),
      plan: async (runId: string) =>
        M.toRunPlan(await client.get<W.WPlan>(`/runs/${enc(runId)}/plan`)),
      /**
       * Edits are optimistic-concurrency checked against the plan hash (409 PLAN_CHANGED).
       * Returns the new revision only; callers merge it and refetch the full plan.
       */
      updatePlan: (runId: string, plan: T.EngineeringPlan, basePlanHash: string) =>
        client.patch<W.WPlanRevision>(`/runs/${enc(runId)}/plan`, {
          plan,
          base_plan_hash: basePlanHash,
        }),
      decidePlan: (runId: string, body: T.PlanApprovalRequest, idempotencyKey: string) =>
        client.post<unknown>(`/runs/${enc(runId)}/plan-approval`, body, { idempotencyKey }),
      diff: async (runId: string) =>
        M.toRunDiff(await client.get<W.WDiff>(`/runs/${enc(runId)}/diff`)),
      verification: async (runId: string) =>
        M.toVerification(await client.get<W.WVerification>(`/runs/${enc(runId)}/verification`)),
      review: async (runId: string) =>
        M.toReview(await client.get<W.WReview>(`/runs/${enc(runId)}/review`)),
      /** Heuristic impact of the run's patch (or plan files before a patch exists). */
      impact: (runId: string) => client.get<T.RunImpact>(`/runs/${enc(runId)}/impact`),
      /** Returns only the decision; callers merge it into the cached finding. */
      disposeFinding: (runId: string, findingId: string, body: T.FindingDispositionRequest) =>
        client.post<T.FindingDisposition>(
          `/runs/${enc(runId)}/findings/${enc(findingId)}/disposition`,
          body,
        ),
      decidePullRequest: (runId: string, body: T.PrApprovalRequest, idempotencyKey: string) =>
        client.post<unknown>(`/runs/${enc(runId)}/pr-approval`, body, { idempotencyKey }),
      createPullRequest: async (
        runId: string,
        body: T.CreatePullRequestRequest,
        idempotencyKey: string,
      ) =>
        M.toPullRequest(
          await client.post<W.WPullRequest>(`/runs/${enc(runId)}/pull-request`, body, {
            idempotencyKey,
          }),
        ),
    },

    templates: {
      list: (workspaceId: string, includeArchived = false) =>
        client.get<T.WorkflowTemplate[]>(`/workspaces/${enc(workspaceId)}/templates`, {
          query: { include_archived: includeArchived ? "true" : undefined },
        }),
      create: (workspaceId: string, body: T.CreateTemplateRequest, idempotencyKey: string) =>
        client.post<T.WorkflowTemplate>(`/workspaces/${enc(workspaceId)}/templates`, body, {
          idempotencyKey,
        }),
      update: (workspaceId: string, templateId: string, body: T.UpdateTemplateRequest) =>
        client.patch<T.WorkflowTemplate>(
          `/workspaces/${enc(workspaceId)}/templates/${enc(templateId)}`,
          body,
        ),
      archive: (workspaceId: string, templateId: string) =>
        client.delete(`/workspaces/${enc(workspaceId)}/templates/${enc(templateId)}`),
    },

    /** Cross-repository knowledge within a workspace (per-result repository provenance). */
    workspaceKnowledge: {
      search: (workspaceId: string, body: T.WorkspaceSearchRequest, signal?: AbortSignal) =>
        client.post<T.WorkspaceSearchResponse>(`/workspaces/${enc(workspaceId)}/search`, body, {
          signal,
        }),
      ask: (workspaceId: string, body: T.WorkspaceAskRequest, signal?: AbortSignal) =>
        client.post<T.WorkspaceAnswer>(`/workspaces/${enc(workspaceId)}/questions`, body, {
          signal,
        }),
    },

    ai: {
      healthCheck: async (body: { mode: T.InferenceMode }) =>
        M.toProviderHealth(
          await client.post<W.WProviderHealth>("/ai/providers/health-check", {
            workspace_id: ws(),
            ...body,
          }),
        ),
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
