# Frontend implementation status

**Branch:** `feat/frontend` · **Last verified:** 2026-11-03 · **Data source verified against:** fixture adapter (E2E) and the live NestJS API in `http` mode (`npm run test:live`, backend `44bbdb9`).

## Release scope used

There is no `releases/V1.md` yet. The frontend targets ROADMAP phases 1–6 (identity → repositories and indexing → grounded Q&A → tasks and plan approval → controlled execution → review and PR handoff), plus the PRD §10 information architecture. Out of scope: knowledge capture from completed runs (PRD §7.9 beyond manual notes) and GitLab/Bitbucket. The symbol explorer and dependency map (GAP-15) shipped on 2026-11-03.

## Milestones and acceptance criteria

| #   | Milestone                     | Acceptance criteria                                                                                                                                                                                                                                                                                       | Status                                                                                |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| M0  | Foundation                    | Strict TS, lint (0 warnings), formatter, unit + E2E harness, production build                                                                                                                                                                                                                             | ✅ Done                                                                               |
| M1  | Design system                 | Tokens for both themes, primitives, docs; AA contrast verified by axe                                                                                                                                                                                                                                     | ✅ Done                                                                               |
| M2  | API layer                     | Typed client for every API_SPEC endpoint; envelope/errors/retries/idempotency/CSRF/SSE; fixture adapter switchable by env                                                                                                                                                                                 | ✅ Done (fixtures + live API)                                                         |
| M3  | Auth, onboarding, shell       | Sign-in, 401 redirect with safe `next`, workspace creation, GitHub install with `state` check, switcher, ⌘K, mobile nav                                                                                                                                                                                   | ✅ Done (fixtures + live API)                                                         |
| M4  | Repository intelligence       | Connect → index with live progress; coverage, exclusions, limitations; code viewer with permalinks; hybrid search; grounded Q&A that refuses to invent citations                                                                                                                                          | ✅ Done (fixtures + live API)                                                         |
| M5  | Tasks and runs                | Create task (manual/issue/PR/check), start run with mode disclosure and budget cap, live timeline via SSE with polling fallback, cancel, retry                                                                                                                                                            | ✅ Done (fixtures + live API)                                                         |
| M6  | Plan approval                 | Investigation with evidence links, hypotheses labelled, plan edit (schema-validated), approve, reject-with-reason, version and hash shown                                                                                                                                                                 | ✅ Done (fixtures + live plan view)                                                   |
| M7  | Changes, verification, review | Diff viewer and scope check; deterministic checks grouped (passed/failed/skipped/unavailable); AI vs deterministic findings; dispositions                                                                                                                                                                 | ✅ Done                                                                               |
| M8  | PR handoff                    | Evidence gate, approval bound to patch hash (displayed), composer with evidence-backed body, idempotent create, success only after server confirmation                                                                                                                                                    | ✅ Done (fixtures); live PR flow pending                                              |
| M9  | Governance                    | Members and roles, integrations, AI policy (cloud opt-in with disclosure), budgets, health check, audit log, usage                                                                                                                                                                                        | ✅ Done (fixtures)                                                                    |
| M11 | Public homepage               | `/` is public, static, and indexable. How it works is scroll-driven with motion that respects reduced motion. Real screenshots in light and dark. AA contrast verified by axe on desktop and mobile. No horizontal overflow at 390px. CTAs lead to sign-in, and signed-in users reach the app via `/app`. | ✅ Done                                                                               |
| M12 | Code intelligence             | Symbol search by name/kind/path with paging; symbol source, outgoing and incoming references linked to code; file-level dependency map with scope, importers/imports and import-line links, externals; fixture parity                                                                                     | ✅ Done (fixtures + live API)                                                         |
| M13 | Q&A memory and polish         | Knowledge-note citations; per-user saved Q&A history with removal; syntax highlighting (FD-8); Content-Security-Policy with zero violations                                                                                                                                                               | ✅ Done (fixtures + live API)                                                         |
| M14 | Work package B (V1)           | Template picker in the create-task dialog (prefill, constraints summary) and admin template screen; plan-only migration plans (migration section, rollback, plan-only approval note); call graph in the symbol explorer; heuristic impact and test selection on Changes and Verification with evidence paths linked to code; workspace search/Q&A with provenance; hosted provider choice with per-provider disclosure. Fixture parity for every new endpoint                                                                                                                                                                                                   | ✅ Done (fixtures; API contract checked by `contract.ts` against the regenerated OpenAPI types). Not run against the live stack |
| M10 | Real backend integration      | Run E2E suite against NestJS in `http` mode; reconcile GAP list                                                                                                                                                                                                                                           | 🟡 Live suite green through plan approval; real-model PR run pending workspace access |

## Verification (commands actually run)

| Check                       | Command (in `apps/web`)         | Result                                                                                                                                         |
| --------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Format                      | `npm run format:check`          | ✅ pass                                                                                                                                        |
| Types                       | `npm run typecheck`             | ✅ pass                                                                                                                                        |
| Lint                        | `npm run lint` (max-warnings 0) | ✅ pass                                                                                                                                        |
| Unit / component / contract | `npm test`                      | ✅ 120 tests, 10 files                                                                                                                         |
| E2E + accessibility         | `npm run test:e2e`              | ✅ 20 passed, 1 skipped by design (desktop journeys, homepage on desktop and mobile, mobile layout, CSP); axe WCAG 2.1 AA scans on 14 screens  |
| Live stack (I-9)            | `npm run test:live`             | ✅ sign-in, repository intelligence (code, symbols, dependencies, search), Q&A with saved history; governed run verified through plan approval |
| Build                       | `npm run build`                 | ✅ 34 routes (`/` and `/app` static)                                                                                                           |

What the tests cover:

- Formatting and URL safety, including open-redirect cases.
- Line ranges, highlighting and diff parsing.
- Status, phase, event and permission rules.
- API client: envelopes, headers, CSRF, network errors, retry policy.
- Fixture contract: auth, tenant isolation, roles, idempotency replay and conflict, validation errors, cloud refusal, budget clamping, the full approval-gated lifecycle, blocking findings, cancel and retry, citation refusal, excluded files, SSE.
- Form schemas, plan editing, PR gate and PR body.
- Components: `Field` ARIA wiring, `Button` loading, `ErrorState`, `RichText` XSS safety, `CodeView`, and `FileTree` keyboard navigation.
- E2E journeys: auth redirect, the full task → plan → verification → review → PR flow, blocking findings, search and Q&A to cited lines, onboarding with GitHub install and indexing, forged install `state`, viewer read-only, command palette and dark theme persistence, mobile nav and overflow.

Problems found and fixed during browser verification:

- `fg-subtle` text and the neutral badge failed AA contrast; their colors were re-stepped.
- Two menu triggers had accessible names that didn't match their visible text.
- A `span` carried an `aria-label` without a role.
- The fixture adapter shared object references with the query cache, which hid an update.
- The create-task dialog reopened on browser Back because of Activity route preservation.

Problems found and fixed against the live stack (2026-11-03):

- The `/api/v1` rewrite proxy dropped requests after Next's default 30s, so every local-model Q&A or planning call through the web app failed with a bare `500`. `experimental.proxyTimeout` is now 660s, a little over the API's 600s provider maximum, so the API returns a typed `PROVIDER_TIMEOUT` instead. Verified: a `qwen2.5-coder:7b` Q&A through the web origin answered in 60s with code and knowledge citations.

Problems found and fixed while building the homepage:

- Badges rendered their icons on a separate line, because preflight makes SVGs `display:block`.
- The "Review plan" call to action was repeated on the Plan tab.
- At 390px, grid columns and a background glow overflowed horizontally. Fixed with `min-w-0` and `overflow-x: clip`, which keeps sticky positioning working.
- Wine text on the always-dark band failed contrast and now uses the `link` token.
- Fading inactive steps failed contrast; they now use a colour change instead.
- The diagram's scroll container wasn't focusable.
- A model-name badge used `opacity-80`, which pushed it below contrast.

## Known limitations / follow-ups

- Two pre-existing accessibility issues on the run Changes view were found by axe while adding
  the impact panel and are **not fixed** in work package B: the AI patch-summary alert's
  secondary text fails colour contrast, and the diff table's horizontal scroll region is not
  keyboard-focusable. The package-B E2E scans only the impact panel on that page.

- Homepage screenshots must be regenerated (`npm run screenshots` with the dev server running) whenever the product UI changes.

1. Live API checks cover sign-in, repository health, lazy code tree, file view, search, Q&A (mock and real local model), SSE through to the plan gate, plan view with resolved evidence, settings, usage, members, and audit. One governed run went all the way to a real pull request on 2026-11-02 (`PritBlitz/testRepo#1`). `npm run test:live` skips its own PR step unless `LIVE_RUN=1`, because it opens a real PR.
2. The CSP is static, so scripts need `'unsafe-inline'` (Next's inline bootstrap). Nonces would force every page dynamic and break the static homepage (M11). Everything else is same-origin-only, framing is denied, and E2E asserts zero violations.
3. Syntax highlighting is a small built-in lexer (TS/JS family, Python, JSON, shell). Other languages render plain.
4. The dependency map is a navigable list rather than a drawn graph, because it has to scale to 2,000 files and stay keyboard and screen-reader friendly.
5. Lists load up to 100 items; infinite scrolling is only wired for the audit log.
6. Browser E2E coverage is Chromium only (desktop and Pixel 7). Add WebKit and Firefox in CI.
7. Contract types should move to `packages/contracts` when that package exists.
8. Next auto-writes `apps/web/AGENTS.md`; it is intentionally kept.

## Outstanding backend dependencies

Resolved by the backend: GAP-01, 02, 03, 04, 05, 07, 08, 10, 14, 17, 19, 21 and R1–R6. Open: R7 (response schemas in `openapi.json`, so `wire.ts` can be generated), GAP-15 (symbol and module map), and task sources beyond `manual` and `github_issue`. Details are in `API_INTEGRATION.md` §4.
