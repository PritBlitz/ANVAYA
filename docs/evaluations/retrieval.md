# Evaluation: repository retrieval

Harness: `apps/api/test/retrieval.eval.spec.ts` (runs in the normal API suite and in CI).

## Method

- **Corpus**: the API's own TypeScript sources (`apps/api/src`, tests and the generated OpenAPI
  schema excluded): 98 files, indexed through the real pipeline — tarball → classifier → Tree-sitter
  chunking → embeddings → Postgres (`tsvector` + pgvector).
- **Questions**: 25 natural-language questions a developer would ask about this codebase, each
  labelled with the file(s) that answer it. Labels were checked against the code (for example, the
  file that raises `CSRF_TOKEN_INVALID`). Questions are phrased in plain English rather than copying
  identifiers, so lexical search gets no free matches.
- **Metrics**: per mode (`lexical`, `semantic`, `hybrid`), with results de-duplicated by file:
  recall@5 and recall@10 (a question is found if any relevant file ranks in the top k) and mean
  reciprocal rank of the first relevant file.
- **Embeddings**:
  - *mock* (default, CI): the test AI service's deterministic hashed bag-of-words embedding. It is
    not a semantic model; its "semantic" numbers measure the vector path and ranking, not meaning.
  - *live*: `EVAL_EMBEDDINGS=live` with the real AI service and `nomic-embed-text`.
- **Regression floors** enforced in CI: lexical and hybrid recall@10 ≥ 0.6 (live semantic ≥ 0.5).

Run it: `npx vitest run test/retrieval.eval.spec.ts` (add `EVAL_OUT=<file>` for JSON).

## Results (2026-11-03, mock embeddings)

| Mode | recall@5 | recall@10 | MRR |
|---|---|---|---|
| Lexical, before | 0.52 | 0.52 | 0.321 |
| **Lexical, after stop-word fix** | **0.60** | **0.60** | **0.397** |
| Semantic (mock) | 0.60 | 0.64 | 0.462 |
| Hybrid, before | 0.64 | 0.72 | 0.395 |
| **Hybrid, after stop-word fix** | **0.68** | **0.76** | **0.428** |

### Finding and fix
Lexical search OR-combines every query term as a **prefix** (`term:*`). In natural-language
questions, function words swamped the meaningful ones: `to:*` matched every `token`/`toString`,
`is:*` every `isValid`, `the:*` every `then`/`there`. `lexicalTerms()` now drops English function and
question words (falling back to the original terms if nothing else remains); identifiers are split
before the filter, so code queries are unaffected. The same function feeds code search, Q&A,
knowledge notes and the agent's context retrieval.

### Remaining misses (hybrid, top 10)
State-machine transitions, chunking, indexing exclusions, import resolution, workspace selection and
membership checks. Their answers use vocabulary the questions do not (`allowed`/`legal`,
`chunk`/`split`), which is what real semantic embeddings should close; the live run below is the
measurement for that.

## Live embeddings (2026-11-04)

AI service with `EMBEDDING_PROVIDER=ollama`, `nomic-embed-text` on CPU (Ollama 0.24, one loaded
model, one parallel request). The corpus had grown to 107 files since the mock run. Indexing took
about 15 minutes (≈50 s per 32-chunk embedding batch on a machine under memory pressure). Raw output:
[`retrieval-live.json`](retrieval-live.json).

| Mode | recall@5 | recall@10 | MRR |
|---|---|---|---|
| Lexical | 0.56 | 0.60 | 0.380 |
| **Semantic (live)** | **0.84** | **0.88** | **0.712** |
| **Hybrid (live)** | **0.88** | **0.92** | **0.638** |
| Hybrid, mock baseline (above) | 0.68 | 0.76 | 0.428 |

- Real embeddings close most of the vocabulary-gap misses listed above: hybrid recall@10 rises from
  0.76 to 0.92 and semantic alone reaches 0.88 (floor 0.5).
- Hybrid has higher recall but lower MRR than semantic alone: the fusion lets lexical matches outrank the
  best semantic hit on some questions. Tuning the fusion weights is a possible follow-up; the
  benchmark is the measurement for it.
- Remaining hybrid misses: "Which run status transitions are legal?" (`state-machine.ts`) and
  "Which files are skipped during indexing…" (`classifier.ts`).
- Fixed while measuring: `vitest.config.ts` pins `AI_SERVICE_URL`/`AI_SERVICE_TOKEN`, so live mode
  reads `EVAL_AI_SERVICE_URL`/`EVAL_AI_SERVICE_TOKEN`; live mode also gets a 60-minute timeout.

Command (in `apps/api`):

```sh
EVAL_EMBEDDINGS=live EVAL_AI_SERVICE_URL=http://127.0.0.1:8001 EVAL_AI_SERVICE_TOKEN=...   EVAL_OUT=docs/evaluations/retrieval-live.json npx vitest run test/retrieval.eval.spec.ts
```
