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

## Live embeddings

Not yet measured: it needs the AI service with Ollama (`nomic-embed-text`) running. Command:

```sh
EVAL_EMBEDDINGS=live AI_SERVICE_URL=http://127.0.0.1:8001 AI_SERVICE_TOKEN=... \
  EVAL_OUT=docs/evaluations/retrieval-live.json npx vitest run test/retrieval.eval.spec.ts
```
