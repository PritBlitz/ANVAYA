# Anvaya Design System

**Source of truth for values:** `apps/web/src/app/globals.css` (tokens) and `apps/web/src/components/ui/*` (components). This document explains them; if they disagree, the code wins and this file should be fixed.

## 1. Principles

1. **Evidence is the hero.** Paths, line ranges, commit SHAs, hashes, exit codes and durations are first-class UI, set in mono and always linkable.
2. **AI is labelled; determinism is plain.** Model output carries the violet `ai` tone and a sparkle; deterministic results (tests, scanners, exit codes) use neutral and status tones. They are never styled alike (FR-VER-004).
3. **Decisions are loud, everything else is quiet.** Warning tone is reserved for "a human must decide". Primary (wine) is reserved for the one primary action on a surface.
4. **Dense but calm.** 13px base UI text, generous line height, hairline borders, minimal shadow — closer to an engineering tool than a marketing site.
5. **Never color alone.** Every status has a text label and usually an icon.

## 2. Color

### Brand primitives (never used directly in components)

| Token        | Value     | Note                                                 |
| ------------ | --------- | ---------------------------------------------------- |
| `--wine-600` | `#7F011F` | Brand Wine Red — primary (light)                     |
| `--wine-700` | `#650018` | Primary hover (light)                                |
| `--sand-200` | `#F5EBD0` | Brand Light Sand — accent, citation highlight family |
| `--sand-50`  | `#FCFAF6` | App background (light)                               |
| `--ink-600`  | `#241D20` | Main text (light)                                    |
| `--ink-500`  | `#756B6E` | Secondary text (light)                               |
| `--ink-200`  | `#E8DFD9` | Border (light)                                       |

Full ramps (`--wine-50…900`, `--sand-50…400`, `--ink-100…950`) are in `globals.css`.

### Semantic tokens (use these)

Exposed to Tailwind as utilities, e.g. `bg-surface`, `text-fg-muted`, `border-border`.

| Token                                     | Light                             | Dark                  | Use                                          |
| ----------------------------------------- | --------------------------------- | --------------------- | -------------------------------------------- |
| `bg`                                      | `#FCFAF6`                         | `#141011`             | App canvas                                   |
| `bg-subtle`                               | `#F6F1EA`                         | `#181314`             | Sidebar, table headers, page headers         |
| `surface`                                 | `#FFFFFF`                         | `#1B1618`             | Cards                                        |
| `surface-raised`                          | `#FFFFFF`                         | `#221C1E`             | Dialogs, menus, popovers                     |
| `surface-sunken`                          | `#F7F3EE`                         | `#110D0E`             | Code, inputs on cards, output logs           |
| `surface-hover` / `surface-selected`      | `#F3EDE6` / `#F9F3E6`             | `#262022` / `#2C2225` | Row hover / selection                        |
| `border` / `border-strong`                | `#E8DFD9` / `#D6CBC4`             | `#2F272A` / `#41373B` | Hairlines / control hover                    |
| `fg`                                      | `#241D20`                         | `#EFE7E2`             | Primary text                                 |
| `fg-muted`                                | `#756B6E`                         | `#A69A9D`             | Secondary text                               |
| `fg-subtle`                               | `#6F6568`                         | `#988C8F`             | Meta, placeholders — ≥4.5:1 on every surface |
| `primary` / `primary-hover`               | `#7F011F` / `#650018`             | `#B0213F` / `#C22E4D` | Primary actions, active nav icon             |
| `primary-soft` / `primary-soft-fg`        | `#FBF1F3` / `#7F011F`             | `#3A1520` / `#F2A3B4` | Selected option tint                         |
| `link`                                    | `#7F011F`                         | `#F08AA0`             | Inline links                                 |
| `accent` / `accent-fg`                    | `#F5EBD0` / `#5C4A1F`             | `#3B3222` / `#F0DCAE` | Line-range chips, citation markers           |
| `highlight` / `highlight-border`          | `#FBF3DC` / `#E3CF98`             | `#33291A` / `#6B5528` | Cited lines, search matches, fixtures notice |
| `success` · `warning` · `danger` · `info` | + `-soft`, `-border`              | lifted for dark       | Status only                                  |
| `ai` / `ai-soft` / `ai-border`            | `#5B47C2` / `#F0EDFB` / `#D5CDF3` | `#A99BF2` / …         | AI-generated content only                    |
| `diff-add-*` / `diff-del-*`               | greens / reds                     |                       | Diff rows and gutters                        |
| `chart-1`                                 | `#A3122F`                         | `#D24A64`             | Chart marks (validated, see §8)              |
| `ring`                                    | wine @55%                         | rose @60%             | Focus outline                                |

**Contrast:** text tokens meet WCAG AA (4.5:1) on `bg`, `surface`, `surface-sunken`, `surface-hover` and `neutral-soft` in both themes; this is enforced by automated axe scans in E2E tests.

### Status vocabulary

| Meaning       | Tone                 | Examples                                       |
| ------------- | -------------------- | ---------------------------------------------- |
| Working       | `info` + pulsing dot | Investigating, Verifying, Indexing             |
| Needs a human | `warning`            | Plan approval needed, PR approval needed       |
| Succeeded     | `success`            | Completed, Passed, Indexed                     |
| Failed        | `danger`             | Failed, Timed out, High/critical severity      |
| Inactive      | `neutral`            | Cancelled, Skipped, Plan rejected              |
| AI output     | `ai`                 | AI answer, AI-proposed plan, AI review finding |

Mapping lives in `src/lib/domain/status.ts` so every screen agrees.

## 3. Typography

| Role                                         | Family           | Token                                          |
| -------------------------------------------- | ---------------- | ---------------------------------------------- |
| UI                                           | Geist Sans       | `font-sans`                                    |
| Code, SHAs, paths, numbers in tables         | Geist Mono       | `font-mono` (+ `tabular` utility for numerals) |
| Display (sign-in, onboarding, wordmark only) | Instrument Serif | `font-display`                                 |

Scale (`text-*`): `2xs` 11/16 · `xs` 12/18 · **`sm` 13/20 (base UI)** · `base` 14/22 · `md` 16/24 · `lg` 20/28 · `xl` 24/32 · `2xl` 32/38 · `3xl` 44/48.

Page titles: `text-xl font-semibold tracking-tight`. Section labels: `text-xs font-semibold uppercase tracking-wide text-fg-muted`.

## 4. Space, radius, elevation, motion

- **Spacing:** Tailwind 4px scale. Page padding `px-4 sm:px-6 lg:px-8`, vertical rhythm `gap-6` between sections, `gap-3` within.
- **Containers:** `PageContainer` (max 6xl) / `wide` (1600px) for code, runs and diffs.
- **Radius:** `xs` 3 · `sm` 4 (badges) · `md` 6 (controls) · `lg` 8 (cards) · `xl` 12 (dialogs).
- **Shadow:** `xs` controls/cards · `md` menus · `lg` dialogs/drawers. Warm-tinted in light, near-black in dark.
- **Motion:** 100–200ms, `ease-out-quint`; `fade-in`, `pop-in` (menus/dialogs), `slide-in-right` (drawers), `shimmer` (skeletons), `pulse-dot` (working). All disabled under `prefers-reduced-motion`.

## 5. Components (`src/components/ui`)

| Component                                                   | Notes                                                                                                                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                                    | Variants `primary · secondary · outline · ghost · danger · link`; sizes `xs · sm · md · lg · icon · icon-sm`; `loading` disables and sets `aria-busy`; `asChild` for links. One primary per surface. |
| `Input`, `Textarea`, `Select`                               | Shared `controlStyles`; invalid state from `aria-invalid`. `Select` is native for full accessibility.                                                                                                |
| `Field`                                                     | Label + hint + error, wires `id`, `aria-describedby`, `aria-invalid`, `aria-required`. Render-prop form for composite controls.                                                                      |
| `Badge`                                                     | Tones above; optional dot/pulse. Domain wrappers in `components/domain/badges.tsx` (`RunStatusBadge`, `IndexingBadge`, `SeverityBadge`, `SourceBadge`, `AiBadge`, `ModeBadge`…).                     |
| `Card`, `CardHeader`, `CardBody`                            | Hairline border, `shadow-xs`.                                                                                                                                                                        |
| `Dialog` / `DialogContent`                                  | Radix; title + description required for screen readers; optional footer.                                                                                                                             |
| `DrawerContent`                                             | Right-side panel for details (knowledge documents, mobile file tree).                                                                                                                                |
| `ConfirmDialog`                                             | Every consequential action. Stays open with a pending state until the server confirms.                                                                                                               |
| `DropdownMenu*`, `Tooltip`                                  | Radix. Tooltips are supplementary only — never the sole label.                                                                                                                                       |
| `Tabs` / `NavTabs`                                          | `NavTabs` are links with `aria-current="page"`: each tab is a URL.                                                                                                                                   |
| `Skeleton`, `SkeletonRows`                                  | Shimmer; `role="status"` with label.                                                                                                                                                                 |
| `EmptyState`, `ErrorState`, `InlineAlert`                   | `ErrorState` chooses offline/forbidden/not-found copy and shows the request ID; retry only when it can help.                                                                                         |
| `Progress`, `Mono`, `Avatar`, `Kbd`, `Separator`, `Spinner` | Utilities.                                                                                                                                                                                           |
| Command palette                                             | `cmdk`, ⌘/Ctrl+K: actions, navigation, repositories, tasks, search-in-repo.                                                                                                                          |
| Toasts                                                      | `sonner`, themed; bottom-right; errors include request ID.                                                                                                                                           |

Domain components: `CodeView` (line-numbered, range highlight, text-only rendering), `FileTree` (WAI-ARIA tree), `RichText` (safe markdown subset for model output), `RunStepper`, `DailyTokensChart`.

## 6. Interaction guidelines

- **Every view is a URL.** Tabs, filters, search queries, code paths and line ranges live in the URL so they can be shared and survive reloads.
- **Never show success before the server confirms** (CLAUDE.md §8). No optimistic updates for approvals, PRs, or role changes.
- **Consequential actions** (approve plan, approve PR, create PR, cancel run, disconnect, remove member, enable cloud inference) use a confirmation that states exactly what will happen and what will not.
- **Rejecting and dismissing require a reason.**
- **Decision state is always visible:** run header banner, nav badge on Reviews, warning dot on the relevant run tab.
- **Loading:** skeletons that match the final layout; never a blank page. **Empty:** say what the area is for and the next step. **Error:** what happened, whether retrying helps, request ID. **Permission:** say which role is needed instead of hiding the area silently.
- **Activity preservation:** Next.js keeps recently visited routes mounted but hidden. Transient UI (dialogs, palettes) is derived from the URL or closed on hide; navigation away from a "create" dialog uses `router.replace` so Back doesn't reopen it.

## 7. Accessibility

WCAG 2.1 AA target, verified by axe in E2E on sign-in, overview, run, plan, verification, repository, search, onboarding and usage screens. Skip link, visible focus ring (`ring` token), full keyboard operation (tree view arrows, ⌘K, ⌘/Ctrl+Enter to ask), `aria-live` for streaming events and results, semantic tables with captions, `sr-only` state text in the stepper and diff rows, reduced-motion support, and both themes contrast-checked.

## 8. Data visualization

Following the dataviz method: single-series charts use one hue (`chart-1`) with no legend, thin bars with 4px rounded data-ends and 2px gaps, recessive dashed gridlines, a per-bar keyboard-focusable tooltip, and a "Show as table" alternative. `chart-1` values were checked with the validator script: lightness band and ≥3:1 against the surface in both themes. Breakdowns that are lookups (usage by provider) are tables, and headline numbers are stat tiles, not charts.

## 9. Public surface (homepage)

The homepage (`/`, `src/features/marketing`) uses the same tokens and components as the product, with a more expressive layer on top. Anyone who knows the app should recognise it, and anyone who sees the homepage should recognise the app.

### Layout and rhythm

- **Width:** `max-w-7xl` with `px-5 sm:px-8`. Sections get `py-24 lg:py-32`, which is more air than the dense product UI.
- **Section sequence:** Hero → Principles strip → How it works (dark) → Product tour → Capabilities → Security → Boundaries → CTA (wine) → Footer. Light and dark bands alternate so the page has a rhythm, not a wall.
- **Always-dark bands:** these add the `dark` class to the section. That re-scopes every semantic token, so components inside render in the dark palette without special styling.

### Type

| Role          | Style                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Hero headline | `font-display`, 46 → 64 → 74px, `leading-[1.02]`, one emphasised phrase in `primary` (`link` on dark) |
| Section title | `font-display`, 38 → 51px                                                                             |
| Step title    | `font-display`, 30 → 35px                                                                             |
| Eyebrow       | `font-mono text-xs uppercase tracking-[0.18em]`, `primary` on light and `link` on dark                |
| Body          | `text-lg leading-relaxed text-fg-muted`                                                               |

Instrument Serif is reserved for the public surface, sign-in and onboarding. It never appears inside the working product.

### Imagery

1. **Real product screenshots, not illustrations of a product that doesn't exist.** `npm run screenshots` drives the real UI against the development fixtures and writes `src/features/marketing/screenshots/{name}-{light|dark}.png` at 1440×900 @1.5×. Re-run it after UI changes. The script hides only development chrome: the Next.js dev overlay, toasts, and the fixtures notice.
2. **Theme-matched.** Each screenshot ships in light and dark, swapped with `dark:hidden` / `hidden dark:block`, so there's no flash and no JavaScript.
3. **Framed.** Screenshots sit in a neutral browser frame with descriptive `alt` text that says what the screen shows.
4. **Diagrams are SVG built from tokens** (`TrustDiagram`), so they follow the theme and stay crisp. They include `<title>`/`<desc>`, and their text never renders below 12px. On narrow screens the container scrolls (focusable, labelled) rather than shrinking the text.
5. **Scene illustrations** (How it works, hero) are small React compositions of real UI fragments: badges, code lines, diff rows, buttons. They are `aria-hidden`, because the step text carries the meaning.
6. **Honesty rules.** No stock photos, no invented customer logos, testimonials, ratings or usage numbers. Product data in screenshots is clearly demo data (Acme).

## 10. Motion

Motion explains sequence: evidence → approval → verification → hand-off. It is never decoration for its own sake.

| Keyframe               | Use                                                     | Duration      |
| ---------------------- | ------------------------------------------------------- | ------------- |
| `mk-rise`              | Element enters (10px up + fade)                         | 500–800ms     |
| `mk-pop`               | Badge or status lands (scale overshoot)                 | 450ms         |
| `mk-seq-1…4`           | Hero evidence trail: items land in turn, hold, reset    | 9s loop       |
| `mk-scan`              | Highlight sweeping cited lines / indexing pass          | 2.4–4.5s loop |
| `mk-type` + `mk-caret` | Question being typed (`steps()` easing)                 | 1.3s          |
| `mk-flow`              | Dashed data flow along a connector                      | 0.9–1.1s loop |
| `mk-fill`              | Progress bar                                            | 2.2s          |
| `mk-press`             | Approve button being pressed                            | 2.6s loop     |
| `mk-float`, `mk-glow`  | Ambient chips and background light                      | 5–7s loop     |
| `[data-reveal]`        | Scroll reveal: opacity + 18px, `--reveal-delay` stagger | 700ms         |

Rules:

- **Easing:** `--ease-out-quint` for entrances, `ease-in-out` for ambient loops, `linear` for flows and scans.
- **Choreography restarts with context.** The How it works stage re-keys its scene when the active step changes, so each scene plays from the start.
- **Scroll-driven, not scroll-jacked.** Scrolling stays native. An `IntersectionObserver` picks the step crossing the viewport's midline, and step titles are buttons that scroll their step into view for keyboard users.
- **Progressive enhancement.** Reveal states hide content only when `html.js` is present (set by the pre-paint script) and the user hasn't asked for reduced motion. Without JavaScript, everything is visible.
- **Reduced motion.** `prefers-reduced-motion: reduce` disables every `mk-*` animation (`.mk-anim`), shows all revealed content, and renders scenes in their final state. This is covered by E2E.
- **Never animate meaning away.** Active versus inactive steps are distinguished by colour tokens that keep AA contrast, not by fading text.
- **No animation library.** Everything is CSS keyframes plus two tiny client islands (`RevealObserver`, `HowItWorks`). The rest of the page is a static Server Component.
