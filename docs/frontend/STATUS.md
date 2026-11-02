# Frontend implementation status

**Branch:** `feat/frontend` · **Last verified:** 2026-11-02 · **Data source verified against:** fixture adapter only.

## Release scope used

There is no `releases/V1.md` yet. The frontend targets ROADMAP phases 1–6 (identity → repositories and indexing → grounded Q&A → tasks and plan approval → controlled execution → review and PR handoff), plus the PRD §10 information architecture. Out of scope until endpoints exist: symbol explorer and dependency map (GAP-15), invitation management (GAP-17), knowledge capture from completed runs (PRD §7.9 beyond manual notes), GitLab/Bitbucket.

## Milestones and acceptance criteria

| #   | Milestone                     | Acceptance criteria                                                                                                                                                                                                                                                                                       | Status                                  |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| M0  | Foundation                    | Strict TS, lint (0 warnings), formatter, unit + E2E harness, production build                                                                                                                                                                                                                             | ✅ Done                                 |
| M1  | Design system                 | Tokens for both themes, primitives, docs; AA contrast verified by axe                                                                                                                                                                                                                                     | ✅ Done                                 |
| M2  | API layer                     | Typed client for every API_SPEC endpoint; envelope/errors/retries/idempotency/CSRF/SSE; fixture adapter switchable by env                                                                                                                                                                                 | ✅ Done (fixtures); ⏳ real API pending |
| M3  | Auth, onboarding, shell       | Sign-in, 401 redirect with safe `next`, workspace creation, GitHub install with `state` check, switcher, ⌘K, mobile nav                                                                                                                                                                                   | ✅ Done (fixtures); ⏳ GAP-01, GAP-14   |
| M4  | Repository intelligence       | Connect → index with live progress; coverage, exclusions, limitations; code viewer with permalinks; hybrid search; grounded Q&A that refuses to invent citations                                                                                                                                          | ✅ Done (fixtures); ⏳ GAP-03, GAP-04   |
| M5  | Tasks and runs                | Create task (manual/issue/PR/check), start run with mode disclosure and budget cap, live timeline via SSE with polling fallback, cancel, retry                                                                                                                                                            | ✅ Done (fixtures); ⏳ GAP-05           |
| M6  | Plan approval                 | Investigation with evidence links, hypotheses labelled, plan edit (schema-validated), approve, reject-with-reason, version and hash shown                                                                                                                                                                 | ✅ Done; ⏳ GAP-07 binding              |
| M7  | Changes, verification, review | Diff viewer and scope check; deterministic checks grouped (passed/failed/skipped/unavailable); AI vs deterministic findings; dispositions                                                                                                                                                                 | ✅ Done                                 |
| M8  | PR handoff                    | Evidence gate, approval bound to patch hash (displayed), composer with evidence-backed body, idempotent create, success only after server confirmation                                                                                                                                                    | ✅ Done; ⏳ GAP-08, GAP-19              |
| M9  | Governance                    | Members and roles, integrations, AI policy (cloud opt-in with disclosure), budgets, health check, audit log, usage                                                                                                                                                                                        | ✅ Done (fixtures)                      |
| M11 | Public homepage               | `/` is public, static, and indexable. How it works is scroll-driven with motion that respects reduced motion. Real screenshots in light and dark. AA contrast verified by axe on desktop and mobile. No horizontal overflow at 390px. CTAs lead to sign-in, and signed-in users reach the app via `/app`. | ✅ Done                                 |
| M10 | Real backend integration      | Run E2E suite against NestJS in `http` mode; reconcile GAP list                                                                                                                                                                                                                                           | ⏳ Blocked on backend                   |

## Verification (commands actually run)

| Check                       | Command (in `apps/web`)         | Result                                                                                                                                   |
| --------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Format                      | `npm run format:check`          | ✅ pass                                                                                                                                  |
| Types                       | `npm run typecheck`             | ✅ pass                                                                                                                                  |
| Lint                        | `npm run lint` (max-warnings 0) | ✅ pass                                                                                                                                  |
| Unit / component / contract | `npm test`                      | ✅ 87 tests, 7 files                                                                                                                     |
| E2E + accessibility         | `npm run test:e2e`              | ✅ 17 passed, 1 skipped by design (desktop journeys, homepage on desktop and mobile, mobile layout); axe WCAG 2.1 AA scans on 10 screens |
| Build                       | `npm run build`                 | ✅ 34 routes (`/` and `/app` static)                                                                                                     |

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

Problems found and fixed while building the homepage:

- Badges rendered their icons on a separate line, because preflight makes SVGs `display:block`.
- The "Review plan" call to action was repeated on the Plan tab.
- At 390px, grid columns and a background glow overflowed horizontally. Fixed with `min-w-0` and `overflow-x: clip`, which keeps sticky positioning working.
- Wine text on the always-dark band failed contrast and now uses the `link` token.
- Fading inactive steps failed contrast; they now use a colour change instead.
- The diagram's scroll container wasn't focusable.
- A model-name badge used `opacity-80`, which pushed it below contrast.

## Known limitations / follow-ups

- Homepage screenshots must be regenerated (`npm run screenshots` with the dev server running) whenever the product UI changes.

1. Not yet exercised against the real API. Every shape assumption is listed in `API_INTEGRATION.md`.
2. No Content-Security-Policy header yet. Next 16 needs nonce wiring in `proxy.ts`, so do it once auth is final.
3. No syntax highlighting in the code viewer (FD-8).
4. Q&A history is per browser session; the API has no history endpoint.
5. Lists load up to 100 items; infinite scrolling is only wired for the audit log.
6. Browser E2E coverage is Chromium only (desktop and Pixel 7). Add WebKit and Firefox in CI.
7. Contract types should move to `packages/contracts` when that package exists.
8. Next auto-writes `apps/web/AGENTS.md`; it is intentionally kept.

## Outstanding backend dependencies

These block a real end-to-end run: GAP-01 (auth), GAP-02 (workspace scoping), GAP-03 (available repositories), GAP-04 (file content), GAP-05 (run list), GAP-14 (GitHub setup URL), GAP-19 (approvals on run detail). All other gaps need shape confirmation only. Details are in `API_INTEGRATION.md`.
