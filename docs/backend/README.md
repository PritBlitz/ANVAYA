# Anvaya Backend

Backend for Anvaya: the NestJS control plane (`apps/api`), its background worker
(same codebase, `main.worker.ts`), and the FastAPI AI service (`services/ai-service`).

| Doc | Contents |
|---|---|
| [`STATUS.md`](STATUS.md) | What is implemented and tested, per endpoint |
| [`REMAINING.md`](REMAINING.md) | Tracker of what is left (integration, credentials, features) |
| [`API_CONTRACT_NOTES.md`](API_CONTRACT_NOTES.md) | How the API implements `API_SPEC.md`, and proposed additions (frontend-facing) |
| [`DATABASE_NOTES.md`](DATABASE_NOTES.md) | Migrations and deviations from `DATABASE.md` |
| [`AI_SERVICE.md`](AI_SERVICE.md) | Internal AI service contract, providers, prompt and safety design |
| [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) | Milestones and acceptance criteria |
| [`adr/`](adr/) | Architecture decision records |

## 1. Architecture

```
Browser ──HTTPS/SSE──▶ apps/api (NestJS, port 3001) ──▶ PostgreSQL + pgvector (truth)
                          │  enqueue (BullMQ)            ▲
                          ▼                              │
                       Redis ◀── pub/sub wake-ups ── worker (main.worker.ts)
                                                         │ indexing, run orchestration
                                                         ▼
                                       services/ai-service (FastAPI, port 8001)
                                                         │
                                                Ollama (local) │ mock │ (hosted: not enabled)
```

* **Control plane** validates input, authorizes every tenant-owned access, persists state and
  dispatches jobs. It never runs repository code and never waits on long model calls (runs are
  async; Q&A is the one synchronous AI call, bounded by policy timeouts).
* **Worker** runs the indexing pipeline and the run orchestrator. Jobs carry ids + tenant scope
  only; workers re-load and re-validate parent records.
* **AI service** owns providers, prompts, output schemas and embeddings. It has no database,
  filesystem, shell or user-authorization responsibilities, and accepts calls only with the
  shared `AI_SERVICE_TOKEN`.
* **PostgreSQL is the source of truth.** Redis carries queue entries, rate-limit counters and
  pub/sub wake-ups only; recovery sweeps rebuild queue state from PostgreSQL.

## 2. Module responsibilities (`apps/api/src`)

| Module | Responsibility |
|---|---|
| `config/` | Zod-validated environment; refuses unsafe production settings |
| `common/` | Envelope/error filter, request ids, Zod pipes, cursor pagination, rate limiting, idempotency, redaction, structured logging |
| `database/` | Kysely + `pg`, checksum-enforced SQL migrator, keyset pagination helpers |
| `identity/` | Sessions (hashed tokens), CSRF, GitHub OAuth sign-in, dev login, `/me` |
| `workspaces/` | Workspaces (= `organizations`), members, invitations, **`AccessService` (all tenant authorization)** |
| `audit/` | Append-only audit trail + query endpoint |
| `github/` | GitHub App client (JWT, down-scoped installation tokens), installation handshake, webhooks |
| `repositories/` | Repository registration/settings/disconnect |
| `indexing/` | Classification, Tree-sitter parsing, chunking, sources (GitHub tarball / local fixture), indexer, recovery |
| `retrieval/` | Hybrid lexical + vector retrieval (Context Retriever) |
| `storage/` | Object storage abstraction (local FS driver; S3-compatible interface) |
| `ai/` | AI service client, workspace AI policy, usage tracking, grounded Q&A |
| `knowledge/` | Engineering notes / decision documents |
| `runs/` | Tasks, state machine, transitions, run events (outbox + SSE), orchestrator, plan approval |
| `execution/` | Verification profiles, hardened Docker sandbox driver, disposable workspaces, patch validator, execution pipeline |
| `review/` | Diff/verification/review read models, finding dispositions, PR approval and GitHub PR creation |
| `openapi/` | Route registry + generator for `openapi.json` |
| `worker/` | BullMQ workers, recovery sweeps, retention sweep, worker metrics |
| `dev/` | Development seed (refuses to run outside development + `local_fixture`) |

## 3. Running locally

Prerequisites: Node ≥ 22, Python ≥ 3.12, Docker. Optional: Ollama.

```bash
# 1. Dependencies (Postgres+pgvector on 127.0.0.1:5433, Redis on 6379)
docker compose -f infra/compose/docker-compose.yml up -d

# 2. AI service
cd services/ai-service
python -m venv .venv && .venv/Scripts/python -m pip install -e ".[dev]"   # (bin/ on Linux/macOS)
cp .env.example .env            # EMBEDDING_PROVIDER=mock if Ollama is not installed
.venv/Scripts/python -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8001

# 3. API + worker
cd apps/api
npm ci && cp .env.example .env && npm run build
npm run migrate
npm start                        # API on :3001
npm run start:worker             # separate terminal
```

**Without GitHub App credentials** (frontend development): set `REPOSITORY_SOURCE=local_fixture`
and `LOCAL_FIXTURE_ROOT=../../infra/fixtures` in `apps/api/.env`, then

```bash
node --env-file=.env dist/dev/seed.cli.js dev@example.test acme/demo-service
```

This creates a workspace (AI policy defaults to `mock` mode) and an indexed fixture repository.
Sign in with `POST /api/v1/auth/dev-login {"email":"dev@example.test"}`.

**Sandboxed verification (development)**: set `EXECUTION_DRIVER=docker` and a `WORKSPACES_DIR`
in `apps/api/.env`; the worker host needs Docker. The driver runs pinned images with no network,
read-only root, no capabilities, non-root user and resource limits. It is refused in production —
SECURITY §7 requires a microVM / dedicated sandbox service for untrusted code.

**Containers**: `docker compose -f infra/compose/docker-compose.yml --profile app up -d --build`
starts API, worker (execution disabled; the Docker socket is never mounted into app containers)
and the AI service (mock embeddings by default).

**With Ollama**: `ollama pull qwen2.5-coder:7b && ollama pull nomic-embed-text`, set
`EMBEDDING_PROVIDER=ollama` in the AI service, and use `local` mode.

## 4. Environment

See `apps/api/.env.example` and `services/ai-service/.env.example` (placeholders only; real
`.env` files are git-ignored). Production refuses to boot with dev login enabled, insecure
cookies, the fixture source, or a missing `AI_SERVICE_TOKEN`.

## 5. Testing

```bash
cd apps/api
npm run lint && npm run typecheck && npm test && npm run build
# Opt-in contract test against a running AI service (mock mode, no credits):
AI_SERVICE_E2E_URL=http://127.0.0.1:8001 npx vitest run test/contract-ai-service.spec.ts

cd services/ai-service
.venv/Scripts/python -m ruff check app tests && .venv/Scripts/python -m mypy app && .venv/Scripts/python -m pytest
```

API tests use a dedicated `anvaya_test` database that is **reset and migrated from empty on
every run**, real Redis (db 1), an in-process fake GitHub (verifies App JWT signatures, records
token scopes) and a fake AI service. No test needs network access or model credits.

## 6. Security assumptions (summary)

* Every tenant-owned read/write goes through `AccessService`; non-members get `404`.
* Sessions: opaque random tokens, SHA-256 stored, HttpOnly/SameSite=Lax cookies, session-bound CSRF.
* GitHub: installation linking requires a single-use state **and** an OAuth proof that the user
  can see the installation; tokens are per-repository and per-operation down-scoped; webhooks are
  HMAC-verified on raw bytes with delivery-id **and** payload-hash replay protection.
* Indexing never extracts archives to disk; symlinks/traversal entries are skipped; secret files
  and secret-bearing content are excluded and never embedded or stored.
* Model output is validated at two trust boundaries (AI service + API); citations are built from
  server records; task/issue text is sent to models as fenced untrusted input; no model output
  can change run state — approvals are human, bound to the reviewed plan hash.
* No silent fallback between inference modes; cloud requires explicit, audited opt-in.
* Repository code runs only in the sandbox; models never supply commands (server-defined profiles,
  argv only, no shell). Patches are validated against the approved plan before application;
  pass/fail comes only from exit codes. PRs require a human approval bound to the patch hash,
  an Idempotency-Key, and re-checked installation write permissions; nothing is merged or deployed.

## 7. Outstanding integration dependencies

* Frontend acknowledgement of PROPOSAL items in `API_CONTRACT_NOTES.md`.
* GitHub App registration (app id, private key, webhook secret, OAuth client) for real GitHub.
* A host with Ollama for live local inference.
* Production execution plane (microVM / separate account), hosted provider adapter, live Ollama and GitHub validation — see `STATUS.md`.
