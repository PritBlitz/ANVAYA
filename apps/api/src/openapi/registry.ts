import { z, type ZodType } from 'zod';
import { refine } from './refinements.js';
import { RESPONSES as DERIVED } from './responses.generated.js';
import { callGraphView, extendExistingResponses, impactView, runImpactView, templateView, workspaceAnswerView, workspaceSearchView } from './package-b-responses.js';
import { callGraphQuery, impactBody, runImpactQuery } from '../intelligence/intelligence.controller.js';
import { workspaceAskBody, workspaceSearchBody } from '../intelligence/workspace-knowledge.service.js';
import { createTemplateBody, listTemplatesQuery, updateTemplateBody } from '../templates/templates.js';
import { updateAiPolicyBody } from '../ai/ai-policy.service.js';
import { healthCheckBody, usageQuery } from '../ai/ai.controller.js';
import { askBody } from '../ai/questions.service.js';
import { auditQuery } from '../audit/audit.controller.js';
import { paginationQuery } from '../common/http.js';
import { availableReposQuery, completeInstallationBody, workspaceQuery } from '../github/integrations.controller.js';
import { callbackQuery, devLoginBody } from '../identity/auth.controller.js';
import { dependencyMapQuery, symbolDetailQuery, symbolsQuery } from '../indexing/code-intel.controller.js';
import { fileQuery, searchBody, treeQuery } from '../indexing/indexing.controller.js';
import { createKnowledgeBody, listKnowledgeQuery } from '../knowledge/knowledge.controller.js';
import { createRepositoryBody, listRepositoriesQuery, queueIndexBody, updateRepositoryBody } from '../repositories/repositories.schemas.js';
import { dispositionBody, prApprovalBody, pullRequestBody } from '../review/review.service.js';
import { cancelBody, sseQuery } from '../runs/runs.controller.js';
import { createTaskBody, editPlanBody, listRunsQuery, listTasksQuery, planApprovalBody, planSchema, startRunBody, updateTaskBody } from '../runs/run.schemas.js';
import {
  acceptInvitationBody,
  changeRoleBody,
  createdInvitationView,
  createWorkspaceBody,
  inviteBody,
  invitationView,
  memberView,
  updateWorkspaceBody,
  workspaceView,
} from '../workspaces/workspaces.schemas.js';

export type Method = 'get' | 'post' | 'patch' | 'delete';

export interface RouteDoc {
  method: Method;
  /** OpenAPI path relative to /api/v1, with {param} placeholders. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  public?: boolean;
  status: 200 | 201 | 202 | 204 | 302;
  body?: ZodType;
  query?: ZodType;
  response?: ZodType;
  paginated?: boolean;
  idempotency?: 'optional' | 'required';
  sse?: boolean;
  /** Accepts `X-Workspace-Id` as an alternative to an explicit `workspace_id` (GAP-02). */
  workspaceHeader?: boolean;
}

const runId = { description: 'Run id' };
void runId;

/**
 * Every public API route. `openapi.spec.ts` fails if a Nest route is missing
 * here or a documented route does not exist, so the spec cannot drift.
 * Request schemas are the same Zod schemas used for runtime validation.
 */
export const ROUTES: RouteDoc[] = [
  // Health
  { method: 'get', path: '/health/live', tag: 'Health', summary: 'Liveness', public: true, status: 200 },
  { method: 'get', path: '/internal/metrics', tag: 'Health', summary: 'Prometheus metrics (requires METRICS_TOKEN bearer; 404 when disabled)', public: true, status: 200 },
  { method: 'get', path: '/health/ready', tag: 'Health', summary: 'Readiness (503 when Postgres or Redis is unavailable)', public: true, status: 200 },

  // Auth
  { method: 'get', path: '/auth/providers', tag: 'Auth', summary: 'Available sign-in methods', public: true, status: 200 },
  { method: 'post', path: '/auth/dev-login', tag: 'Auth', summary: 'Development-only sign-in (404 when disabled)', public: true, status: 200, body: devLoginBody },
  { method: 'get', path: '/auth/github/login', tag: 'Auth', summary: 'Start GitHub sign-in (browser navigation; 302)', public: true, status: 302 },
  { method: 'get', path: '/auth/github/callback', tag: 'Auth', summary: 'GitHub OAuth callback (302 to the web app)', public: true, status: 302, query: callbackQuery },
  { method: 'get', path: '/auth/csrf', tag: 'Auth', summary: 'Rotate and return the CSRF token', status: 200 },
  { method: 'post', path: '/auth/logout', tag: 'Auth', summary: 'Sign out and revoke the session', status: 204 },
  { method: 'get', path: '/auth/sessions', tag: 'Auth', summary: "List the caller's active sessions", status: 200 },
  { method: 'delete', path: '/auth/sessions/{sessionId}', tag: 'Auth', summary: 'Revoke one of your sessions', status: 204 },
  { method: 'get', path: '/me', tag: 'Identity', summary: 'Current user and memberships', status: 200 },

  // Workspaces
  { method: 'get', path: '/workspaces', tag: 'Workspaces', summary: 'List accessible workspaces', status: 200, response: z.array(workspaceView) },
  { method: 'post', path: '/workspaces', tag: 'Workspaces', summary: 'Create workspace (caller becomes owner)', status: 201, body: createWorkspaceBody, response: workspaceView, idempotency: 'optional' },
  { method: 'get', path: '/workspaces/{workspaceId}', tag: 'Workspaces', summary: 'Workspace details', status: 200, response: workspaceView },
  { method: 'patch', path: '/workspaces/{workspaceId}', tag: 'Workspaces', summary: 'Update workspace settings (admin+)', status: 200, body: updateWorkspaceBody, response: workspaceView },
  { method: 'get', path: '/workspaces/{workspaceId}/members', tag: 'Workspaces', summary: 'List members', status: 200, query: paginationQuery, response: z.array(memberView), paginated: true },
  { method: 'patch', path: '/workspaces/{workspaceId}/members/{userId}', tag: 'Workspaces', summary: 'Change a member role', status: 200, body: changeRoleBody, response: memberView },
  { method: 'delete', path: '/workspaces/{workspaceId}/members/{userId}', tag: 'Workspaces', summary: 'Remove a member (or leave)', status: 204 },
  { method: 'post', path: '/workspaces/{workspaceId}/invitations', tag: 'Workspaces', summary: 'Invite member (token returned once)', status: 201, body: inviteBody, response: createdInvitationView, idempotency: 'optional' },
  { method: 'get', path: '/workspaces/{workspaceId}/invitations', tag: 'Workspaces', summary: 'List invitations (admin+)', status: 200, response: z.array(invitationView) },
  { method: 'delete', path: '/workspaces/{workspaceId}/invitations/{invitationId}', tag: 'Workspaces', summary: 'Revoke a pending invitation', status: 204 },
  { method: 'post', path: '/invitations/accept', tag: 'Workspaces', summary: 'Accept an invitation (email must match)', status: 200, body: acceptInvitationBody, response: workspaceView },
  { method: 'get', path: '/workspaces/{workspaceId}/audit-events', tag: 'Audit', summary: 'Audit history (admin+)', status: 200, query: auditQuery, paginated: true },

  // GitHub
  { method: 'get', path: '/integrations/github/install-url', tag: 'GitHub', summary: 'GitHub App install URL with a bound single-use state', status: 200, query: workspaceQuery, workspaceHeader: true },
  { method: 'post', path: '/integrations/github/complete', tag: 'GitHub', summary: 'Complete the installation handshake', status: 200, body: completeInstallationBody },
  { method: 'get', path: '/integrations/github/installations', tag: 'GitHub', summary: 'List connected installations', status: 200, query: workspaceQuery, workspaceHeader: true },
  { method: 'get', path: '/integrations/github/installations/{id}/repositories', tag: 'GitHub', summary: 'Repositories granted by an installation', status: 200, query: availableReposQuery },
  { method: 'delete', path: '/integrations/github/installations/{id}', tag: 'GitHub', summary: 'Disconnect installation', status: 204 },
  { method: 'post', path: '/webhooks/github', tag: 'GitHub', summary: 'Receive signed GitHub webhooks (HMAC on raw body)', public: true, status: 202 },

  // Repositories & indexing
  { method: 'get', path: '/repositories', tag: 'Repositories', summary: 'List repositories', status: 200, query: listRepositoriesQuery, paginated: true, workspaceHeader: true },
  { method: 'post', path: '/repositories', tag: 'Repositories', summary: 'Register a repository from an installation', status: 201, body: createRepositoryBody, idempotency: 'optional', workspaceHeader: true },
  { method: 'get', path: '/repositories/{repositoryId}', tag: 'Repositories', summary: 'Repository details', status: 200 },
  { method: 'patch', path: '/repositories/{repositoryId}', tag: 'Repositories', summary: 'Update repository settings (admin+)', status: 200, body: updateRepositoryBody },
  { method: 'delete', path: '/repositories/{repositoryId}', tag: 'Repositories', summary: 'Disconnect repository and delete index data', status: 204 },
  { method: 'post', path: '/repositories/{repositoryId}/index', tag: 'Indexing', summary: 'Queue indexing (coalesces with an active job)', status: 202, body: queueIndexBody, idempotency: 'optional' },
  { method: 'get', path: '/repositories/{repositoryId}/index-status', tag: 'Indexing', summary: 'Index status, coverage and limitations', status: 200 },
  { method: 'get', path: '/repositories/{repositoryId}/snapshots', tag: 'Indexing', summary: 'Indexed snapshots', status: 200, query: paginationQuery, paginated: true },
  { method: 'get', path: '/repositories/{repositoryId}/tree', tag: 'Indexing', summary: 'Directory listing at an indexed commit', status: 200, query: treeQuery },
  { method: 'get', path: '/repositories/{repositoryId}/files/content', tag: 'Indexing', summary: 'File content at an indexed commit (citations)', status: 200, query: fileQuery },
  { method: 'post', path: '/repositories/{repositoryId}/search', tag: 'Indexing', summary: 'Hybrid lexical + semantic search', status: 200, body: searchBody },

  // Code intelligence (GAP-15)
  { method: 'get', path: '/repositories/{repositoryId}/symbols', tag: 'Code intelligence', summary: 'Search parsed symbols (keyset pagination by name)', status: 200, query: symbolsQuery, paginated: true },
  { method: 'get', path: '/repositories/{repositoryId}/symbols/{symbolId}', tag: 'Code intelligence', summary: 'Symbol with outgoing and incoming references', status: 200, query: symbolDetailQuery },
  { method: 'get', path: '/repositories/{repositoryId}/dependency-map', tag: 'Code intelligence', summary: 'File-level import graph with external packages', status: 200, query: dependencyMapQuery },
  { method: 'get', path: '/repositories/{repositoryId}/symbols/{symbolId}/call-graph', tag: 'Code intelligence', summary: 'Callers/callees of a symbol (bounded depth, offset-paged nodes)', status: 200, query: callGraphQuery, response: callGraphView },
  {
    method: 'post',
    path: '/repositories/{repositoryId}/impact',
    tag: 'Code intelligence',
    summary: 'Heuristic change-impact prediction and test selection for changed files',
    description: 'Static analysis over parsed imports and name-resolved calls. Labelled heuristic: it is never a verification result.',
    status: 200,
    body: impactBody,
    response: impactView,
  },
  { method: 'get', path: '/runs/{runId}/impact', tag: 'Code intelligence', summary: "Heuristic impact and test selection for a run's patch (or plan files)", status: 200, query: runImpactQuery, response: runImpactView },

  // Workspace knowledge (cross-repository)
  { method: 'post', path: '/workspaces/{workspaceId}/search', tag: 'Knowledge', summary: 'Search all indexed repositories of the workspace (per-result repository provenance)', status: 200, body: workspaceSearchBody, response: workspaceSearchView },
  { method: 'post', path: '/workspaces/{workspaceId}/questions', tag: 'AI', summary: 'Grounded Q&A over evidence from all indexed repositories of the workspace', status: 200, body: workspaceAskBody, response: workspaceAnswerView },

  // Workflow templates
  { method: 'get', path: '/workspaces/{workspaceId}/templates', tag: 'Templates', summary: 'Built-in and workspace workflow templates', status: 200, query: listTemplatesQuery, response: z.array(templateView) },
  { method: 'post', path: '/workspaces/{workspaceId}/templates', tag: 'Templates', summary: 'Create a workspace template (admin+, audited)', status: 201, body: createTemplateBody, response: templateView, idempotency: 'optional' },
  { method: 'patch', path: '/workspaces/{workspaceId}/templates/{templateId}', tag: 'Templates', summary: 'Update or archive a workspace template (admin+, audited)', status: 200, body: updateTemplateBody, response: templateView },
  { method: 'delete', path: '/workspaces/{workspaceId}/templates/{templateId}', tag: 'Templates', summary: 'Archive a workspace template (admin+, audited)', status: 204 },

  // AI
  { method: 'post', path: '/repositories/{repositoryId}/questions', tag: 'AI', summary: 'Grounded repository question (code and knowledge-note evidence; saved to history)', status: 200, body: askBody },
  { method: 'get', path: '/repositories/{repositoryId}/questions', tag: 'AI', summary: "The caller's own question history, newest first", status: 200, query: paginationQuery, paginated: true },
  { method: 'get', path: '/questions/{questionId}', tag: 'AI', summary: 'One of your saved questions', status: 200 },
  { method: 'delete', path: '/questions/{questionId}', tag: 'AI', summary: 'Delete one of your saved questions', status: 204 },
  { method: 'get', path: '/workspaces/{workspaceId}/ai-policy', tag: 'AI', summary: 'Read provider policy', status: 200 },
  { method: 'patch', path: '/workspaces/{workspaceId}/ai-policy', tag: 'AI', summary: 'Update provider policy (admin+)', status: 200, body: updateAiPolicyBody },
  { method: 'post', path: '/ai/providers/health-check', tag: 'AI', summary: 'Check a provider permitted by policy', status: 200, body: healthCheckBody, workspaceHeader: true },
  { method: 'get', path: '/workspaces/{workspaceId}/usage', tag: 'AI', summary: 'Usage summary', status: 200, query: usageQuery },

  // Knowledge
  { method: 'get', path: '/repositories/{repositoryId}/knowledge', tag: 'Knowledge', summary: 'List knowledge documents', status: 200, query: listKnowledgeQuery, paginated: true },
  { method: 'post', path: '/repositories/{repositoryId}/knowledge', tag: 'Knowledge', summary: 'Add engineering note/document', status: 201, body: createKnowledgeBody, idempotency: 'optional' },
  { method: 'get', path: '/knowledge/{documentId}', tag: 'Knowledge', summary: 'Get knowledge document', status: 200 },
  { method: 'delete', path: '/knowledge/{documentId}', tag: 'Knowledge', summary: 'Remove document (author or admin)', status: 204 },

  // Tasks & runs
  { method: 'post', path: '/repositories/{repositoryId}/tasks', tag: 'Tasks', summary: 'Create task (manual or GitHub issue)', status: 201, body: createTaskBody, idempotency: 'optional' },
  { method: 'get', path: '/tasks', tag: 'Tasks', summary: 'List tasks (with repository_full_name and latest_run)', status: 200, query: listTasksQuery, paginated: true, workspaceHeader: true },
  { method: 'get', path: '/tasks/{taskId}', tag: 'Tasks', summary: 'Task detail', status: 200 },
  { method: 'patch', path: '/tasks/{taskId}', tag: 'Tasks', summary: 'Update task metadata', status: 200, body: updateTaskBody },
  { method: 'post', path: '/tasks/{taskId}/runs', tag: 'Runs', summary: 'Start workflow run (budgets clamped to policy)', status: 202, body: startRunBody, idempotency: 'optional' },
  { method: 'get', path: '/tasks/{taskId}/runs', tag: 'Runs', summary: 'List task runs', status: 200, query: paginationQuery, paginated: true },
  { method: 'get', path: '/runs', tag: 'Runs', summary: 'List workspace runs (repeat status= to filter by several)', status: 200, query: listRunsQuery, paginated: true, workspaceHeader: true },
  { method: 'get', path: '/runs/{runId}', tag: 'Runs', summary: 'Run detail (with approvals and pull_request)', status: 200 },
  { method: 'get', path: '/runs/{runId}/events', tag: 'Runs', summary: 'SSE event stream with Last-Event-ID replay', status: 200, query: sseQuery, sse: true },
  { method: 'post', path: '/runs/{runId}/cancel', tag: 'Runs', summary: 'Cancel run', status: 200, body: cancelBody },
  { method: 'post', path: '/runs/{runId}/retry', tag: 'Runs', summary: 'Retry a failed/timed-out/cancelled run', status: 202, idempotency: 'optional' },
  { method: 'get', path: '/runs/{runId}/steps', tag: 'Runs', summary: 'Agent step history with tool calls', status: 200 },
  { method: 'get', path: '/runs/{runId}/artifacts', tag: 'Runs', summary: 'Artifact list', status: 200 },
  { method: 'get', path: '/runs/{runId}/plan', tag: 'Plan', summary: 'Current plan, investigation and approval', status: 200 },
  { method: 'patch', path: '/runs/{runId}/plan', tag: 'Plan', summary: 'Edit plan before approval (new version)', status: 200, body: editPlanBody },
  { method: 'post', path: '/runs/{runId}/plan-approval', tag: 'Plan', summary: 'Approve/reject the plan (bound to plan_hash)', status: 200, body: planApprovalBody, idempotency: 'optional' },

  // Review & PR
  { method: 'get', path: '/runs/{runId}/diff', tag: 'Review', summary: 'Unified diff and changed files', status: 200 },
  { method: 'get', path: '/runs/{runId}/verification', tag: 'Review', summary: 'Deterministic verification results', status: 200 },
  { method: 'get', path: '/runs/{runId}/review', tag: 'Review', summary: 'Review findings (deterministic vs AI)', status: 200 },
  { method: 'post', path: '/runs/{runId}/findings/{findingId}/disposition', tag: 'Review', summary: 'Accept/dismiss/fix a finding', status: 200, body: dispositionBody },
  { method: 'post', path: '/runs/{runId}/pr-approval', tag: 'Review', summary: 'Approve/reject PR creation (bound to patch_hash)', status: 200, body: prApprovalBody, idempotency: 'optional' },
  { method: 'post', path: '/runs/{runId}/pull-request', tag: 'Review', summary: 'Create the pull request after approval', status: 201, body: pullRequestBody, idempotency: 'required' },
];

const RESPONSES = extendExistingResponses(DERIVED);

// I-8: every JSON route gets a response schema. Hand-written schemas win; the rest
// are derived from real responses (scripts/derive-response-schemas.mjs) and
// enforced at test time by test/response-contract.ts.
const taskDetail = RESPONSES['get /tasks/{taskId}'] as z.ZodObject;
const derived: Record<string, ZodType> = {
  // PATCH returns the task without the joined repository name and latest run.
  'patch /tasks/{taskId}': taskDetail.omit({ repository_full_name: true, latest_run: true }),
};
for (const r of ROUTES) r.response ??= refine(`${r.method} ${r.path}`, derived[`${r.method} ${r.path}`] ?? RESPONSES[`${r.method} ${r.path}`]);

/** Shapes referenced from docs (not request validation). */
export const SCHEMA_COMPONENTS: Record<string, ZodType> = { Plan: planSchema };
