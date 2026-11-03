# @anvaya/contracts

The single shared source of Anvaya's public API contract.

- `openapi.json` — OpenAPI 3 document for every JSON route under `/api/v1`, with response schemas
  (real enums, typed nested shapes). **Generated, never edited by hand**: `npm run build && npm run
  openapi` in `apps/api` writes it here and to `apps/api/openapi.json`.
- Consumers:
  - `apps/api` — `test/openapi.spec.ts` and `test/response-contract.ts` hold every response to it;
    `test/security.spec.ts` derives its route list from it.
  - `apps/web` — `npm run gen:api` generates `src/lib/api/generated/openapi.ts` from this file, and
    the hand-written wire types are type-checked against the generated ones.
- CI: backend-ci fails if either copy differs from what the code generates; web-ci fails if the
  generated web types differ from this file.

The web app keeps its generated copy inside `apps/web` because its build (Turbopack and the
container image) compiles only files within `apps/web`. Behavioural notes that a schema cannot
express — SSE event names, error codes, idempotency and workspace-scoping rules — are in
`docs/backend/API_CONTRACT_NOTES.md`.
