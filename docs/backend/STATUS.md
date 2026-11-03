# Backend Implementation Status

Legend: ✅ implemented and covered by automated tests · 🚧 in progress · ⏳ not started.
"Implemented" means real behavior against Postgres/Redis — there are no stub endpoints
returning fake success.

| Area | Endpoint(s) | Status |
|---|---|---|
| Health | `GET /health/live`, `GET /health/ready` | ✅ |
| Auth | `/auth/providers`, `/auth/dev-login`, `/auth/csrf`, `/auth/logout`, `/auth/sessions`, `DELETE /auth/sessions/:id` | ✅ |
| Auth | `/auth/github/login`, `/auth/github/callback` | ✅ code + not-configured path tested; live GitHub exchange not tested (needs OAuth app credentials) |
| Identity | `GET /me` | ✅ |
| Workspaces | `GET/POST /workspaces`, `GET/PATCH /workspaces/:id` | ✅ |
| Members | `GET /workspaces/:id/members`, `PATCH/DELETE /workspaces/:id/members/:userId` | ✅ |
| Invitations | `POST/GET /workspaces/:id/invitations`, `DELETE …/:invitationId`, `POST /invitations/accept` | ✅ |
| Audit | `GET /workspaces/:id/audit-events` | ✅ |
| GitHub | `GET /integrations/github/install-url`, `POST /integrations/github/complete`, `GET /integrations/github/installations`, `GET …/installations/:id/repositories`, `DELETE …/installations/:id`, `POST /webhooks/github` | ✅ (against a fake GitHub that verifies App JWT signatures; not yet run against real GitHub) |
| Repositories | `GET/POST /repositories`, `GET/PATCH/DELETE /repositories/:id` | ✅ |
| Indexing | `POST /repositories/:id/index`, `GET …/index-status`, `GET …/snapshots`, `GET …/tree`, `GET …/files/content`, `POST …/search` | ✅ (worker process `main.worker.ts`; embeddings via AI service contract, tested with a fake AI server) |
| AI policy | `GET/PATCH /workspaces/:id/ai-policy`, `POST /ai/providers/health-check` | ✅ |
| Usage | `GET /workspaces/:id/usage` | ✅ |
| Q&A | `POST /repositories/:id/questions` | ✅ (contract verified against the real FastAPI service in mock mode; not yet run against a live Ollama model) |
| Knowledge | `GET/POST /repositories/:id/knowledge`, `GET/DELETE /knowledge/:id` | ✅ CRUD. Notes are **not yet included in retrieval/Q&A**. |
| AI service | `services/ai-service`: mock, Ollama, hosted Claude and OpenAI-compatible adapters, prompts, schemas, embeddings | ✅ 62 pytest tests. Hosted adapters are opt-in and tested against fake servers only (no live credentials). |
| Tasks | `POST /repositories/:id/tasks` (manual + GitHub issue), `GET /tasks`, `GET/PATCH /tasks/:id` | ✅ |
| Runs | `POST /tasks/:id/runs`, `GET /tasks/:id/runs`, `GET /runs` (workspace list), `GET /runs/:id` (with approvals, PR), `POST /runs/:id/cancel`, `POST /runs/:id/retry`, `GET /runs/:id/steps`, `GET /runs/:id/artifacts` | ✅ (retrieval → investigation → planning; worker-driven; verified end-to-end with real worker + real AI service in mock mode) |
| Plan | `GET/PATCH /runs/:id/plan`, `POST /runs/:id/plan-approval` | ✅ approval bound to plan hash |
| SSE | `GET /runs/:id/events` | ✅ replay + live |
| Execution & verification | workspace → patch → sandboxed verification → bounded repair (worker) | ✅ with `EXECUTION_DRIVER=docker` (dev). Default `disabled`: approved runs fail with `EXECUTION_NOT_AVAILABLE`. Sandbox policy tested against **real Docker**; full pipeline verified end-to-end with real containers. |
| Review & PR | `GET /runs/:id/diff`, `GET /runs/:id/verification`, `GET /runs/:id/review`, `POST /runs/:id/findings/:id/disposition`, `POST /runs/:id/pr-approval`, `POST /runs/:id/pull-request` | ✅ against a fake GitHub (write permissions enforced, idempotent). **Not yet run against real GitHub.** |
| Templates (WP-B) | `GET/POST /workspaces/:id/templates`, `PATCH/DELETE /workspaces/:id/templates/:templateId`; `template_key` on task creation | ✅ built-ins + admin-managed, audited, snapshot on task, budget ceilings, profile restriction, planning guidance |
| Migration plans (WP-B) | plan-only runs from the `migration_plan` template | ✅ evidence-backed plan with affected areas, prerequisites and rollback; ends at approval (`completed_without_pr`) |
| Call graph (WP-B) | `GET /repositories/:id/symbols/:symbolId/call-graph` | ✅ bounded depth, paged |
| Impact & test selection (WP-B) | `POST /repositories/:id/impact`, `GET /runs/:id/impact`; repository setting `test_selection` | ✅ heuristic, evidence chains; `narrow` mode for `node-test`/`python-pytest`. The narrowed sandbox path is unit-tested at the selection level only; it was **not** exercised against real Docker in this change |
| Workspace knowledge (WP-B) | `POST /workspaces/:id/search`, `POST /workspaces/:id/questions` | ✅ tenant-scoped, per-result provenance |
| Operations | `GET /internal/metrics` (token), worker metrics port, retention sweep, OpenAPI (`apps/api/openapi.json`), Dockerfiles, compose `app` profile, CI workflow | ✅ images built and stack started locally; CI workflow YAML validated but **not executed** in GitHub Actions |

## Not implemented / known limitations

* Hosted adapters (Claude, OpenAI-compatible) have not been run against live endpoints here (no credentials).
* Knowledge documents are stored but not yet part of retrieval/Q&A.
* No live Ollama or live GitHub verification in this environment (no model runtime / App credentials).
* Production execution plane (microVM / separate account) — the Docker driver is development-only and refused in production.
* OpenTelemetry tracing (metrics are Prometheus-format; logs are structured JSON with request/run ids).
* No ANN (HNSW) vector index yet; vector search is an exact scan scoped to one snapshot.
* Dependency installation inside the sandbox (network is always off), so profiles needing third-party packages are not available.

Cross-cutting, implemented and tested: request IDs, success/error envelopes, strict Zod
validation (422), cursor pagination, session-bound CSRF, CORS allowlist, security headers,
per-route Redis rate limits with `Retry-After`, idempotency keys, append-only audit (DB
trigger), 404 concealment for non-members, checksum-protected migrations.
