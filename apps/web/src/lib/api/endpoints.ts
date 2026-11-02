import type { ApiClient, RequestOptions } from "./client";
import type * as T from "./types";

const enc = encodeURIComponent;

/** List endpoints return `data: T[]` with `meta.next_cursor` (API_SPEC §1, GAP-09). */
async function list<Item>(
  client: ApiClient,
  path: string,
  options?: RequestOptions,
): Promise<T.Page<Item>> {
  const { data, meta } = await client.getWithMeta<Item[]>(path, options);
  return { items: data, next_cursor: meta.next_cursor ?? null };
}

/**
 * Every API_SPEC.md endpoint used by the UI, in one place. Proposed endpoints that are
 * not yet in API_SPEC.md are marked `PROPOSED (GAP-xx)`.
 */
export function createEndpoints(client: ApiClient) {
  return {
    auth: {
      /** PROPOSED (GAP-01): end the session server-side. */
      logout: () => client.post<void>("/auth/logout"),
    },

    me: {
      get: () => client.get<T.Me>("/me"),
    },

    workspaces: {
      list: () => client.get<T.Workspace[]>("/workspaces"),
      create: (body: T.CreateWorkspaceRequest, idempotencyKey: string) =>
        client.post<T.Workspace>("/workspaces", body, { idempotencyKey }),
      get: (workspaceId: string) => client.get<T.Workspace>(`/workspaces/${enc(workspaceId)}`),
      update: (workspaceId: string, body: T.UpdateWorkspaceRequest) =>
        client.patch<T.Workspace>(`/workspaces/${enc(workspaceId)}`, body),
      members: (workspaceId: string) =>
        client.get<T.Member[]>(`/workspaces/${enc(workspaceId)}/members`),
      invite: (workspaceId: string, body: T.InviteMemberRequest, idempotencyKey: string) =>
        client.post<T.Invitation>(`/workspaces/${enc(workspaceId)}/invitations`, body, {
          idempotencyKey,
        }),
      changeRole: (workspaceId: string, userId: string, role: T.WorkspaceRole) =>
        client.patch<T.Member>(`/workspaces/${enc(workspaceId)}/members/${enc(userId)}`, { role }),
      removeMember: (workspaceId: string, userId: string) =>
        client.delete(`/workspaces/${enc(workspaceId)}/members/${enc(userId)}`),
      aiPolicy: (workspaceId: string) =>
        client.get<T.AiPolicy>(`/workspaces/${enc(workspaceId)}/ai-policy`),
      updateAiPolicy: (workspaceId: string, body: T.UpdateAiPolicyRequest) =>
        client.patch<T.AiPolicy>(`/workspaces/${enc(workspaceId)}/ai-policy`, body),
      usage: (workspaceId: string, query?: { period?: string }) =>
        client.get<T.UsageSummary>(`/workspaces/${enc(workspaceId)}/usage`, { query }),
      auditEvents: (workspaceId: string, params: T.AuditListParams = {}) =>
        list<T.AuditEvent>(client, `/workspaces/${enc(workspaceId)}/audit-events`, {
          query: { ...params },
        }),
    },

    github: {
      installations: () => client.get<T.GitInstallation[]>("/integrations/github/installations"),
      complete: (body: T.CompleteInstallationRequest, idempotencyKey: string) =>
        client.post<T.GitInstallation>("/integrations/github/complete", body, { idempotencyKey }),
      disconnect: (installationId: string) =>
        client.delete(`/integrations/github/installations/${enc(installationId)}`),
      /** PROPOSED (GAP-03) */
      availableRepositories: (installationId: string) =>
        client.get<T.AvailableRepository[]>(
          `/integrations/github/installations/${enc(installationId)}/repositories`,
        ),
    },

    repositories: {
      list: (params: T.PageParams = {}) =>
        list<T.Repository>(client, "/repositories", { query: { ...params } }),
      register: (body: T.RegisterRepositoryRequest, idempotencyKey: string) =>
        client.post<T.Repository>("/repositories", body, { idempotencyKey }),
      get: (repositoryId: string) => client.get<T.Repository>(`/repositories/${enc(repositoryId)}`),
      update: (repositoryId: string, body: T.UpdateRepositoryRequest) =>
        client.patch<T.Repository>(`/repositories/${enc(repositoryId)}`, body),
      disconnect: (repositoryId: string) => client.delete(`/repositories/${enc(repositoryId)}`),
      queueIndex: (repositoryId: string, idempotencyKey: string) =>
        client.post<T.IndexStatus>(
          `/repositories/${enc(repositoryId)}/index`,
          {},
          { idempotencyKey },
        ),
      indexStatus: (repositoryId: string) =>
        client.get<T.IndexStatus>(`/repositories/${enc(repositoryId)}/index-status`),
      tree: (repositoryId: string, query?: { snapshot?: string }) =>
        client.get<T.FileTree>(`/repositories/${enc(repositoryId)}/tree`, { query }),
      /** PROPOSED (GAP-04) */
      fileContent: (repositoryId: string, path: string, commitSha?: string) =>
        client.get<T.FileContent>(`/repositories/${enc(repositoryId)}/files/content`, {
          query: { path, commit_sha: commitSha },
        }),
      search: (repositoryId: string, body: T.SearchRequest, signal?: AbortSignal) =>
        client.post<T.SearchResponse>(`/repositories/${enc(repositoryId)}/search`, body, {
          signal,
        }),
      snapshots: (repositoryId: string) =>
        client.get<T.RepositorySnapshot[]>(`/repositories/${enc(repositoryId)}/snapshots`),
      ask: (repositoryId: string, body: T.AskQuestionRequest, signal?: AbortSignal) =>
        client.post<T.QuestionAnswer>(`/repositories/${enc(repositoryId)}/questions`, body, {
          signal,
        }),
      knowledge: (repositoryId: string) =>
        client.get<T.KnowledgeDocument[]>(`/repositories/${enc(repositoryId)}/knowledge`),
      addKnowledge: (
        repositoryId: string,
        body: T.CreateKnowledgeRequest,
        idempotencyKey: string,
      ) =>
        client.post<T.KnowledgeDocument>(`/repositories/${enc(repositoryId)}/knowledge`, body, {
          idempotencyKey,
        }),
      createTask: (repositoryId: string, body: T.CreateTaskRequest, idempotencyKey: string) =>
        client.post<T.EngineeringTask>(`/repositories/${enc(repositoryId)}/tasks`, body, {
          idempotencyKey,
        }),
    },

    knowledge: {
      get: (documentId: string) => client.get<T.KnowledgeDocument>(`/knowledge/${enc(documentId)}`),
      remove: (documentId: string) => client.delete(`/knowledge/${enc(documentId)}`),
    },

    tasks: {
      list: (params: T.TaskListParams = {}) =>
        list<T.EngineeringTask>(client, "/tasks", { query: { ...params } }),
      get: (taskId: string) => client.get<T.EngineeringTask>(`/tasks/${enc(taskId)}`),
      update: (taskId: string, body: T.UpdateTaskRequest) =>
        client.patch<T.EngineeringTask>(`/tasks/${enc(taskId)}`, body),
      startRun: (taskId: string, body: T.StartRunRequest, idempotencyKey: string) =>
        client.post<T.WorkflowRun>(`/tasks/${enc(taskId)}/runs`, body, { idempotencyKey }),
      runs: (taskId: string) => client.get<T.RunSummary[]>(`/tasks/${enc(taskId)}/runs`),
    },

    runs: {
      /** PROPOSED (GAP-05) */
      list: (params: T.RunListParams = {}) =>
        list<T.RunListItem>(client, "/runs", {
          query: {
            limit: params.limit,
            cursor: params.cursor,
            repository_id: params.repository_id,
            status: params.status,
          },
        }),
      get: (runId: string) => client.get<T.WorkflowRun>(`/runs/${enc(runId)}`),
      eventsPath: (runId: string) => `/runs/${enc(runId)}/events`,
      cancel: (runId: string, idempotencyKey: string) =>
        client.post<T.WorkflowRun>(`/runs/${enc(runId)}/cancel`, {}, { idempotencyKey }),
      retry: (runId: string, idempotencyKey: string) =>
        client.post<T.WorkflowRun>(`/runs/${enc(runId)}/retry`, {}, { idempotencyKey }),
      steps: (runId: string) => client.get<T.AgentStep[]>(`/runs/${enc(runId)}/steps`),
      artifacts: (runId: string) => client.get<T.RunArtifact[]>(`/runs/${enc(runId)}/artifacts`),
      plan: (runId: string) => client.get<T.RunPlan>(`/runs/${enc(runId)}/plan`),
      updatePlan: (runId: string, plan: T.EngineeringPlan) =>
        client.patch<T.RunPlan>(`/runs/${enc(runId)}/plan`, { plan }),
      decidePlan: (runId: string, body: T.ApprovalRequest, idempotencyKey: string) =>
        client.post<T.Approval>(`/runs/${enc(runId)}/plan-approval`, body, { idempotencyKey }),
      diff: (runId: string) => client.get<T.RunDiff>(`/runs/${enc(runId)}/diff`),
      verification: (runId: string) =>
        client.get<T.VerificationReport>(`/runs/${enc(runId)}/verification`),
      review: (runId: string) => client.get<T.ReviewReport>(`/runs/${enc(runId)}/review`),
      disposeFinding: (runId: string, findingId: string, body: T.FindingDispositionRequest) =>
        client.post<T.ReviewFinding>(
          `/runs/${enc(runId)}/findings/${enc(findingId)}/disposition`,
          body,
        ),
      decidePullRequest: (runId: string, body: T.ApprovalRequest, idempotencyKey: string) =>
        client.post<T.Approval>(`/runs/${enc(runId)}/pr-approval`, body, { idempotencyKey }),
      createPullRequest: (
        runId: string,
        body: T.CreatePullRequestRequest,
        idempotencyKey: string,
      ) => client.post<T.PullRequest>(`/runs/${enc(runId)}/pull-request`, body, { idempotencyKey }),
    },

    ai: {
      healthCheck: (body: { mode: T.InferenceMode }) =>
        client.post<T.ProviderHealth>("/ai/providers/health-check", body),
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
