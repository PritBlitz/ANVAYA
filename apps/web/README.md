# Anvaya web

Next.js frontend for Anvaya — from codebase understanding to evidence-backed engineering change.

## Run

```bash
npm install
cp .env.example .env.local   # optional; defaults to development fixtures
npm run dev                  # http://localhost:3000
```

`/` is the public homepage; `/login` signs in; `/app` takes a signed-in user to their workspace.

By default the app uses **development fixtures**: a stateful, in-browser emulation of the documented API (`src/lib/api/fixtures`). Click **Continue with GitHub** to start a demo session, or **Continue as a viewer** to see read-only permissions. Reset the data from the account menu.

To use the real control plane:

```bash
NEXT_PUBLIC_API_MODE=http ANVAYA_API_ORIGIN=http://localhost:4000 npm run dev
```

## Scripts

| Script                            | What it does                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `npm run dev` / `build` / `start` | Next.js                                                                                            |
| `npm run typecheck`               | `tsc --noEmit`                                                                                     |
| `npm run lint`                    | ESLint, zero warnings allowed                                                                      |
| `npm test`                        | Vitest unit, component and contract tests                                                          |
| `npm run test:e2e`                | Builds with fast fixtures, runs Playwright journeys + axe (`npx playwright install chromium` once) |
| `npm run format` / `format:check` | Prettier                                                                                           |
| `npm run check`                   | typecheck + lint + test + build                                                                    |
| `npm run screenshots`             | Regenerates the homepage product screenshots from the running dev server (light + dark)            |

## Docs

- `../../docs/DESIGN_SYSTEM.md`: tokens, components, interaction and accessibility rules
- `../../docs/frontend/ARCHITECTURE.md`: structure, state, rendering, and design decisions
- `../../docs/frontend/ROUTES.md`: route map
- `../../docs/frontend/API_INTEGRATION.md`: API contract usage and the gap log for the backend
- `../../docs/frontend/STATUS.md`: milestones, verification, known limitations
