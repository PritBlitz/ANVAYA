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

## All runs on 2026-11-04

| Run | Source | Task | Outcome |
|---|---|---|---|
| `81cad19c` | Manual | `unique_word_count` | PR #2, after one repair |
| `1bb61b27` | Manual | `contains_word` | PR #3, first attempt, 4 model calls |
| `58b77b25` | Pull request | Imported from PR #2 | PR #4, first attempt, 21.5 min |
| `c0c78739` | Manual | `top_words` rejects a non-integer `n` | PR #5, first attempt, +6/−0 |
| `e223d4ae` | Failing check | Off-by-one bug in `word_count` on `master` | PR #6, first attempt, one-line fix, 18.7 min |
| `e1c834f2` | Manual | `unique_word_count`, reworded | PR #7, first attempt |
| `eba7e669`, `c4cea93a`, `62a11925`, `37cea529` | Manual | `average_word_length` | Refused by verification or patch validation; no PR |
| `e2814495` | Failing check | A deliberately wrong test on `master` | Refused: the plan changed the code and left the test out of scope |
| `907446c1` | Failing check | Same | `PROVIDER_TIMEOUT`: the raw job log overflowed the 4096-token context (since fixed) |

Stopped before a result, and not counted: `7922104d` and `728acaf6` (Claude Code's low-memory guard),
`f4cb2178` (stack stopped by hand), `fcf8c52e` (garbled launch).

Five of seven different tasks reached a pull request (the two `unique_word_count` wordings count as
one task). With the repair fixes in place there were seven attempts: five pull requests and two
refusals. This is a small sample on one small repository and is not a success rate. No patch with
failing checks reached a pull request, but passing checks do not make a patch good: PR #2 passed
while dropping the test file's `__main__` block. `average_word_length` shows the
model's limit: it fixed its syntax error but stayed convinced that "the quick brown fox" averages
5.0, and the test failed every time.

Findings from these runs:

- Temperature 0 makes the model repeat itself, so rerunning one task is weak evidence and a repair
  could reproduce the same broken file. Repairs now use temperature 0.3.
- The AI reviewer is unreliable at this size: it reported a missing docstring on a documented
  function and questioned correct code. Deterministic results are what to trust.
- The removed-code finding did not fire in a live run, because no patch that reached review removed
  code. Run over the real patch from PR #2, it reports exactly the two deleted `__main__` lines.
- `test_selection: narrow` ran under real Docker on unittest, recording why each file was selected.
- A push to a large connected repository starts a re-index that competes with a local model for
  memory: one started the moment a run was killed. Avoid pushing to it during live runs.

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
| A second repair produced nothing useful (2026-11-04) | A rejected repair overwrote the failure being repaired, so the next attempt could not see the error | The failure is kept and the rejection is added to it |
| Repairs returned the file unchanged (2026-11-04) | The prompt pointed at the wrong input, and temperature 0 repeated the same output | Prompt `repair.v2` names the check output; repairs use temperature 0.3 |
| Failing-check task timed out in planning (2026-11-04) | The whole Actions log doubled the prompt and exceeded the 4096-token context | Only the failing step's output is imported |

## Known limits

- A 7B model on CPU is slow and memory-hungry: with ~1 GB of free RAM the machine ran out of memory
  twice. Recommended for CPU hosts: one loaded model, one concurrent request (CLAUDE.md §11), and
  workspace policy `request_timeout_seconds` ≈ 580 with a 3600 s run budget.
- Quality of patches from a 7B model varies; deterministic verification and human approval gates are
  what keep a weak patch from becoming a pull request.
