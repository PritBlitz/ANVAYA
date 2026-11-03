# Evaluation: governed workflow with a local model

## Method

End-to-end governed runs driven through the real web UI by `apps/web/e2e-live/live.spec.ts`
(`LIVE_RUN=1 LIVE_MODE=local`): create a task → retrieval → investigation → planning → human plan
approval → workspace → patch → sandboxed verification → review → PR approval → pull request. Stack:
Next.js (http mode) → NestJS API and worker → FastAPI AI service → Ollama `qwen2.5-coder:7b` and
`nomic-embed-text` on CPU (a 15 GB Windows laptop, WSL2), Docker sandbox. Stage timings come from
`run_state_transitions`; failures from `workflow_runs.error_code` and `agent_steps`.

## Observed stage timings (2026-11-03)

| Stage | Duration | Notes |
|---|---|---|
| Context retrieval | 4–6 s | ~5 min once while Ollama finished a cancelled run's call (one request at a time) |
| Investigation | 3–8 min | Longer under memory pressure |
| Planning | 5–6 min | Plans were schema-valid and cited the right file |
| Plan approval → workspace | < 1 s | Human gate |
| Patch generation | 1–2 min | |
| Q&A (single question) | 60 s | With code and knowledge-note citations |

A full run on CPU therefore needs roughly 15–25 minutes of model time; the default 15-minute run
budget is too small for CPU-only local models (see the defaults below).

## Failure modes found and fixed

Each was found by these runs, fixed with a regression test, and the run repeated:

| Symptom | Cause | Fix |
|---|---|---|
| Q&A through the web app failed with a bare 500 after 30 s | Next.js rewrite proxy's 30 s default timeout | `proxyTimeout` 660 s |
| Investigation failed as `AI_SERVICE_UNAVAILABLE` after exactly 300 s | Node `fetch`'s 300 s header timeout, below the policy limit | AI client uses its own undici pool; AbortSignal is the only deadline |
| Approved runs timed out right after a slow human approval | Duration budget counted time waiting at approval gates | Active time excludes `awaiting_*` states |
| Runs with a budget over 30 min failed on the first model call | Per-call timeout was the run's remaining time, above the AI service's 1800 s cap | Calls capped at the workspace `request_timeout_seconds` |
| Patch step `INVALID_MODEL_OUTPUT` | The live test asked for a function that does not exist in that repository | Test now uses a task that fits the repository |

## Known limits

- A 7B model on CPU is slow and memory-hungry: with ~1 GB of free RAM the machine ran out of memory
  twice. Recommended for CPU hosts: one loaded model, one concurrent request (CLAUDE.md §11), and
  workspace policy `request_timeout_seconds` ≈ 580 with a 3600 s run budget.
- Quality of patches from a 7B model varies; deterministic verification and human approval gates are
  what keep a weak patch from becoming a pull request.
