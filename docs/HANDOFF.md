# Handoff for the next session (written 2026-11-03, updated 2026-11-04)

Read this first, then `docs/CLAUDE.md` (the repository rulebook), `releases/V1.md` (scope and
decisions) and `docs/backend/REMAINING.md` (tracker). §2.1 and §2.2 are done; only the owner-only items
in §2.3 remain. Every capability in the canonical docs is built
and merged except GitLab/Bitbucket (out of scope by the owner's decision).

## 1. Non-negotiable rules from the owner

1. **Nothing on C:.** C: is nearly full (≈1 GB free at handoff). All installs, caches, models,
   logs, test output and temp files go on **Z:**. Before running anything, set
   `TEMP=Z:\anvaya-cache\tmp` and `TMP=Z:\anvaya-cache\tmp` for the processes you start.
   Known C: consumers you cannot avoid: the Windows page file (grows under memory pressure — keep
   RAM free), Docker Desktop's disk (`%LOCALAPPDATA%\Docker\wsl`, 23 GB), the Ubuntu WSL disk.
2. **Commits carry the owner's name only**: no `Co-Authored-By`, no mention of Claude/AI in commit
   messages or PR bodies. Check with `git log --format=%B -1 | grep -ic claude` (must be 0).
3. **Commit, push and merge to `main` regularly** (feature branches `feat/backend`, `feat/frontend`
   are worktrees at `Z:\ANVAYA\backend` and `Z:\ANVAYA\frontend`; `Z:\ANVAYA` is the `main` checkout).
4. **RAM is the binding constraint** (15.4 GB total, IntelliJ and browsers use several GB). The
   machine ran out of memory three times on 2026-11-03. Check free RAM before heavy work:
   `powershell -NoProfile -Command "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1)"`.
   The 7B model needs ≈5 GB free; do not start it with less.

## 2. What is left (in order)

### 2.1 Live-embedding retrieval benchmark — DONE 2026-11-04 (see docs/evaluations/retrieval.md)
Start Ollama + AI service (§3), then in `apps/api`:
```sh
EVAL_EMBEDDINGS=live EVAL_AI_SERVICE_URL=http://127.0.0.1:8001 EVAL_AI_SERVICE_TOKEN=<from apps/api/.env> \
  EVAL_OUT='Z:\ANVAYA\docs\evaluations\retrieval-live.json' npx vitest run test/retrieval.eval.spec.ts
```
The AI service must run with `EMBEDDING_PROVIDER=ollama` (its default). Add the numbers to
`docs/evaluations/retrieval.md` (section "Live embeddings") and compare with the mock baseline
(hybrid recall@10 0.76). The spec enforces live semantic recall@10 ≥ 0.5.

### 2.2 Full governed run ending in a real pull request — DONE 2026-11-04 (PritBlitz/testRepo#2)
Results are in `docs/evaluations/workflow.md`. Still waiting on the owner: whether to merge PR #2
(the model also removed the test file's `__main__` block), whether to revert the raised `pritblitz`
policy, and what to do with run `bccfc47a`, an older attempt parked at PR approval. The steps below
stay as the recipe for repeating a run; use a new task, because #1 and #2 already did these two.

Target: **`PritBlitz/testRepo`** in the owner's **`pritblitz`** workspace (connected, indexed;
the test account `dev@example.test` is already an **admin** there — the invitation was accepted).
Do **not** reuse the old hyphenation task: PR #1 already did it. Command (in `apps/web`, after §3):
```sh
PLAYWRIGHT_BROWSERS_PATH='Z:\anvaya-cache\ms-playwright' LIVE_BASE_URL=http://localhost:3000 \
LIVE_RUN=1 LIVE_MODE=local LIVE_WORKSPACE=pritblitz LIVE_REPO=PritBlitz/testRepo \
LIVE_TASK='Add unique_word_count(text) to textstats and a test for it' \
LIVE_TASK_DESCRIPTION='Add unique_word_count(text: str) -> int to textstats/core.py. It returns the number of distinct words, using tokenize() so case is ignored ("A a b" has 2). Export it from textstats/__init__.py and add unittest cases in tests/test_core.py, including the empty string (0).' \
npx playwright test -c playwright.live.config.ts -g "governed run"
```
Notes:
- The spec raises the `pritblitz` workspace's AI policy to local mode, `request_timeout_seconds`
  580 and a 3600 s run-duration ceiling. **Tell the owner** it did this and offer to revert.
- The worker must run with the normal `.env` (`REPOSITORY_SOURCE=github`) for testRepo, and with
  `EXECUTION_DRIVER=docker` locally (gVisor is CI/Linux only).
- Expect ≈15–25 min of model time. Watch stages with
  `psql ... -c "select status, error_code from workflow_runs order by created_at desc limit 1"`.
- Never run two Playwright processes at once (they share `test-results` and kill each other).
- On success the spec prints `PR: https://github.com/PritBlitz/testRepo/pull/<n>`. Record it in
  `docs/evaluations/workflow.md` and `docs/demo-walkthrough.md` ("Recorded results").

### 2.2a Live checks — DONE 2026-11-04
PR tasks, failing-check tasks with job logs, webhooks through smee, and `narrow` on unittest all
worked in live runs (`docs/evaluations/workflow.md`). The removed-code finding has only been run on
the real PR #2 patch, not in a live run. `pritblitz` keeps `max_repair_attempts: 2`; `test_selection`
is off again. testRepo has CI and open test pull requests #2 to #7. Run the stack with
`scripts/dev-stack.ps1`: background tasks started by Claude Code can be killed by its low-memory
guard. Do not push to `main` during a live run: `PritBlitz/ANVAYA` is connected, and with the
webhook relay up that starts a large re-index.

### 2.3 Owner-only / needs accounts (report, don't attempt)
- Independent security assessment of the gVisor execution plane (SECURITY §7).
- Applying `infra/aws` (validated in CI, never applied; needs an AWS account and budget).
- Live tests of the hosted providers (Anthropic, OpenAI-compatible) — fakes only so far.
- Webhooks locally need `npx smee-client` pointed at the App's smee channel and `/api/v1/webhooks/github`.

### 2.4 Housekeeping
- `Z:\ANVAYA\apps\api\node_modules` and `Z:\ANVAYA\apps\web\node_modules` in the main checkout are
  **directory junctions** to the worktrees' `node_modules`. Remove them with `cmd /c rmdir <path>`
  (never `rm -rf`, which would delete the target). Turbopack refuses to build through the web junction;
  run web builds/E2E in `Z:\ANVAYA\frontend\apps\web`.

## 3. How to start the stack (everything from Z:)

Prerequisites: Docker Desktop running; `docker start anvaya-dev-postgres-1 anvaya-dev-redis-1`.

1. **Ollama from Z:** (the WSL system service reads models from C:; do not use it). In Git Bash:
   ```sh
   MSYS_NO_PATHCONV=1 wsl -e env OLLAMA_MODELS=/mnt/z/ollama/models OLLAMA_HOST=127.0.0.1:11435 \
     OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1 /usr/local/bin/ollama serve
   ```
   Run it as a background task (a detached `nohup` dies when the WSL shell exits).
   `MSYS_NO_PATHCONV=1` is required, or Git Bash rewrites `/usr/...` into `C:/Program Files/Git/...`.
   Models on Z:: `qwen2.5-coder:7b`, `nomic-embed-text` (`curl localhost:11435/api/tags`).
2. **AI service** (`Z:\ANVAYA\backend\services\ai-service`, venv `.venv`):
   ```sh
   export AI_SERVICE_TOKEN="$(grep -E '^AI_SERVICE_TOKEN=' ../../apps/api/.env | cut -d= -f2-)" \
     NODE_ENV=development OLLAMA_BASE_URL=http://127.0.0.1:11435 PYTHONDONTWRITEBYTECODE=1
   .venv/Scripts/python -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8001
   ```
3. **API and worker** (`Z:\ANVAYA\backend\apps\api`): `npm run build`, `npm run migrate`, then
   `node --env-file=.env dist/main.js` and `node --env-file=.env dist/main.worker.js`
   (the `npm start` scripts do **not** load `.env`).
4. **Web** (`Z:\ANVAYA\frontend\apps\web`):
   `NEXT_PUBLIC_API_MODE=http ANVAYA_API_ORIGIN=http://localhost:3001 NEXT_TELEMETRY_DISABLED=1 npm run build`
   then `node node_modules/next/dist/bin/next start -p 3000` (run `next` directly; stopping an
   `npx` wrapper leaves the server running and holding the port).
5. Check: `curl localhost:3000/api/v1/health/ready` (web → API proxy), `curl localhost:8001/health/live`.

Stopping: `TaskStop` only kills the shell wrapper; find and stop the real `node`/`python` processes
(PowerShell `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`, match the command line).

## 4. Testing cheatsheet

- API (`apps/api`): `npm run typecheck`, `npm run lint`, `npx vitest run` (uses `anvaya_test`,
  Redis db 1; `anvaya_test_a/_b` exist for parallel checkouts). Last full run: 365 passed, 13 skipped.
- AI service: `.venv/Scripts/python -m ruff check app tests`, `ruff format --check app tests`,
  `mypy app`, `pytest -q` (62 passed).
- Web (`apps/web`): `npm run format:check` (in a CRLF checkout use `npx prettier --check . --end-of-line auto`),
  `npm run typecheck` (= `next typegen && tsc --noEmit`), `npm run lint`, `npm test` (147),
  `PLAYWRIGHT_BROWSERS_PATH='Z:\anvaya-cache\ms-playwright' npx playwright test` (27 + 1 skipped).
- API contract: `npm run build && npm run openapi` in `apps/api` writes `apps/api/openapi.json` and
  `packages/contracts/openapi.json`; then `npm run gen:api` in `apps/web`. CI fails on drift.
- **Never pipe a check through `tail` in an `&&` chain** — it hides the exit code (this caused a
  wrong "typecheck passed" report once). Redirect to a file and echo `$?`.
- CI status without `gh`: `curl -s "https://api.github.com/repos/PritBlitz/ANVAYA/actions/runs?head_sha=<sha>"`;
  failure details: `.../check-runs/<job id>/annotations` (public). Pushing to `main` cancels the
  in-progress run of the same workflow (`cancel-in-progress`), so wait before pushing again.

## 5. Facts that are easy to get wrong

- Downloading/executing tool binaries (e.g. `runsc`) was blocked by the permission classifier;
  gVisor is verified in CI instead (`sandbox-gvisor` job). Docker images from official registries
  were fine (`hashicorp/terraform`, `pgvector`).
- Production config refuses: dev login, insecure cookies, `local_fixture` source, the Docker sandbox,
  WSL path mapping, an unproxied gVisor fetch network, a missing AI service token.
- Migrations on `main`: 0001–0007, 0010 and 0011 (0008/0009 intentionally unused). Next: 0012.
- The dev database's Docker clock drifts; order "latest" rows by identity/sequence, not `created_at`.
- GitHub App: `anvaya-dev`, installed on the owner's account and bound to the `pritblitz` workspace;
  a repository can be attached to only one workspace at a time.
