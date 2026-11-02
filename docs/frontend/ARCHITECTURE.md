# Frontend architecture

**App:** `apps/web` · Next.js 16.4 (App Router, Turbopack, Cache Components + Partial Prefetching) · React 19.3 · TypeScript (strict, `noUncheckedIndexedAccess`) · Tailwind CSS 4.

## 1. Directory layout

```
apps/web/
  src/
    app/                  Routes only. Each page.tsx is a thin server component that renders a feature screen.
    components/
      ui/                 Design-system primitives (no data fetching, no domain knowledge)
      domain/             Domain presentation shared across features (status badges, RichText)
      layout/             App shell: sidebar, command palette, page frame, workspace gate
    features/<area>/      Screens and feature components (auth, onboarding, overview, repositories,
                          code, search, ask, knowledge, tasks, runs, usage, settings, marketing)
    lib/
      api/                Contract types, client, transports, endpoints, query hooks, fixtures/
      domain/             Pure domain rules: status meta, permissions, event descriptions
      workspace/          Active-workspace context
      utils/              Formatting, URL safety, cn()
      code.ts, diff.ts    Line ranges, highlighting, unified-diff parsing
      forms.ts            Server-error → form-field mapping, error toasts
      theme.tsx           Light/dark/system with a no-flash inline script
    test/setup.ts         Vitest + Testing Library setup
  e2e/                    Playwright journeys (+ axe accessibility scans)
  scripts/                capture-screenshots.mjs (homepage imagery)
```

Dependency direction: `app → features → (components, lib)`; `components/ui` depends only on `lib/utils`; `lib/*` never imports from `features` or `app`.

## 2. Rendering model

- The product is authenticated, highly interactive, and backed by an external API with a cookie session. Screens are **Client Components** using TanStack Query; route files and layouts stay **Server Components**.
- With Cache Components enabled, every route prerenders a static shell (fonts, theme script, skeleton); URL-dependent content streams in. `/w/[slug]` routes are Partial Prerendered (◐).
- Client hooks that read the URL (`useParams`, `useSearchParams`) sit under the workspace layout's `<Suspense>` boundary, as Next 16 requires.
- `/integrations/github/callback` is client-only (`next/dynamic`, `ssr:false`) because it validates against `sessionStorage`.
- Next keeps up to three recent routes mounted but hidden (Activity). Effects (SSE, polling, timers) clean up while hidden; dialogs open from URL state; flows that leave a "create" dialog use `router.replace`.

## 3. State management

| State                                                                                 | Where                                                                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Server data                                                                           | TanStack Query. Keys in `qk` (`lib/api/queries.ts`); every tenant key starts with `["ws", workspaceId]`. |
| Live run progress                                                                     | SSE (`features/runs/use-run-events.ts`) invalidating query keys; polling fallback when disconnected.     |
| Index progress                                                                        | Polling `index-status` while queued/indexing (GAP-11).                                                   |
| Active workspace                                                                      | URL slug → `WorkspaceProvider` → `X-Workspace-Id` header.                                                |
| UI view state (tabs, filters, search query, file, line range, open "new task" dialog) | URL search params.                                                                                       |
| Ephemeral form state                                                                  | react-hook-form + zod schemas (exported and unit-tested).                                                |
| Theme                                                                                 | `localStorage` + inline pre-paint script.                                                                |

No global client store was needed; adding one would duplicate server state.

## 4. Security posture (frontend)

Same-origin API proxy; HttpOnly cookie session (GAP-01); CSRF header on mutations; idempotency keys on side effects; `safeNextPath` against open redirects; GitHub install `state` validation; repository content and model output rendered as text only; no secrets in `NEXT_PUBLIC_*`; security headers in `next.config.ts`. UI permission checks only shape affordances — the server is authoritative.

## 5. Key decisions

| #     | Decision                                                                                                           | Why                                                                                                                                                      | Alternatives considered                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| FD-1  | Place the app at `apps/web`                                                                                        | CLAUDE.md §3 intended structure                                                                                                                          | Repo root (conflicts with backend)                                                      |
| FD-2  | Keep Next 16 defaults: Cache Components + Partial Prefetching                                                      | Framework direction; static shells load instantly                                                                                                        | Disabling them (would need removing later)                                              |
| FD-3  | Client-side data with TanStack Query; no server-side API calls                                                     | Cookie session lives in the browser ↔ API path; fixtures run in the browser; needs polling, retries, invalidation                                        | RSC fetching with cookie forwarding — revisit for first-paint data once the API is live |
| FD-4  | Transport abstraction with an in-browser fixture adapter that emulates the HTTP contract                           | Lets UI be built and E2E-tested before the backend exists, with zero UI changes to switch                                                                | MSW (extra dependency, worker setup); mocks inside components (forbidden by the brief)  |
| FD-5  | Same-origin `/api/v1` via Next rewrites                                                                            | First-party cookies, no CORS for SSE, one config point                                                                                                   | Direct cross-origin calls                                                               |
| FD-6  | Tailwind 4 + CSS-variable tokens; Radix primitives; cmdk; sonner; lucide                                           | Accessible primitives without a heavyweight component kit; tokens drive both themes                                                                      | shadcn copy-in (same primitives, more code to own), MUI/Chakra (fights the brand)       |
| FD-7  | react-hook-form + zod for forms                                                                                    | Schema reuse in tests, field-level server error mapping                                                                                                  | Hand-rolled forms                                                                       |
| FD-8  | No syntax highlighting yet                                                                                         | Keeps bundle small; correctness of line mapping first                                                                                                    | Shiki — add later, lazily loaded, if users ask                                          |
| FD-9  | Native `<select>`                                                                                                  | Best cross-platform accessibility for simple choices                                                                                                     | Radix Select                                                                            |
| FD-10 | Hand-built diff viewer and parser                                                                                  | Small, testable, matches our scope-check needs                                                                                                           | `react-diff-view` / `diff2html`                                                         |
| FD-11 | Contract types live in `apps/web/src/lib/api/types.ts` for now                                                     | `packages/contracts` doesn't exist yet                                                                                                                   | Create the shared package unilaterally (would cross ownership)                          |
| FD-12 | Public homepage at `/` in the same Next.js app; the signed-in resolver moved to `/app`                             | One design system and deploy. The homepage is a static Server Component (prerendered, indexable) with no API calls, so it can't trigger the 401 redirect | Separate marketing site (duplicate tokens and components, drift)                        |
| FD-13 | Homepage motion is CSS keyframes plus two small client islands                                                     | Zero runtime dependency, honours reduced motion centrally, keeps the page static                                                                         | Framer Motion / GSAP (bundle weight, client-rendered sections)                          |
| FD-14 | Homepage imagery is real screenshots captured by `npm run screenshots` from the fixture-backed app, in both themes | Accurate, theme-matched, regenerated with the UI; no invented product shots or stock art                                                                 | Hand-made mockups (drift from the real UI), generated images (inaccurate)               |

## 6. Configuration

| Variable                                                         | Scope  | Purpose                               |
| ---------------------------------------------------------------- | ------ | ------------------------------------- |
| `NEXT_PUBLIC_API_MODE`                                           | build  | `fixtures` (default) or `http`        |
| `ANVAYA_API_ORIGIN`                                              | server | Origin `/api/v1/*` is rewritten to    |
| `NEXT_PUBLIC_GITHUB_APP_SLUG`                                    | build  | GitHub App install URL                |
| `NEXT_PUBLIC_FIXTURE_STAGE_MS`, `NEXT_PUBLIC_FIXTURE_LATENCY_MS` | build  | Fixture timing (E2E uses fast values) |
