# Backend Implementation Plan

Owner: backend session. Canonical sources: `PRD.md`, `ARCHITECTURE.md`, `DATABASE.md`,
`API_SPEC.md`, `AI_WORKFLOW.md`, `SECURITY.md`, `ROADMAP.md`, `CLAUDE.md`.

> **Repository note:** at the time of writing, the canonical documents exist only as
> untracked files in the main checkout (`<repo>/docs/*.md`); they are not committed on
> `main`, `feat/backend`, or `feat/frontend`. They should be committed to `main` so both
> sessions build against a versioned contract. No release scope file (`releases/V1.md`)
> exists yet; this plan follows the build sequence in `CLAUDE.md §15` and Phases 0–6 of
> `ROADMAP.md` as the working first-release scope.

## 1. Analysis summary

### Product
Anvaya connects to GitHub repositories, indexes them by commit, answers grounded questions
with citations, and runs a durable, human-gated engineering workflow:
investigate → plan → **human plan approval** → isolated patch → deterministic verification →
review → **human PR approval** → PR. Local inference by default, no silent paid fallback.

### Architecture validation
The canonical architecture is sound for the requirements. Decisions taken for this backend:

| Area | Decision | Rationale |
|---|---|---|
| Control plane | NestJS 12 modular monolith (`apps/api`) | As specified. ESM, strict TS 5.9 (typescript-eslint does not yet support TS 7). |
| Workers | Same codebase, separate process entrypoint (`main.worker.ts`) with BullMQ processors | Shares domain/authorization code; scales independently; avoids premature microservices. |
| Orchestration | Persisted explicit state machine in TypeScript (no LangGraph) | Allowed by ARCHITECTURE §4.5. State, authorization and DB access live in the control plane; the AI service stays stateless. See ADR-0001. |
| DB access | `pg` + Kysely (typed query builder) + plain-SQL migrations with checksums | Canonical schema is SQL; pgvector/tsvector need raw SQL; no ORM auto-sync. |
| Validation | Zod v4 at every boundary; OpenAPI generated from the same Zod schemas | One source of truth for runtime validation and documentation. |
| AI service | FastAPI (`services/ai-service`), provider adapters: `mock`, `ollama`, hosted (disabled unless policy + key) | As specified. |
| Parsing | `web-tree-sitter` (WASM) in the indexing worker | Portable (no native build on Windows/Linux), same grammars as native Tree-sitter. |
| Events | `run_events` table is the durable outbox/event log; Redis pub/sub is notification only; SSE replays by event id | PostgreSQL is truth (ARCHITECTURE §10). |
| Auth | Server-side sessions (Postgres, hashed tokens), HttpOnly cookie + CSRF double-submit; GitHub OAuth login; dev login only when explicitly enabled outside production | API_SPEC §1 allows cookie sessions with CSRF. |
| Execution | Separate execution-control process; local driver = hardened Docker (`--network none`, read-only rootfs, cap-drop ALL, non-root, pids/mem/cpu limits). Production requires microVM (documented, not claimed). | SECURITY §7. |

### Spec gaps identified (see `API_CONTRACT_NOTES.md`)
1. Collection endpoints without workspace in path (`/repositories`, `/tasks`, installations) need a tenant selector → `workspace_id` query/body parameter, always revalidated against membership.
2. No auth/session endpoints defined → `/auth/*` added.
3. No table for plans, sessions, idempotency keys, webhook deliveries, run events, invitations → additive tables (see `DATABASE_NOTES.md`).
4. Approvals must be bound to plan/patch hashes (SECURITY §8) but `approvals` has no hash column → `subject_hash` added.
5. Lexical search needs a `tsvector` column on `code_chunks`.

## 2. Milestones and acceptance criteria

| # | Milestone | Acceptance criteria |
|---|---|---|
| M0 | Foundation | Compose starts pg+pgvector and Redis; migrations apply from empty and are checksum-protected; config validated at boot; request IDs; error envelope; health/readiness; lint, typecheck, tests, build pass. |
| M1 | Identity & workspaces | Sessions, CSRF, logout, session revocation; `/me`, workspaces CRUD, members, invitations, role changes; owner/admin/member/viewer enforced server-side; audit events; idempotency; rate limits; cross-tenant IDOR tests. |
| M2 | GitHub App | Installation completion verified against GitHub; webhook HMAC on raw body + delivery-id replay protection; installation/repository sync; repository registration; short-lived installation tokens; disconnect stops access. |
| M3 | Repository intelligence | Async indexing by commit SHA; exclusions (binary, vendored, generated, secrets, size); Tree-sitter TS/JS/Python symbols; line-aware chunks; embeddings via AI service; incremental reuse by content hash; hybrid search with citations; index status/coverage; tree; snapshots. |
| M4 | AI service & grounded Q&A | FastAPI with mock/ollama/hosted adapters; structured output validation with ≤1 repair; budgets; no silent fallback; Q&A returns citations validated against evidence pack; refuses to invent citations. |
| M5 | Tasks, runs, plan approval | Durable state machine with optimistic concurrency; investigation + planning stages; plan schema validation; plan edit/approve/reject bound to plan hash; SSE with replay; cancel/retry; survives worker restart. |
| M6 | Execution & verification | Execution controller with hardened sandbox; patch validation (paths, size, count, scope); server-defined profiles; real exit codes; timeout/cancel cleanup. |
| M7 | Review & PR | Reviewer stage; findings cite diff lines; disposition; PR approval bound to patch hash; idempotent PR creation; audit. |
| M8 | Hardening | Usage/quotas, OpenTelemetry, retention jobs, security test suite, runbooks, deployment config. |

## 3. External services and credentials required

| Service | Needed for | Local substitute |
|---|---|---|
| PostgreSQL 16+ with pgvector | everything | `pgvector/pgvector` container |
| Redis 7 | BullMQ, pub/sub, rate limits | `redis` container |
| GitHub App (app id, private key, webhook secret, client id/secret, slug) | installations, webhooks, OAuth login, PRs | dev login + fixture repository source for tests |
| Ollama (`qwen2.5-coder` class model, `nomic-embed-text` 768-d) | local inference/embeddings | mock provider (deterministic) |
| Object storage (S3/MinIO) | archives, patches, logs | local filesystem driver |
| Docker (execution host only) | sandbox | — |

## 4. Key risks
- Sandbox: containers are not a sufficient boundary for hostile multi-tenant code (SECURITY §7). Local Docker driver is for development; broad public execution must stay disabled until a microVM runtime is in place.
- CPU-only inference latency: one concurrent model request by default; all AI work is async.
- Contract drift with the frontend session: mitigated by generated `openapi.json` and `API_CONTRACT_NOTES.md`.
