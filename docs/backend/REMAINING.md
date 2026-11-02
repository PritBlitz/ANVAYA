# Remaining work tracker

Last updated: 2026-11-02. Update this file whenever an item changes state. A box is ticked only
after the item has been verified (tests run or behaviour observed), not just written.

Overall: the backend (`feat/backend`) and the frontend (`feat/frontend`) each work in isolation, and
neither branch has been merged. **The two have never been run against each other.** The frontend
runs only on its fixture adapter, and its API assumptions differ from the backend in a few places
(section 1). Section 1 is the critical path.

## 1. Frontend ↔ backend integration (blocks a real end-to-end run)

Frontend gap IDs are from `frontend/docs/frontend/API_INTEGRATION.md`. Backend proposals are in
`API_CONTRACT_NOTES.md`. Each mismatch needs **one agreed shape** before either side changes code.

| # | Item | Backend today | Frontend expects | Status |
|---|---|---|---|---|
| I-1 | Workspace scoping (GAP-02) | `?workspace_id=` query parameter (or `workspace_id` in the body) | `X-Workspace-Id` header (says the query param is acceptable) | ☐ agree on one; the frontend switches to the query param, or the backend also accepts the header |
| I-2 | File content (GAP-04) | `GET /repositories/:id/file?path=&commit_sha=` | `GET /repositories/:id/files/content?path=&commit_sha=`, `403 FILE_EXCLUDED` | ☐ align path, error code and field names |
| I-3 | Workspace-wide run list (GAP-05) | **Missing.** Only `GET /tasks/:id/runs` | `GET /runs?status=&repository_id=&cursor=` with task/repository fields | ☐ backend to implement |
| I-4 | Approvals on run detail (GAP-19) | `GET /runs/:id` returns plan hash/version but **no `approvals[]`** | `WorkflowRun.approvals: Approval[]` | ☐ backend to add |
| I-5 | GitHub install flow (GAP-14) | Server-issued single-use `state` from `GET /integrations/github/install-url`; `complete` also needs an OAuth `code` proving the user can see the installation | Builds the URL from a public app slug and generates `state` in the browser | ☐ frontend should use the server install-url (browser-made state is weaker); confirm the callback route |
| I-6 | Auth (GAP-01) | `/auth/github/login`, `/auth/logout`, `anvaya_csrf` cookie + `X-CSRF-Token` | Same idea | ☐ confirm `return_to` parameter name and the failed-login redirect |
| I-7 | Shape confirmations (GAP-06/07/08/09/10/11/16/18/20) | Implemented; see the generated `apps/api/openapi.json` | Typed in `apps/web/src/lib/api/types.ts` | ☐ diff the frontend types against `openapi.json` field by field |
| I-8 | Invitations (GAP-17) | List/revoke/accept implemented | Treated as fire-and-forget; no UI | ☐ frontend may add UI (optional) |
| I-9 | Real end-to-end run (frontend M10) | — | Playwright suite in `http` mode against NestJS + worker + AI service | ☐ after I-1 to I-7 |

## 2. Needs external access or credentials (owner: user)

| # | Item | What is needed | Status |
|---|---|---|---|
| X-1 | Register a GitHub App (dev) | App ID, private key file, webhook secret, OAuth client ID/secret, app slug. Permissions: contents R/W, pull requests R/W, issues R, metadata R. Webhook URL needs a public tunnel (e.g. smee.io) for local work | ☐ |
| X-2 | Live GitHub validation | X-1, plus a throwaway test repository: OAuth sign-in, install handshake, webhook delivery, index, PR creation | ☐ |
| X-3 | Live local model | Install Ollama; `ollama pull qwen2.5-coder:7b` and `nomic-embed-text`; then run Q&A and a run in `local` mode | ☐ |
| X-4 | CI | Push the branch so `.github/workflows/backend-ci.yml` actually runs, then fix whatever it reports | ☐ |
| X-5 | Canonical docs | `Z:/ANVAYA/docs/*.md` (PRD, ARCHITECTURE, API_SPEC, …) are **untracked on every branch**. Commit them to `main` | ☐ |
| X-6 | Release scope | `releases/V1.md` does not exist; both sessions used the ROADMAP phases as scope | ☐ write or confirm |

## 3. Backend features not built yet

| # | Item | Notes | Status |
|---|---|---|---|
| B-1 | Hosted (cloud) inference adapter | Cloud mode currently fails with `PROVIDER_NOT_CONFIGURED`. Must keep explicit opt-in, disclosure and no silent fallback | ☐ |
| B-2 | Knowledge notes in retrieval/Q&A | CRUD exists; notes are not yet chunked, embedded or retrieved | ☐ |
| B-3 | Production execution plane | The Docker driver is development-only and refused in production. Needs a microVM or dedicated sandbox service (SECURITY §7) | ☐ |
| B-4 | Dependency install in the sandbox | Network is always off, so only stdlib/no-dependency check profiles work. Needs a vetted, pre-built dependency cache or mirror | ☐ |
| B-5 | Vector index | Exact scan per snapshot today; add an HNSW index when repositories get large | ☐ |
| B-6 | OpenTelemetry tracing | Prometheus metrics and structured logs exist; no traces | ☐ |
| B-7 | Code intelligence endpoints (GAP-15) | Symbol explorer and dependency map: symbols are parsed and stored, but there are no endpoints | ☐ |
| B-8 | Q&A history endpoint | The frontend keeps history per browser session only | ☐ (optional) |
| B-9 | GitLab / Bitbucket | Out of scope for V1 | — |

## 4. Frontend items (owned by the frontend session; listed for visibility)

From `frontend/docs/frontend/STATUS.md`: Content-Security-Policy header, syntax highlighting,
infinite scroll beyond the audit log, WebKit/Firefox E2E, moving contract types into
`packages/contracts`.

## 5. Process

- [x] Backend work committed locally on `feat/backend`, in batches (not pushed)
- [ ] Push `feat/backend` (user)
- [ ] Open a PR and review it (user; no autonomous merges)
- [ ] Merge order: canonical docs → backend → frontend, after I-1 to I-9
