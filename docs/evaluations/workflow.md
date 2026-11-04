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

## Full run to a pull request (2026-11-04)

Run `81cad19c` on `PritBlitz/testRepo` (`unique_word_count`) passed the live spec in 26.8 minutes and
opened [PritBlitz/testRepo#2](https://github.com/PritBlitz/testRepo/pull/2). 5 model calls, 9,200
input and 2,301 output tokens. This is the first run to reach a pull request after the 2026-11-04
fixes, and it exercised all three: patches carried file content, the repair stayed cumulative
(attempt 2: 3 files, +14/−5, against the base commit), and PR approval was enabled although
attempt 1 had failed checks.

| Stage | Duration | Notes |
|---|---|---|
| Context retrieval | 3 s | |
| Investigation | 6 min 52 s | |
| Planning | 6 min 4 s | |
| Plan approval → workspace | 4 s | Human gate, driven by the spec |
| Patch, attempt 1 | 5 min 24 s | |
| Verification, attempt 1 | 4 s | Failed: `compileall` and `unittest` exit 1; the repair's summary reports a syntax error in the test |
| Repair, attempt 2 | 4 min 26 s | |
| Verification, attempt 2 | 4 s | Passed: `compileall` and `unittest discover` |
| Review | 3 min 32 s | Two low-severity findings |
| PR approval → PR opened | 12 s | Human gate, driven by the spec |

Free RAM was 6.2 GB before the run and fell to 1.4 GB during it, with no memory failure.

Quality observed in the patch: the function, export and tests are correct, but the model also removed
the `if __name__ == "__main__": unittest.main()` block from `tests/test_core.py`, which the task did
not ask for, and left two files without a final newline. Verification still passed because it uses
`unittest discover`. The review stage did not report the removal; its two low-severity findings
were about documentation (although the function has a docstring) and a redundant empty-string test.
Human review of the diff remains necessary.

## Later runs on 2026-11-04

| Run | Task | Outcome |
|---|---|---|
| `7922104d` | `average_word_length` | Stopped in planning: the session's low-memory guard killed the stack at about 0.6 GB free |
| `eba7e669` | `average_word_length` | `VERIFICATION_FAILED`, the gate working as intended. Attempt 1 had a syntax error in the test; the repair fixed it but the test expected 5.0 where the correct value is 4.0, and the single repair was used up. No pull request was opened |
| `728acaf6` | `average_word_length`, two repairs allowed | Stopped about a minute into investigation, while the model was loading, by the same guard. Started with 7.3 GB free |

So of the three runs that reached a result on this task family, one produced a pull request and one
was correctly refused; the sample is too small to state a success rate. Starting with more free
memory did not prevent the second stop. The 7B model removed the test file's `__main__` block in both
completed runs, once despite being told to keep existing code, and attempt 1 failed on a syntax error
in the test file in both. Removal is now reported as a review finding.

## Failure modes found and fixed

Each was found by these runs, fixed with a regression test, and the run repeated:

| Symptom | Cause | Fix |
|---|---|---|
| Q&A through the web app failed with a bare 500 after 30 s | Next.js rewrite proxy's 30 s default timeout | `proxyTimeout` 660 s |
| Investigation failed as `AI_SERVICE_UNAVAILABLE` after exactly 300 s | Node `fetch`'s 300 s header timeout, below the policy limit | AI client uses its own undici pool; AbortSignal is the only deadline |
| Approved runs timed out right after a slow human approval | Duration budget counted time waiting at approval gates | Active time excludes `awaiting_*` states |
| Runs with a budget over 30 min failed on the first model call | Per-call timeout was the run's remaining time, above the AI service's 1800 s cap | Calls capped at the workspace `request_timeout_seconds` |
| Patch step `INVALID_MODEL_OUTPUT` | The live test asked for a function that does not exist in that repository | Test now uses a task that fits the repository |
| Patch and repair both `PATCH_INVALID` "missing content for …" (2026-11-04) | `content` was optional in the patch schema used as Ollama's decoding grammar, so the 7B model returned paths only | `content` is required (still nullable for deletes) |
| A three-file change became a one-line patch after a repair (2026-11-04) | The repair, validated against the already-patched workspace, was stored as the run's patch on its own | Repairs are composed onto the earlier patch and stored cumulatively against the base commit |
| PR approval stayed disabled although the repaired patch passed every check (2026-11-04) | The web gate counted the failed checks of the superseded attempt | The gate uses only the current patch's results |

## Known limits

- A 7B model on CPU is slow and memory-hungry: with ~1 GB of free RAM the machine ran out of memory
  twice. Recommended for CPU hosts: one loaded model, one concurrent request (CLAUDE.md §11), and
  workspace policy `request_timeout_seconds` ≈ 580 with a 3600 s run budget.
- Quality of patches from a 7B model varies; deterministic verification and human approval gates are
  what keep a weak patch from becoming a pull request.
