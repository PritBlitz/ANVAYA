# API Contract Notes (backend → frontend)

`API_SPEC.md` is the contract. This file records **how the backend implements it**,
**clarifications the spec leaves open**, and **proposed additions**. Items marked
**PROPOSAL** need frontend acknowledgement; until then the backend implements them as
described here and will not change them without notice.

Base URL: `http://localhost:3001/api/v1` (local). Machine-readable spec:
`apps/api/openapi.json` (generated; see README).

## 1. Envelope, errors, pagination

Success (API_SPEC §1):
```json
{ "data": { }, "meta": { "request_id": "req_…" } }
```

Lists use cursor pagination. **Clarification:** list `data` is an **array**, and the
cursor lives in `meta.page`:
```json
{
  "data": [ { } ],
  "meta": { "request_id": "req_…", "page": { "next_cursor": "eyJ1cyI6…", "has_more": true } }
}
```
Request the next page with `?limit=25&cursor=<next_cursor>` (`limit` 1–100, default 25).
Cursors are opaque; a malformed cursor returns `422 VALIDATION_FAILED`.

Errors (API_SPEC §1): `{ "error": { "code", "message", "details" }, "meta": { "request_id" } }`.

| Status | `error.code` values the UI should handle |
|---|---|
| 400 | `BAD_REQUEST` (malformed JSON, bad header) |
| 401 | `UNAUTHENTICATED` → redirect to sign-in |
| 403 | `FORBIDDEN` (member with insufficient role), `CSRF_TOKEN_INVALID` (refresh via `GET /auth/csrf` and retry once) |
| 404 | `NOT_FOUND` — also returned for resources in workspaces you are not a member of (existence is concealed) |
| 409 | `INVALID_STATE_TRANSITION`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_REQUEST_IN_PROGRESS`, `SLUG_TAKEN`, `LAST_OWNER`, `ALREADY_MEMBER`, `INVITATION_PENDING`, `EMAIL_IN_USE` |
| 413 | `PAYLOAD_TOO_LARGE` (JSON bodies are capped at 1 MB) |
| 422 | `VALIDATION_FAILED` with `details.issues: [{ path, message, code }]`; `IDEMPOTENCY_KEY_REQUIRED` |
| 429 | `RATE_LIMITED` (+ `Retry-After` header, `details.retry_after_seconds`), `BUDGET_EXCEEDED` |
| 502/503/504 | upstream/provider/integration failures, e.g. `INTEGRATION_NOT_CONFIGURED`, `PROVIDER_UNAVAILABLE` |

Request bodies are **strict**: unknown fields are rejected with 422.
All timestamps are ISO-8601 UTC strings. All ids are UUIDs.

## 2. Authentication (PROPOSAL — the spec leaves the identity mechanism open)

Cookie sessions (API_SPEC §1 permits this):
- `anvaya_session` — HttpOnly, SameSite=Lax, Secure in production. Opaque; never readable by JS.
- `anvaya_csrf` — readable by JS. **Every** `POST`/`PATCH`/`DELETE` must send header
  `X-CSRF-Token: <value of anvaya_csrf cookie>`. Missing/wrong → `403 CSRF_TOKEN_INVALID`.
- Use `fetch(..., { credentials: 'include' })`. CORS allows only origins in `WEB_ORIGINS`.

Endpoints added under `/auth`:

| Method | Path | Notes |
|---|---|---|
| GET | `/auth/providers` | `{ github: boolean, dev: boolean }` — which sign-in buttons to render. Public. |
| GET | `/auth/github/login?return_to=/app/...` | Browser navigation (not fetch). 302 to GitHub; on success returns to `WEB_APP_URL` + `return_to` (same-origin relative paths only; anything else → `/app`), on failure to `WEB_APP_URL/login?error=oauth_failed|email_in_use`. The OAuth redirect URI is `PUBLIC_API_URL/api/v1/auth/github/callback`: set `PUBLIC_API_URL` to the web origin when the web app proxies `/api/v1` (cookies are host-only, `Path=/`, no `Domain`). |
| GET | `/auth/github/callback` | GitHub redirect target. Not called by the UI. |
| POST | `/auth/dev-login` | `{ email, display_name? }` → `{ user, csrf_token, expires_at }`. **Development only**; 404 when disabled. Must be `Content-Type: application/json`. |
| GET | `/auth/csrf` | Rotates and returns `{ csrf_token }` (also re-sets the cookie). |
| POST | `/auth/logout` | 204; clears cookies and revokes the session server-side. |
| GET | `/auth/sessions` | Caller's active sessions `[{ id, current, ip_address, user_agent, created_at, last_seen_at, expires_at }]`. |
| DELETE | `/auth/sessions/:sessionId` | 204; revoke one of your sessions (FR-ID-007). |

## 3. Workspaces = organizations

The API says "workspace"; the database table is `organizations`. Same entity, same id.

`GET /me` →
```json
{ "user": { "id", "email", "display_name", "avatar_url", "created_at" },
  "memberships": [ { "workspace_id", "workspace_name", "workspace_slug", "role" } ] }
```

Workspace object: `{ id, name, slug, plan_key, role, settings, created_at, updated_at }` where
`role` is the **caller's** role and `settings` is
`{ retention?: { snapshot_days?, run_artifact_days?, log_days? }, run_budget_limits?: { max_steps?, max_input_tokens?, max_output_tokens?, max_duration_seconds?, max_changed_files?, max_repair_attempts? } }`.

- `POST /workspaces` `{ name, slug? }` → 201. Caller becomes `owner`.
- `PATCH /workspaces/:id` `{ name?, settings? }` (admin+). Settings are merged per section.
- `GET /workspaces/:id/members` (paginated) → `[{ user_id, email, display_name, avatar_url, role, joined_at }]`.
- `PATCH /workspaces/:id/members/:userId` `{ role }`; `DELETE` same path (204; a user may remove themselves = leave).

Role rules enforced server-side (render controls accordingly, but never rely on hiding):
- viewer: read only. member: read + create tasks/runs/questions. admin: manage settings, members/viewers, invitations, integrations. owner: everything incl. admins/owners.
- Only owners can grant/revoke `owner`, modify admins, or invite admins.
- The last owner cannot be demoted or removed (`409 LAST_OWNER`).

### Invitations (AGREED, GAP-17 — spec only defines `POST /invitations`)
- `POST /workspaces/:id/invitations` `{ email, role: admin|member|viewer }` → 201
  `{ id, email, role, status, expires_at, created_at, token, accept_url }`.
  **`token`/`accept_url` are returned once** (no email delivery yet); the inviter shares the link.
  `accept_url` = `WEB_APP_URL/invitations/accept#token=…` (fragment, so it never hits server logs).
- Invitation `status`: `pending|accepted|revoked|expired`.
- `GET /workspaces/:id/invitations` (admin+), `DELETE /workspaces/:id/invitations/:invitationId` (204).
- `POST /invitations/accept` `{ token }` → 200 workspace object. The signed-in user's email must
  equal the invited email (`403` otherwise). Tokens expire after 7 days and are single-use.

## 4. Tenant selection on collection endpoints (AGREED with frontend, 2026-11-02; GAP-02)

`GET /repositories`, `POST /repositories`, `GET /tasks`, `GET /runs`,
`GET /integrations/github/install-url`, `GET /integrations/github/installations` and
`POST /ai/providers/health-check` have no workspace in the path. Send either the
**`X-Workspace-Id: <uuid>`** header or `workspace_id` (query param for GET, body field for POST).
- Both sent and different → `400 WORKSPACE_MISMATCH`. Neither → `422` (`details.issues[0].path = "workspace_id"`). Malformed header → `422`.
- The header only *selects*; membership is always re-verified (non-members get `404`).
- Resource endpoints (`/repositories/:id`, `/tasks/:id`, `/runs/:id`, …) ignore the header and derive the workspace from the resource.
- `POST /integrations/github/complete` ignores the header: the server-held `state` is the only binding.

## 5. Idempotency

Send `Idempotency-Key: <8–255 chars [A-Za-z0-9._:-]>` on creation/side-effect POSTs. A retry
with the same key and body replays the stored response (header `Idempotent-Replayed: true`).
Same key + different body → `409 IDEMPOTENCY_KEY_REUSED`. Failed requests are not stored, so
retrying a failure with the same key is safe. Keys are scoped per user and endpoint, kept 24 h.
`POST /runs/:runId/pull-request` will **require** the header (`422 IDEMPOTENCY_KEY_REQUIRED`).

## 6. Audit

`GET /workspaces/:id/audit-events` (admin+, paginated). Filters: `action`, `actor_user_id`,
`resource_type`, `resource_id`, `from`, `to` (ISO). Items:
`{ id, actor_type, actor_user_id, actor_email, action, resource_type, resource_id, request_id, metadata, created_at }`.

## 7. Repository intelligence and AI

### Indexing
- `POST /repositories/:id/index` `{ ref? }` → **202** `{ indexing_job_id, status, trigger, requested_ref, coalesced, created_at }` (member+). Repeated requests coalesce into the active job.
- `GET /repositories/:id/index-status` → `{ indexing_status, latest_snapshot{commit_sha,status,parser_version,chunker_version,embedding_model,limitations}, coverage{total_files,indexed_files,excluded_files,failed_files,reused_files,excluded_by_reason,parse_status,languages,chunks,embedded_chunks}, active_job, last_job, supported_parsers }`. Poll this while `active_job` is non-null.
- `indexing_status`: `pending|queued|indexing|ready|partial|failed|disabled`. **`partial` means searchable with stated limitations** (e.g. embeddings unavailable → lexical only); show `latest_snapshot.limitations`.
- `GET /repositories/:id/tree?snapshot=latest&path=src` → `{ snapshot_id, commit_sha, path, entries: [{type:'directory',name,path,file_count} | {type:'file',name,path,language,parse_status,excluded,exclusion_reason,byte_size,line_count}], truncated }`.
- **AGREED (GAP-04)** `GET /repositories/:id/files/content?path=&commit_sha=&start_line=&end_line=` (`snapshot=latest|<sha>` also accepted; `commit_sha` wins and must match `snapshot` if both are sent) → `{ path, commit_sha, content_hash, language, parse_status, line_count, start_line, end_line, truncated, content }` (≤2000 lines per request; `truncated` is true when the requested range was cut). Excluded file → `403 FILE_EXCLUDED` with `details.reason`; invalid/traversal path → `400`; unknown file → `404`. Use this to open citations.
- Shapes (R6): `coverage.languages` = `{ [language]: { files, parsed } }` (`unknown` for unclassified). Job `stage`: `resolving_commit|fetching|processing_files|embedding|resolving_relationships` (null when queued/finished). Job `progress` (grows as stages run; every key optional): `{ files_total, files_processed, files_reused, chunks_embedded }`. Job `status`: `queued|running|retry_scheduled|completed|failed|cancelled`.

### Search — `POST /repositories/:id/search`
Request as API_SPEC plus optional `mode: hybrid|lexical|semantic`. Response
`data: { results: [{ chunk_id, file_path, start_line, end_line, commit_sha, content_hash, chunk_hash, language, symbol_name, snippet, lexical_score, semantic_score, score }], retrieval: { snapshot_id, commit_sha, snapshot_status, lexical, semantic: ok|unavailable|disabled, semantic_reason, embedding_model, … } }`.
`content_hash` is the **file** hash at that commit (stale-citation detection). Scores may be `null` when that retriever did not match.

### Questions — `POST /repositories/:id/questions`
Request `{ question, snapshot?='latest', mode?: local|mock|cloud, top_k?=8, filters? }` (viewer+, 30/min). Response:
```json
{ "answer": "…", "insufficient_evidence": false,
  "citations": [{ "evidence_id", "path", "start_line", "end_line", "commit_sha", "content_hash", "symbol", "supports" }],
  "limitations": ["…"], "provider": "ollama", "model": "…", "mode": "local", "prompt_version": "repository_qa.v1",
  "data_disclosure": null, "retrieval": { …, "result_count": 8, "evidence_included": ["…"] },
  "usage": { "input_tokens", "output_tokens", "duration_ms", "schema_repair_attempted" } }
```
- Citations come from server-side retrieval records, never model text. When no evidence is found the model is not called (`provider: null`, `insufficient_evidence: true`).
- Errors: `403` mode not allowed by policy; `503 PROVIDER_UNAVAILABLE|PROVIDER_NOT_CONFIGURED|MODEL_NOT_AVAILABLE` (no fallback is ever attempted — show this to the user); `504 PROVIDER_TIMEOUT`; `502 INVALID_MODEL_OUTPUT`; `429 BUDGET_EXCEEDED`.
- Local CPU inference can take tens of seconds; show progress UI.
- When `mode === 'cloud'`, `data_disclosure: { provider, data_categories }` must be shown.

### AI policy — `GET/PATCH /workspaces/:id/ai-policy`
`{ default_mode, allowed_modes, cloud: { enabled, provider, model, data_categories[] }, limits: { max_input_tokens, max_output_tokens, request_timeout_seconds } }`. PATCH is admin+ and merges per section. Enabling cloud requires `acknowledge_data_disclosure: true`, otherwise `422 DATA_DISCLOSURE_REQUIRED` with `details.{provider,data_categories}` — render these in the confirmation dialog. `data_categories ⊂ source_code|documentation|issue_text|diffs|test_output`.
`POST /ai/providers/health-check { workspace_id, mode? }` → `{ mode, provider, available, models, detail, checked_at }`.
`GET /workspaces/:id/usage?from&to` (member+, default last 30 days) → `{ period, totals, local_vs_hosted, by_provider, by_operation }`.

### Usage — `GET /workspaces/:id/usage?from=&to=` (member+)
Default period: last 30 days; max 366 days (`422` otherwise). → `{ workspace_id, period{from,to|null}, totals, local_vs_hosted{local,mock,hosted} (request counts), by_provider[{provider, model, …totals}], by_operation[{operation, …totals}], daily[{date: "YYYY-MM-DD", requests, input_tokens, output_tokens, estimated_cost_microunits|null}] }`. `totals` = `{ requests, input_tokens, output_tokens, estimated_cost_microunits|null, avg_duration_ms }`. `daily` is zero-filled per UTC day (R3).

### Knowledge
`POST /repositories/:id/knowledge { source_type: engineering_note|decision|architecture, title, content(≤100KB), source_url?(https) }` (member+). `GET /knowledge/:id` includes `content`. Delete: author or admin. Notes are not yet used by Q&A retrieval.

## 8. Tasks, runs, plans and SSE

### Tasks
- `POST /repositories/:id/tasks` (member+, Idempotency-Key recommended) — manual: `{ source_type:'manual', title, description, labels? }`; GitHub issue: `{ source_type:'github_issue', external_number }` (title/body imported; `422 NOT_AN_ISSUE` for PR numbers).
- `GET /tasks?repository_id=&status=` (+ workspace per §4; paginated). Every list item and `GET /tasks/:id` include `repository_full_name` and `latest_run {id, run_number, status, current_stage, created_at} | null` (R2).
- `GET /tasks/:id`, `PATCH /tasks/:id { title?, description?, labels?, status?: open|archived }`.
- Task `status`: `open|active|completed|failed|cancelled|archived` (driven by its runs).

### Runs
- `POST /tasks/:id/runs` → **202** run object. Body as API_SPEC (`mode`, `base_branch`, `budgets`). Budgets are clamped to workspace limits and AI policy; the response `budget` is what applies. `409 RUN_ALREADY_ACTIVE` (with `details.run_id`) if one is running; `409 REPOSITORY_NOT_INDEXED`.
- Run object: `{ id, task_id, workspace_id, repository_id, run_number, status, current_stage, mode, provider, model, base_branch, snapshot_id, state_version, budget, usage_summary{input_tokens,output_tokens,model_calls,agent_steps}, retry_of_run_id, error_code, error_summary, cancel_requested_at, started_at, ended_at, created_at, updated_at }`; `GET /runs/:id` adds `task_title`, `repository_full_name`, `plan_hash`, `plan_version`, `data_disclosure`, `approvals[{id, approval_type: plan|pull_request, decision: approved|rejected, subject_hash, comment, user_id, created_at}]` (oldest first; GAP-19) and `pull_request {id, pr_number, pr_url, head_branch, base_branch, created_at} | null` (R1).
- **AGREED (GAP-05)** `GET /runs?status=a&status=b&repository_id=&task_id=&limit=&cursor=` (+ workspace per §4) → paginated run objects + `task_title`, `repository_full_name`, newest first. Unknown status → `422`.
- Statuses exactly as ARCHITECTURE §6. `current_stage`: `context_retrieval|investigation|planning|implementation|verification|review|pull_request|null`.
- `POST /runs/:id/cancel { reason? }` (member+) → 200; terminal immediately. `POST /runs/:id/retry` → 202 new run (`retry_of_run_id`), only from `failed|timed_out|cancelled`.
- `GET /runs/:id/steps` → `[{ id, sequence_number, agent_type (context_retriever|investigator|planner|…), status, prompt_version, provider, model, input_tokens, output_tokens, duration_ms, error_code, input, output, started_at, ended_at, tool_calls:[{tool_name,status,input,output,duration_ms}] }]` (redacted).
- `GET /runs/:id/artifacts` → `{ patches: [], verification_logs: [] }` (populated from M6).
- Typical failure codes: `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `INVALID_MODEL_OUTPUT`, `INVALID_PLAN`, `BUDGET_EXHAUSTED`, `TIMED_OUT`, `EXECUTION_NOT_AVAILABLE` (until M6 ships, every approved run fails here).

### Plan
- `GET /runs/:id/plan` → `{ run_id, version, plan_hash, source: agent|user_edit, created_by, created_at, editable, plan, investigation, approval }`; plan shape = AI_WORKFLOW §4.2. `approval` = latest plan decision `{ decision, user_id, comment, subject_hash, created_at } | null` (R6).
- `PATCH /runs/:id/plan { plan, base_plan_hash }` (member+, only `awaiting_plan_approval`) → new version + new hash. `409 PLAN_CHANGED` if `base_plan_hash` is stale. File paths must be relative, no `..`, no globs.
- `POST /runs/:id/plan-approval { decision, comment?, plan_hash }` — **`plan_hash` is required to approve** and must equal the current version (`409 PLAN_CHANGED` otherwise). Approve → `preparing_workspace`; reject → `rejected` (task reopens).

### SSE — `GET /runs/:id/events`
`EventSource(url, { withCredentials: true })`. Each event: `id: <int>`, `event: <type>`, `data: <json>`; every payload has `run_id` and `timestamp`. Reconnect sends `Last-Event-ID` automatically (or use `?last_event_id=`); replay is exact from PostgreSQL. The stream sends `retry: 3000`, heartbeats (`: heartbeat`) every 15 s, and **closes after `run.completed|run.failed|run.cancelled`** (do not auto-reconnect after a terminal event). Payloads of note:
- `run.status.changed { from, status, state_version, reason }`, `run.stage.changed { stage }`
- `retrieval.completed { count, commit_sha, semantic, evidence[{id,path,start_line,end_line,commit_sha,content_hash,symbol}] }`
- `agent.started { agent, step_id }`, `agent.completed|agent.failed { agent, provider, model, input_tokens, output_tokens, duration_ms, error_code }`
- `tool.started { tool, step_id }`, `tool.completed { tool, status, duration_ms }`
- `approval.required { approval_type: 'plan', plan_hash, plan_version }`
- `run.failed|run.completed|run.cancelled { status, error_code, error_summary }`

### Execution, review and pull requests
After plan approval the run moves `preparing_workspace → implementing → verifying → (implementing for a bounded repair) → reviewing → awaiting_pr_approval`. Extra SSE events: `patch.proposed { patch_id, patch_hash, attempt, changed_files, additions, deletions }`, `sandbox.started { profile, command }`, `verification.completed { profile, status, exit_code, duration_ms, attempt }`, `review.finding.created { finding_id, source, severity, file_path }`, `approval.required { approval_type: 'pull_request', patch_id, patch_hash }`, `pull_request.created { pr_number, pr_url, head_branch }`.
- `GET /runs/:id/diff` → `{ patch_id, patch_hash, attempt, base_commit_sha, summary, additions, deletions, changed_files[{path,action,explanation}], diff (unified), diff_truncated, attempts[] }` (404 before a patch exists).
- `GET /runs/:id/verification` → `{ deterministic: true, current_patch_id, summary{passed,failed,timed_out,skipped,unavailable}, unavailable[{profile_id, reason, kind: unsupported|sandbox_error}] (R4), results[{profile_id, command_display, image, status: passed|failed|timed_out|skipped|error, exit_code, duration_ms, output_truncated, stdout_excerpt, stderr_excerpt, attempt, patch_id}] }`. Show these separately from AI output; `error` = infrastructure, not a test failure.
- `GET /runs/:id/review` → `{ summary, deterministic_findings[], ai_findings[] }`; each finding `{ id, source: ai_review|security_scanner|static_analysis|test, severity, file_path, start_line, end_line, title, description, evidence, confidence: low|medium|high|null, suggested_action: string|null, status: open|accepted|dismissed|fixed, disposition_* }`. `confidence`/`suggested_action` are top-level fields (R5), set only for `ai_review` findings. AI findings are advisory; label them as such.
- `POST /runs/:id/findings/:findingId/disposition { status: accepted|dismissed|fixed, comment? }` (member+).
- `POST /runs/:id/pr-approval { decision, comment?, patch_hash }` — `patch_hash` required to approve and must equal the current diff's hash (`409 PATCH_CHANGED`). Rejection → `completed_without_pr`.
- `POST /runs/:id/pull-request { title, body?, base_branch? }` — **`Idempotency-Key` required** (`422 IDEMPOTENCY_KEY_REQUIRED`). `201 { id, pr_number, pr_url, head_branch, base_branch }`. Errors: `403` no valid approval of the current patch or installation lacks write permission; `409 PULL_REQUEST_EXISTS`; `422 PULL_REQUEST_NOT_SUPPORTED` (fixture/dev repositories); `503 GITHUB_UNAVAILABLE` (run returns to `awaiting_pr_approval`; retry with a new key). The PR body gets an appended evidence section (verification statuses, finding counts, approver). Nothing is merged or deployed.
- Additional run failure codes: `PATCH_REJECTED`, `PLAN_REVISION_REQUIRED`, `VERIFICATION_FAILED`, `SECURITY_CHECK_FAILED`, `SANDBOX_ERROR`, `PULL_REQUEST_FAILED`.
- Repository setting `verification_profiles: string[]` (admin) selects from the server allowlist: `python-compile`, `python-unittest`, `node-syntax`, `node-test`. Empty = auto-detect. Arbitrary commands are never accepted.

### Work package B: templates, call graph, impact, workspace knowledge

**Workflow templates.** `GET /workspaces/:id/templates?include_archived=` (viewer+) returns the five
built-ins (`bug_fix`, `add_tests`, `refactor`, `dependency_upgrade`, `migration_plan`; `id: null`,
`source: "builtin"`) followed by workspace templates. `POST` (admin+, idempotent) creates one
(`409 TEMPLATE_KEY_TAKEN`; built-in keys are reserved, 422); `PATCH …/:templateId` (admin+) updates
and bumps `version`; `DELETE …/:templateId` (admin+) archives (204). All three are audited
(`template.created|updated|archived`, with before/after). A template has `workflow`
(`change` | `migration_plan`), `task_defaults` (`title_prefix`, `description_template`, `labels`),
`budget` (ceilings that can only lower workspace limits), `allowed_profiles` (server profile ids or
`null` = all) and `planning_guidance` (≤ 8 rules, ≤ 300 chars, sent to the planner as trusted
workspace policy under the system rules, never as repository content).
`POST /repositories/:id/tasks` accepts `template_key`; unknown → `422 TEMPLATE_NOT_FOUND`, archived
→ `422 TEMPLATE_ARCHIVED`. Tasks return `template_key` and the immutable `template` snapshot.
Runs started from such a task: budget = min(workspace ceilings, request, template ceilings);
verification profiles outside `allowed_profiles` are reported in `unavailable` with the reason;
`GET /runs/:id` returns `template` and `plan_only`.

**Migration plans (plan-only).** A `migration_plan` run plans with the AI task `migration_plan`;
the plan gains an optional `migration` section (`affected_areas[{area, description, files,
evidence_ids}]`, `prerequisites`, `step_rollback[{step_id, rollback}]`, `rollback_strategy`).
Plans without it hash exactly as before. `GET /runs/:id/plan` adds `migration_evidence` (locations
for the cited ids, from the run's own retrieval records) and `plan_only`. Approving a plan-only
plan moves the run to `completed_without_pr`; nothing is executed. The changed-file budget does not
apply to plan-only plans (they change no files); the schema's own limits do.

**Call graph.** `GET /repositories/:id/symbols/:symbolId/call-graph?direction=callers|callees|both&depth=1..3&limit=1..100&cursor=&snapshot=`
(viewer+). Nodes `{symbol, depth, direction}` are offset-paged (`next_cursor`, `total_nodes`, at
most 500 per graph); `edges` carry the call-site `path` and `line`; `unresolved_callees` lists
ambiguous or external names. Only name-resolved `calls`/`instantiates` edges are followed.

**Impact and test selection (heuristic).** `POST /repositories/:id/impact { changed_files:
(path | {path, ranges?})[] ≤ 200, snapshot?, max_tests? }` (viewer+) and `GET /runs/:id/impact`
(viewer+; analyses the latest applied patch with its old-side hunk ranges, or the plan's
`files_to_modify` before a patch exists; `source: patch|plan|none`). Both return
`heuristic: true`, a `disclaimer`, `impacted_files` (reverse imports ≤ 4 hops and callers ≤ 2 hops,
each with an `evidence` chain of `{kind: imports|calls|changed|naming, from, to, line}`),
`impacted_symbols`, `selected_tests[{path, score, reasons[{kind, description, evidence}]}]` and
`limitations`. `score` is a ranking signal in [0, 1], not a probability or a correctness claim
(FR-VER-006). Repository setting `test_selection: "off" | "narrow"` (default `off`): with `narrow`,
`node-test` and `python-pytest` run only the selected test files that exist in the workspace
(passed as separate argv elements, no shell); the verification result records `test_selection`
(`files`, `reasons`, `not_run`) and its `command_display` says how many files ran. The exit code
still decides pass/fail; if nothing is selected the full profile runs.

**Workspace knowledge.** `POST /workspaces/:id/search { query, repository_ids?, top_k?,
per_repository?, include_knowledge?, mode? }` and `POST /workspaces/:id/questions { question,
repository_ids?, mode?, top_k?, include_knowledge? }` (viewer+; non-members 404). Only connected,
indexed repositories of that workspace are searched (at most 25; others are listed in
`skipped_repositories`); a `repository_ids` entry outside the workspace is a 404. The query is
embedded once and each repository is searched with the same snapshot-scoped hybrid retrieval as
single-repository search; results merge by RRF score. Every result and citation carries
`repository_id`, `repository_full_name` and `commit_sha`. Q&A citations are rebuilt from retrieval
records; workspace answers are not stored in the per-repository question history. Cloud mode is
audited as `ai.cloud_inference` with `operation: workspace_qa`.

**Hosted providers.** `ai-policy.cloud.provider` is now `"anthropic" | "openai_compatible" | null`.
Changing the provider or adding data categories while cloud is enabled requires
`acknowledge_data_disclosure: true` (`422 DATA_DISCLOSURE_REQUIRED` with the new disclosure
otherwise); a provider change is audited as `ai_policy.cloud_provider_changed`.

### OpenAPI
`apps/api/openapi.json` (OpenAPI 3.0.3, 87 operations) is generated from the runtime Zod request schemas; a test fails if it drifts from the live routes. Regenerate with `npm run build && npm run openapi`.

## 9. Health
`GET /health/live`, `GET /health/ready` (503 when Postgres or Redis is unavailable).

## 10. Implementation status

See `STATUS.md`.
