# ANVAYA — API Contract

**Base path:** `/api/v1`  
**Transport:** HTTPS REST + Server-Sent Events  
**Format:** JSON  
**Contract authority:** This document defines public application API behavior. Internal worker/AI contracts are versioned separately.

## 1. API standards

### Authentication
Use secure HttpOnly session cookies or bearer tokens according to the selected identity implementation. Cookie-based sessions require CSRF protection. The browser never receives GitHub App private keys or hosted model secrets.

### Headers
- `Content-Type: application/json`
- `X-Request-Id: <uuid>` optional correlation ID.
- `Idempotency-Key: <opaque-unique-key>` for non-idempotent creation/side-effect endpoints.

### Success envelope
```json
{
  "data": {},
  "meta": {
    "request_id": "req_123"
  }
}
```

### Error envelope
```json
{
  "error": {
    "code": "INVALID_STATE_TRANSITION",
    "message": "This action is not available in the current run state.",
    "details": {}
  },
  "meta": {
    "request_id": "req_123"
  }
}
```

Never expose stack traces, secrets, internal host paths, raw provider payloads, or sensitive sandbox output in error responses.

### Pagination
Cursor pagination:
`?limit=25&cursor=<opaque>`

### Idempotency
Persist idempotency key, actor, workspace, endpoint, request hash, and result. Reuse with a different request body returns `409 Conflict`.

## 2. Identity and workspaces

| Method | Endpoint | Description |
|---|---|---|
| GET | `/me` | Current user and memberships |
| GET | `/workspaces` | List accessible workspaces |
| POST | `/workspaces` | Create workspace |
| GET | `/workspaces/:workspaceId` | Workspace details |
| PATCH | `/workspaces/:workspaceId` | Update workspace settings |
| GET | `/workspaces/:workspaceId/members` | List members |
| POST | `/workspaces/:workspaceId/invitations` | Invite member |
| PATCH | `/workspaces/:workspaceId/members/:userId` | Change role |
| DELETE | `/workspaces/:workspaceId/members/:userId` | Remove member |

Every endpoint enforces membership and role authorization.

## 3. Git integrations and repositories

| Method | Endpoint | Description |
|---|---|---|
| GET | `/integrations/github/installations` | List connected installations |
| POST | `/integrations/github/complete` | Complete installation handshake |
| DELETE | `/integrations/github/installations/:id` | Disconnect installation |
| POST | `/webhooks/github` | Receive signed webhooks |
| GET | `/repositories` | List repositories |
| POST | `/repositories` | Register/select repository |
| GET | `/repositories/:repositoryId` | Repository details |
| PATCH | `/repositories/:repositoryId` | Update repository settings |
| DELETE | `/repositories/:repositoryId` | Disconnect repository |
| POST | `/repositories/:repositoryId/index` | Queue indexing |
| GET | `/repositories/:repositoryId/index-status` | Index status and coverage |
| GET | `/repositories/:repositoryId/tree` | File tree |
| POST | `/repositories/:repositoryId/search` | Hybrid search |
| GET | `/repositories/:repositoryId/snapshots` | Indexed snapshots |

### Search request
```json
{
  "query": "Where is refresh token expiry handled?",
  "snapshot": "latest",
  "top_k": 8,
  "filters": {
    "languages": ["typescript"],
    "paths": ["src/auth/"]
  }
}
```

### Search response
```json
{
  "data": {
    "results": [
      {
        "file_path": "src/auth/token.ts",
        "start_line": 24,
        "end_line": 51,
        "commit_sha": "abc123",
        "content_hash": "sha256:...",
        "snippet": "...",
        "lexical_score": 0.71,
        "semantic_score": 0.84
      }
    ]
  }
}
```

## 4. Repository Q&A and knowledge

| Method | Endpoint | Description |
|---|---|---|
| POST | `/repositories/:repositoryId/questions` | Ask grounded repository question |
| GET | `/repositories/:repositoryId/knowledge` | List indexed knowledge sources |
| POST | `/repositories/:repositoryId/knowledge` | Add engineering note/document |
| GET | `/knowledge/:documentId` | Get knowledge document |
| DELETE | `/knowledge/:documentId` | Remove document |

Question response must include:
- Answer.
- Citation list with path, line range, commit SHA, and content hash.
- Provider/model and local/cloud mode.
- Retrieval metadata suitable for diagnostics.
- Explicit evidence limitations when applicable.

## 5. Tasks and workflow runs

| Method | Endpoint | Description |
|---|---|---|
| POST | `/repositories/:repositoryId/tasks` | Create task |
| GET | `/tasks` | List tasks |
| GET | `/tasks/:taskId` | Task detail |
| PATCH | `/tasks/:taskId` | Update task metadata |
| POST | `/tasks/:taskId/runs` | Start workflow run |
| GET | `/tasks/:taskId/runs` | List task runs |
| GET | `/runs/:runId` | Run detail |
| GET | `/runs/:runId/events` | SSE event stream |
| POST | `/runs/:runId/cancel` | Cancel run |
| POST | `/runs/:runId/retry` | Retry eligible run |
| GET | `/runs/:runId/steps` | Agent step history |
| GET | `/runs/:runId/artifacts` | Artifact list |

### Create task
```json
{
  "source_type": "manual",
  "title": "Handle expired access tokens",
  "description": "Investigate and correct the token refresh behavior."
}
```

### Start run
```json
{
  "mode": "local",
  "base_branch": "main",
  "budgets": {
    "max_steps": 8,
    "max_input_tokens": 12000,
    "max_output_tokens": 4000,
    "max_duration_seconds": 900,
    "max_changed_files": 8,
    "max_repair_attempts": 1
  }
}
```

The server clamps all budgets to workspace policy. A client cannot increase its own maximums.

## 6. Plan, diff, verification, and review

| Method | Endpoint | Description |
|---|---|---|
| GET | `/runs/:runId/plan` | Get proposed plan |
| PATCH | `/runs/:runId/plan` | Edit plan before approval |
| POST | `/runs/:runId/plan-approval` | Approve/reject plan |
| GET | `/runs/:runId/diff` | Unified diff and changed files |
| GET | `/runs/:runId/verification` | Test/build/scanner results |
| GET | `/runs/:runId/review` | Review findings |
| POST | `/runs/:runId/findings/:findingId/disposition` | Accept/dismiss/fix finding |
| POST | `/runs/:runId/pr-approval` | Approve/reject PR creation |
| POST | `/runs/:runId/pull-request` | Create PR after approval |

Plan approval:
```json
{
  "decision": "approved",
  "comment": "Proceed with this implementation scope."
}
```

PR creation:
```json
{
  "title": "Fix expired access token refresh",
  "body": "Summary, implementation notes, and verification evidence.",
  "base_branch": "main"
}
```

Server must verify:
- Authenticated actor and workspace role.
- Repository still connected and authorized.
- Run state is eligible.
- PR approval exists and is valid.
- Patch is the reviewed patch and has not changed since approval.
- Idempotency key has not already produced a PR.
- Provider permissions are sufficient.

## 7. AI provider and policy endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/workspaces/:workspaceId/ai-policy` | Read provider policy |
| PATCH | `/workspaces/:workspaceId/ai-policy` | Update provider policy |
| POST | `/ai/providers/health-check` | Check permitted provider |
| GET | `/workspaces/:workspaceId/usage` | Usage summary |
| GET | `/workspaces/:workspaceId/audit-events` | Audit history |

Never return API keys or secret values. A provider change must record actor, time, policy, and data-handling mode.

## 8. SSE event contract

Endpoint: `GET /runs/:runId/events`

Events:
- `run.created`
- `run.status.changed`
- `run.stage.changed`
- `retrieval.completed`
- `agent.started`
- `agent.completed`
- `agent.failed`
- `tool.started`
- `tool.completed`
- `patch.proposed`
- `sandbox.started`
- `verification.completed`
- `review.finding.created`
- `approval.required`
- `pull_request.created`
- `run.completed`
- `run.failed`
- `run.cancelled`

Example:
```text
event: run.stage.changed
id: event_123
data: {"run_id":"uuid","stage":"verifying","timestamp":"2026-11-02T10:00:00Z"}
```

Support reconnect/replay using event IDs. Never stream secrets or unrestricted raw logs.

## 9. Status codes

- `200` successful read/update.
- `201` resource created.
- `202` asynchronous job accepted.
- `204` successful deletion.
- `400` malformed request.
- `401` unauthenticated.
- `403` unauthorized.
- `404` not found or intentionally concealed.
- `409` state/idempotency conflict.
- `413` payload too large.
- `422` semantic/schema validation error.
- `429` rate or budget limit.
- `502` upstream provider failure.
- `503` provider/service unavailable.
- `504` upstream timeout.

## 10. API security and operational requirements

- Validate all inputs at the boundary.
- Enforce authorization in service methods.
- Use rate limits for login, search, task creation, and AI endpoints.
- Apply payload and upload limits.
- Verify webhook signature against raw body.
- Use CSRF protection for cookie sessions.
- Restrict CORS.
- Redact sensitive values from logs.
- Never expose arbitrary shell command execution.
- Use server-generated execution profile IDs.
- Require idempotency for external side effects.
- Return request IDs for support and debugging.
