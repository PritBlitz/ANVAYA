# Remaining work tracker

Last updated: 2026-11-03 (evening). Update this file whenever an item changes state. A box is ticked only
after the item has been verified (tests run or behaviour observed), not just written.

Overall: both branches are merged into `main` and pushed. On 2026-11-03 the whole stack was run together
(web in `http` mode → API → worker → AI service → Ollama) and every automated suite passed (section 5).

## 1. Frontend ↔ backend integration

Frontend gap IDs are from `frontend/docs/frontend/API_INTEGRATION.md`; the agreed contract is in
`API_CONTRACT_NOTES.md`. The frontend adapts to the backend's shapes; the backend added what the
frontend needed. B = backend side, F = frontend side.

| # | Item | Agreed contract | Status |
|---|---|---|---|
| I-1 | Workspace scoping (GAP-02) | `X-Workspace-Id` header or `workspace_id`; mismatch → 400 `WORKSPACE_MISMATCH` | B ☑ (tested) · F ☑ |
| I-2 | File content (GAP-04) | `GET /repositories/:id/files/content?path=&commit_sha=`; excluded → 403 `FILE_EXCLUDED` | B ☑ · F ☑ |
| I-3 | Workspace run list (GAP-05) | `GET /runs?status=a&status=b&repository_id=&task_id=` with `task_title`, `repository_full_name` | B ☑ · F ☑ |
| I-4 | Run detail (GAP-19, R1) | `GET /runs/:id` adds `approvals[]`, `task_title`, `repository_full_name`, `pull_request` | B ☑ · F ☑ |
| I-5 | GitHub install (GAP-14) | Server `install-url` + state; callback posts `{installation_id, state, code, setup_action}`; workspace comes from state | B ☑ · F ☑ |
| I-6 | Auth (GAP-01) | `/auth/github/login?return_to=` (same-origin paths only), `/auth/providers`, `/auth/dev-login`, `/auth/logout`, CSRF cookie + header | B ☑ · F ☑ |
| I-7 | Task list (R2), daily usage (R3), unavailable checks (R4), AI finding `confidence`/`suggested_action` (R5), documented shapes (R6) | See `API_CONTRACT_NOTES.md` | B ☑ · F ☑ |
| I-8 | Response schemas in `openapi.json` (R7) | Zod response schemas so the frontend can generate types | ☑ every JSON route, enforced in tests; frontend typechecks against it |
| I-9 | Real end-to-end run (frontend M10) | Frontend Playwright suite in `http` mode against API + worker + AI service (mock) | ☑ `npm run test:live` green (sign-in, code intelligence, Q&A); governed runs opened `PritBlitz/testRepo#1` on 2026-11-02 and, with the local 7B model, `#2` on 2026-11-04 |
| I-10 | Deployment wiring | Next rewrites `/api/v1/*` → `http://localhost:3001`; set backend `PUBLIC_API_URL=http://localhost:3000` so the OAuth callback and cookies land on the web origin | ☑ rewrite and SSE verified; proxy timeout raised from Next's 30s default to 660s so local-model calls don't fail with a bare 500 |

## 2. Needs external access or credentials (owner: user)

| # | Item | What is needed | Status |
|---|---|---|---|
| X-1 | Register a GitHub App (dev) | App ID, private key file, webhook secret, OAuth client ID/secret, app slug. Permissions: contents R/W, pull requests R/W, issues R, metadata R. Webhook URL needs a public tunnel (e.g. smee.io) for local work | ☑ App configured; no webhook has been delivered yet (optional: only needed for push/issue events) |
| X-2 | Live GitHub validation | X-1, plus a throwaway test repository: OAuth sign-in, install handshake, webhook delivery, index, PR creation | ☑ except webhook delivery |
| X-3 | Live local model | Install Ollama; `ollama pull qwen2.5-coder:7b` and `nomic-embed-text`; then run Q&A and a run in `local` mode | ☑ Ollama runs in WSL. Its system service reads models from the C: drive, so for Anvaya a second instance serves `Z:\ollama\models` on port 11435 (`OLLAMA_BASE_URL=http://127.0.0.1:11435`) |
| X-4 | CI | Push the branch so `.github/workflows/backend-ci.yml` actually runs, then fix whatever it reports | ☑ backend-ci (API, real gVisor, images, Terraform, AI service, secrets) and web-ci (checks, E2E in Chromium/Firefox/WebKit) green on `main` (2026-11-03) |
| X-5 | Canonical docs | `Z:/ANVAYA/docs/*.md` (PRD, ARCHITECTURE, API_SPEC, …) are **untracked on every branch**. Commit them to `main` | ☑ committed 2026-11-03 |
| X-6 | Release scope | `releases/V1.md` does not exist; both sessions used the ROADMAP phases as scope | ☑ `releases/V1.md` written 2026-11-03 |

## 3. Backend features not built yet

| # | Item | Notes | Status |
|---|---|---|---|
| B-1 | Hosted (cloud) inference adapter | Cloud mode currently fails with `PROVIDER_NOT_CONFIGURED`. Must keep explicit opt-in, disclosure and no silent fallback | ☑ opt-in Claude adapter |
| B-2 | Knowledge notes in retrieval/Q&A | CRUD exists; notes are not yet chunked, embedded or retrieved | ☑ notes are chunked, embedded and cited |
| B-3 | Production execution plane | The Docker driver is development-only and refused in production. Needs a microVM or dedicated sandbox service (SECURITY §7) | ☑ gVisor driver (ADR-0002), hostile probes against real runsc in CI; independent security assessment still required |
| B-4 | Dependency install in the sandbox | Network is always off, so only stdlib/no-dependency check profiles work. Needs a vetted, pre-built dependency cache or mirror | ☑ no-code-execution fetch step |
| B-5 | Vector index | Exact scan per snapshot today; add an HNSW index when repositories get large | ☑ HNSW indexes |
| B-6 | OpenTelemetry tracing | Prometheus metrics and structured logs exist; no traces | ☑ OpenTelemetry for API and worker |
| B-7 | Code intelligence endpoints (GAP-15) | Symbol explorer and dependency map: symbols are parsed and stored, but there are no endpoints | ☑ symbol explorer and dependency map |
| B-8 | Q&A history endpoint | The frontend keeps history per browser session only | ☑ per-user history |
| B-10 | Reconnect a repository in another workspace | `repositories.external_repository_id` is globally `UNIQUE` (DATABASE.md), and disconnecting keeps the row. So once a repo has been connected in one workspace it can never be connected in another, e.g. after moving the GitHub App installation (`REPOSITORY_ALREADY_CONNECTED`). Now unique per `(organization_id, external_repository_id)` and, among rows that are not disconnected, globally (migration 0011); history stays with the old workspace, webhook and connect lookups ignore disconnected rows | ☑ 2026-11-04, tested in `test/github.spec.ts` |
| B-9 | GitLab / Bitbucket | Out of scope for V1 | — |
| B-11 | Work package B (templates, OpenAI-compatible provider, call graph, impact/test selection, cross-repo search, migration plans) | See STATUS.md and API_CONTRACT_NOTES.md §8 | ☑ built and tested with fakes; live hosted-provider check and a real-Docker run of `test_selection: narrow` still to do |

## 4. Frontend items (owned by the frontend session; listed for visibility)

From `frontend/docs/frontend/STATUS.md`: Content-Security-Policy header, syntax highlighting,
infinite scroll beyond the audit log, WebKit/Firefox E2E, moving contract types into
`packages/contracts`.

## 5. Process

- [x] Backend work committed locally on `feat/backend`, in batches (not pushed)
- [x] `feat/backend` fast-forwarded into local `main` (at the user's request)
- [x] `main` pushed (2026-11-03)
- [ ] Commit the canonical docs (X-5)

## 6. Verification run (2026-11-03)

| Suite | Result |
|---|---|
| API typecheck, lint, vitest (Postgres and Redis in Docker) | ✅ pass |
| AI service pytest | ✅ 41 passed |
| Web format, typecheck, lint, vitest | ✅ 122 passed |
| Web Playwright on fixtures (desktop and mobile, axe) | ✅ 20 passed, 1 skipped by design |
| Web Playwright on the live stack | ✅ 3 passed; PR step skipped (needs `LIVE_RUN=1`, opens a real PR) |
| Local-model Q&A through the web origin | ✅ `qwen2.5-coder:7b`, 60s, code and knowledge citations |

## 7. V1 hardening and release work (2026-11-03)

| Item | Status |
|---|---|
| FR-WF-001 / FR-GIT-006: tasks from pull requests and failing checks | ☑ merged (migration 0006); not yet run against live GitHub (needs `pull_requests:read`, `checks:read`) |
| FR-OBS-004: run quotas and concurrency limits | ☑ merged |
| Security suite driven by `openapi.json` | ☑ `test/security.spec.ts` |
| Retrieval benchmark + stop-word fix | ☑ `docs/evaluations/retrieval.md`; live embeddings measured 2026-11-04 (hybrid recall@10 0.92, semantic 0.88) |
| Workflow evaluation | ☑ `docs/evaluations/workflow.md` |
| Backup/restore scripts and runbooks | ☑ tested restore (33 tables) |
| Production-like deploy with automatic rollback | ☑ tested with a deliberately broken release |
| Terraform AWS reference deployment | ☑ validated in CI, never applied |
| Images: API (with pinned RDS CA bundle), AI service, web | ☑ built in CI |
| Monotonic "latest job" ordering (migration 0007) | ☑ |
| Team/advanced intelligence (templates, multi-provider, call graph, impact, test selection, cross-repo search, migration planning) | ☑ merged (migration 0010); hosted adapters tested against fakes only |
| `packages/contracts` | ☑ shared OpenAPI contract; API writes it, web generates types from it, CI checks drift |
