# AI Service (internal)

`services/ai-service` — FastAPI. Called **only** by the control plane with
`Authorization: Bearer $AI_SERVICE_TOKEN`. Not exposed to browsers. Run:
`uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8001`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/internal/v1/generate` | Structured generation for a task |
| POST | `/internal/v1/embeddings` | Embeddings (`input_type: document|query`) |
| POST | `/internal/v1/providers/health` | Health of the provider for a mode |
| GET | `/health/live` | Liveness |

Errors: `{ "error": { "code", "message", "details" } }`. Codes: `UNAUTHENTICATED`,
`VALIDATION_FAILED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_NOT_CONFIGURED`, `MODEL_NOT_AVAILABLE`,
`PROVIDER_TIMEOUT`, `INVALID_MODEL_OUTPUT`, `BUDGET_EXCEEDED`, `PROVIDER_MISMATCH`,
`MODEL_NOT_ALLOWED`, `EMBEDDING_DIMENSION_MISMATCH`.

### Generate request
`{ task, mode: local|cloud|mock, provider?, model?, intent{}, evidence[], untrusted_inputs[], context?, budget{max_input_tokens,max_output_tokens,timeout_seconds} }`
Tasks: `repository_qa`, `investigation`, `planning`, `patch`, `repair`, `review`,
`verification_summary` (schemas in `app/schemas.py`).

Response: `{ task, provider, model, mode, prompt_version, output, evidence_included[], usage{input_tokens,output_tokens,estimated_cost_microunits}, duration_ms, schema_repair_attempted }`.

## Providers

| Mode | Provider | Status |
|---|---|---|
| `mock` | Deterministic, schema-valid outputs; no network | Implemented (CI, dry runs) |
| `local` | Ollama (`/api/chat` with JSON-schema `format`, temperature 0; `/api/embed`) | Implemented; tested via HTTP mock transport, **not yet against a live model** |
| `cloud` | `anthropic`: hosted Claude (Messages API, structured output) | Opt-in (`HOSTED_PROVIDER` includes `anthropic` + `ANTHROPIC_API_KEY`); tested against a fake HTTP transport, no live credentials |
| `cloud` | `openai_compatible`: any OpenAI-compatible `POST /chat/completions` server (OpenAI, vLLM, llama.cpp, LiteLLM) | Opt-in (`HOSTED_PROVIDER` includes `openai_compatible` + `OPENAI_COMPAT_BASE_URL` + `OPENAI_COMPAT_MODEL`; key optional for self-hosted). Strict `json_schema` response format by default (`OPENAI_COMPAT_RESPONSE_FORMAT=json_object|none` for servers without it). Tested against a fake server, no live credentials |

`HOSTED_PROVIDER` is `none` (default) or a comma-separated list of adapters. Routing resolves
exactly the requested mode and, for cloud, the provider the workspace policy names; an unnamed
cloud request is refused when more than one adapter is configured. There is **no fallback** to
another mode, provider or model (FR-AI-004), and hosted adapters do no hidden retries: rate limits
return `429 PROVIDER_RATE_LIMITED` with `retry_after_seconds` from the upstream `Retry-After`;
auth failures `503 PROVIDER_NOT_CONFIGURED`; rejected requests `502 PROVIDER_BAD_REQUEST`; refusals
or content filters `422 PROVIDER_REFUSED`. Keys come from server environment only and are never
logged or returned. In production `OPENAI_COMPAT_BASE_URL` must be https unless
`OPENAI_COMPAT_ALLOW_HTTP=true` (private network). Concurrency to Ollama is bounded
(`OLLAMA_MAX_CONCURRENCY`, default 1).

## Tasks and prompt versions (work package B)

- `planning.v2`: the planning instructions now tell the model to follow `template.guidance` from
  the trusted context where it does not conflict with the system rules.
- `migration_plan.v1`: plan-only migration plan. Output schema `MigrationPlan` = plan fields plus
  per-step `rollback`, `affected_areas` (with `evidence_ids`, which must be ids of evidence the
  model was shown, like citations), `prerequisites` and `rollback_strategy`.
- Fixed: `untrusted_inputs` (task descriptions, issue bodies) were accepted by `/generate` but not
  passed to the prompt builder, so the model never saw them. They now reach the prompt fenced as
  `<untrusted_input>` blocks (regression test in `tests/test_package_b.py`).

## Prompt and output safety

1. Segments: application system policy → task instructions + JSON schema → trusted intent →
   trusted context → `<untrusted_input>` (task/issue text) → `<untrusted_evidence>` (code).
2. Untrusted blocks are fenced (closing tags inside content are neutralized) and redacted.
3. Evidence is packed in rank order until the input token budget is met (tail dropped, not
   truncated mid-snippet); a context that alone exceeds the budget is rejected.
4. Output is parsed and validated against a strict Pydantic schema; **at most one** repair
   attempt; cited evidence ids must be among the evidence actually shown, otherwise the output is
   treated as invalid.
5. Logs contain metadata only (task, provider, token counts) — never prompts, evidence or output.

The control plane re-validates every output with its own Zod schema and maps evidence ids to
citations from its own records.
