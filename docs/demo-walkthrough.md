# Demo walkthrough

A 15-minute path through Anvaya that ends in a human-approved pull request. Everything shown is
real behaviour; nothing in the UI is mocked when the web app runs in `http` mode.

## Setup (local)

1. Data stores: `docker compose -f infra/compose/docker-compose.yml up -d postgres redis`.
2. Local models (Ollama): `qwen2.5-coder:7b` and `nomic-embed-text`.
3. AI service: `OLLAMA_BASE_URL=<ollama> uvicorn app.main:create_app --factory --port 8001`
   (`services/ai-service`).
4. API and worker: `node --env-file=.env dist/main.js` and `dist/main.worker.js` (`apps/api`; the
   worker needs `EXECUTION_DRIVER=docker` locally or `gvisor` on Linux).
5. Web: `NEXT_PUBLIC_API_MODE=http ANVAYA_API_ORIGIN=http://localhost:3001 npm run build && npm start`.
6. In the workspace AI settings, use local mode with `request_timeout_seconds` ≈ 580 and a 3600 s run
   budget on CPU-only machines (`docs/evaluations/workflow.md`).

## Script

1. **Sign in with GitHub** at `http://localhost:3000`, create a workspace, and **install the GitHub
   App** on a throwaway repository. The install is bound to server-held state, so a forged callback
   is refused.
2. **Connect the repository.** Indexing starts at once: coverage per language, excluded paths
   (binaries, vendored code, secrets) and known limitations are shown, not hidden.
3. **Code intelligence**: browse the tree, open a file at a permalink, find a symbol and its callers,
   look at the dependency map, run a hybrid search.
4. **Ask a question** ("Where is X validated?"). The answer cites files and lines, or knowledge notes;
   with no evidence it says so instead of inventing citations. History is saved per user.
5. **Create a task** (manually, from an issue, a pull request, or a failing check run). Imported text
   is shown and treated as untrusted data.
6. **Start a run** in local mode: watch retrieval → investigation (observed facts vs hypotheses, each
   linked to evidence) → a schema-valid plan.
7. **Approve the plan** (or edit it, or reject with a reason). The approval is bound to the plan's
   hash: editing after approval requires re-approval.
8. The worker applies the patch in a disposable workspace and runs **deterministic checks** in the
   sandbox (gVisor in production): passed, failed, skipped and unavailable are shown separately, with
   the exact command, exit code and bounded output.
9. **Review**: the diff, scope check, and AI review findings labelled separately from deterministic
   results; record a disposition for each blocking finding.
10. **Approve the pull request** (bound to the patch hash) and **create it**. Success is shown only
    after GitHub confirms; the PR body carries the evidence. Nothing is merged automatically.
11. **Governance**: members and roles, AI policy (cloud stays off unless opted in, with disclosure),
    budgets, quotas and concurrency limits, usage, and the append-only audit log.

## Recorded results

- 2026-11-02: a governed run on `PritBlitz/testRepo` produced pull request #1 end to end.
- 2026-11-03: local-model runs completed investigation and planning with valid, evidence-linked plans
  (stage timings in `docs/evaluations/workflow.md`).
- 2026-11-04: a governed run with the local 7B model, including one automatic repair, opened
  pull request [#2](https://github.com/PritBlitz/testRepo/pull/2) on `PritBlitz/testRepo` in 26.8 minutes.
- 2026-11-04: pull requests #3 to #7 followed, including one from a pull-request task (#4) and one from
  a real failing check on `master` (#6). See `docs/video-script.md` for a recording plan.
