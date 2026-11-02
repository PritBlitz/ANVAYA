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
| `cloud` | — | **Not implemented**: requests fail `503 PROVIDER_NOT_CONFIGURED` |

Routing resolves exactly the requested mode; there is **no fallback** to another mode or
provider (FR-AI-004). Concurrency to Ollama is bounded (`OLLAMA_MAX_CONCURRENCY`, default 1).

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
