import {
  Bot,
  Check,
  CircleCheck,
  FileCode2,
  FileX2,
  GitPullRequest,
  Lock,
  Network,
  ShieldAlert,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import type { ReactNode } from "react";
import { AnvayaMark, GitHubMark } from "@/components/brand";
import { cn } from "@/lib/utils/cn";
import { anim } from "./motion";

/** Shared frame for every scene. Decorative (aria-hidden); the step text carries meaning. */
function Frame({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex h-[380px] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-lg",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border bg-bg-subtle px-4 py-2.5">
        <span className="flex gap-1.5">
          <span className="size-2 rounded-full bg-border-strong" />
          <span className="size-2 rounded-full bg-border-strong" />
          <span className="size-2 rounded-full bg-border-strong" />
        </span>
        <span className="ml-1 font-mono text-2xs text-fg-muted">{title}</span>
      </div>
      <div className="relative flex-1 p-5">{children}</div>
    </div>
  );
}

const rise = (delay: number) => anim("mk-rise", { delay, duration: 500 });
const pop = (delay: number) => anim("mk-pop", { delay, duration: 450 });

export function ConnectScene() {
  const perms = [
    ["metadata", "read"],
    ["contents", "read & write"],
    ["pull_requests", "read & write"],
    ["issues", "read"],
  ];
  return (
    <Frame title="Connect · GitHub App">
      <div className="flex items-center justify-between px-2 pt-3">
        <div className="flex flex-col items-center gap-2 mk-anim" style={pop(0)}>
          <span className="flex size-14 items-center justify-center rounded-2xl bg-fg text-fg-inverse">
            <GitHubMark className="size-7" />
          </span>
          <span className="text-xs text-fg-muted">acme</span>
        </div>
        <svg viewBox="0 0 200 24" className="mx-3 h-6 flex-1" fill="none">
          <path d="M2 12 H198" stroke="var(--border-strong)" strokeWidth="2" />
          <path
            className="mk-anim"
            d="M2 12 H198"
            stroke="var(--primary)"
            strokeWidth="2"
            strokeDasharray="6 6"
            style={anim("mk-flow", { duration: 900, iteration: "infinite", easing: "linear" })}
          />
        </svg>
        <div className="flex flex-col items-center gap-2 mk-anim" style={pop(250)}>
          <AnvayaMark size={56} />
          <span className="text-xs text-fg-muted">Anvaya</span>
        </div>
      </div>
      <p
        className="mt-6 text-2xs font-semibold tracking-wide text-fg-muted uppercase mk-anim"
        style={rise(500)}
      >
        Least-privilege permissions
      </p>
      <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {perms.map(([scope, access], i) => (
          <li
            key={scope}
            className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-2 text-xs mk-anim"
            style={rise(650 + i * 140)}
          >
            <Check className="size-3.5 text-success" />
            <span className="font-mono text-fg">{scope}</span>
            <span className="ml-auto text-fg-muted">{access}</span>
          </li>
        ))}
      </ul>
      <p
        className="mt-4 flex items-center gap-1.5 text-xs text-fg-muted mk-anim"
        style={rise(1300)}
      >
        <Lock className="size-3.5" /> Short-lived installation tokens, minted per job
      </p>
    </Frame>
  );
}

export function IndexScene() {
  const files: [string, string | null][] = [
    ["src/auth/refresh.ts", null],
    ["src/auth/token.ts", null],
    ["src/payments/charge.ts", null],
    [".env.example", "secret"],
    ["node_modules/…", "dependency"],
    ["test/auth/refresh.test.ts", null],
  ];
  return (
    <Frame title="Index · snapshot 9f3c2a1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-fg">Parsing syntax trees…</span>
        <span className="font-mono text-fg-muted">tree-sitter · nomic-embed</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full origin-left rounded-full bg-primary mk-anim"
          style={anim("mk-fill", { duration: 2200 })}
        />
      </div>
      <ul className="relative mt-4 flex flex-col gap-1.5 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-transparent via-primary/10 to-transparent mk-anim"
          style={anim("mk-scan", { duration: 2400, iteration: "infinite", easing: "linear" })}
        />
        {files.map(([path, excluded], i) => (
          <li
            key={path}
            className="flex items-center gap-2 font-mono text-xs mk-anim"
            style={rise(150 + i * 180)}
          >
            {excluded ? (
              <FileX2 className="size-3.5 text-warning" />
            ) : (
              <FileCode2 className="size-3.5 text-fg-subtle" />
            )}
            <span className={cn("truncate", excluded ? "text-fg-subtle line-through" : "text-fg")}>
              {path}
            </span>
            <span className="ml-auto mk-anim" style={pop(400 + i * 180)}>
              {excluded ? (
                <span className="rounded-xs bg-warning-soft px-1.5 py-0.5 font-sans text-2xs text-warning">
                  excluded · {excluded}
                </span>
              ) : (
                <Check className="size-3.5 text-success" />
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="absolute inset-x-5 bottom-5 flex flex-wrap gap-1.5">
        {["TypeScript · 9", "Python · 2", "Markdown · 2"].map((l, i) => (
          <span
            key={l}
            className="rounded-sm border border-border bg-surface-sunken px-2 py-1 text-2xs text-fg-muted mk-anim"
            style={pop(1500 + i * 120)}
          >
            {l}
          </span>
        ))}
      </div>
    </Frame>
  );
}

export function AskScene() {
  return (
    <Frame title="Ask · grounded in indexed code">
      <div className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-sm text-fg">
        <span
          className="inline-block mk-anim"
          style={anim("mk-type", { duration: 1300, easing: "steps(38, end)" })}
        >
          Where is refresh token expiry handled?
        </span>
        <span
          className="ml-0.5 inline-block h-4 w-px translate-y-0.5 bg-fg mk-anim"
          style={anim("mk-caret", { duration: 900, iteration: "infinite", easing: "step-end" })}
        />
      </div>
      <div className="mt-4 flex items-center gap-1.5 mk-anim" style={rise(1400)}>
        <span className="flex items-center gap-1 rounded-sm bg-ai-soft px-1.5 py-0.5 text-2xs font-medium text-ai">
          <Sparkles className="size-3" /> AI answer
        </span>
        <span className="rounded-sm bg-success-soft px-1.5 py-0.5 text-2xs font-medium text-success">
          3 citations
        </span>
      </div>
      <p className="mt-2.5 text-sm leading-relaxed text-fg mk-anim" style={rise(1600)}>
        Expiry is checked in{" "}
        <code className="rounded-xs bg-surface-sunken px-1 font-mono text-xs">isExpired</code> with
        a 30s skew
        <Cite n={1} delay={1900} />, called from{" "}
        <code className="rounded-xs bg-surface-sunken px-1 font-mono text-xs">refreshSession</code>
        <Cite n={2} delay={2050} />. Refresh-token expiry itself is enforced by the identity
        provider <Cite n={3} delay={2200} />.
      </p>
      <div
        className="mt-4 overflow-hidden rounded-md border border-border font-mono text-[11px] leading-6 mk-anim"
        style={rise(2400)}
      >
        <div className="flex items-center gap-2 border-b border-border bg-bg-subtle px-2.5 text-2xs text-fg-muted">
          <span className="rounded-xs bg-accent px-1 font-semibold text-accent-fg">1</span>{" "}
          src/auth/token.ts · L19–23 @ 9f3c2a1
        </div>
        {[
          "export function isExpired(token, skewSeconds = 0) {",
          "  const { exp } = decodeJwt(token);",
          "  return exp - skewSeconds <= now;",
        ].map((l, i) => (
          <div key={i} className="flex bg-highlight">
            <span className="w-8 shrink-0 pr-2 text-right text-accent-fg">{19 + i}</span>
            <span className="truncate whitespace-pre text-fg">{l}</span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

function Cite({ n, delay }: { n: number; delay: number }) {
  return (
    <span
      className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-xs bg-accent px-1 align-text-top font-mono text-2xs font-semibold text-accent-fg mk-anim"
      style={pop(delay)}
    >
      {n}
    </span>
  );
}

export function PlanScene() {
  const steps = [
    "Serialize refreshSession with a shared in-flight promise",
    "Add a concurrency regression test",
    "Keep session storage unchanged (out of scope)",
  ];
  return (
    <Frame title="Plan · awaiting your approval">
      <p className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">Objective</p>
      <p className="mt-1 text-sm font-medium text-fg mk-anim" style={rise(100)}>
        Prevent concurrent refreshes from invalidating a valid session.
      </p>
      <ol className="mt-4 flex flex-col gap-2">
        {steps.map((s, i) => (
          <li
            key={s}
            className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2 text-xs text-fg mk-anim"
            style={rise(300 + i * 220)}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-2xs font-semibold text-accent-fg">
              {i + 1}
            </span>
            {s}
          </li>
        ))}
      </ol>
      <div className="absolute inset-x-5 bottom-5 flex items-center gap-3">
        <span
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-fg shadow-xs mk-anim"
          style={{
            ...rise(1100),
            ...anim("mk-press", {
              duration: 2600,
              delay: 1300,
              iteration: "infinite",
              easing: "ease-in-out",
            }),
          }}
        >
          <Check className="size-4" /> Approve plan
        </span>
        <span
          className="inline-flex items-center gap-1.5 rounded-sm bg-success-soft px-2 py-1 text-xs font-medium text-success mk-anim"
          style={pop(2000)}
        >
          <CircleCheck className="size-3.5" /> v1 · sha256:036c…
        </span>
      </div>
      <p className="absolute right-5 bottom-16 text-2xs text-fg-muted mk-anim" style={rise(1100)}>
        No code changes before this click.
      </p>
    </Frame>
  );
}

export function VerifyScene() {
  const lines: [string, string][] = [
    ["$ npm run typecheck", "text-fg-muted"],
    ["✓ no errors · exit 0", "text-success"],
    ["$ npm test", "text-fg-muted"],
    ["✓ refresh.concurrency.test.ts (1)", "text-success"],
    ["Tests 5 passed (5) · exit 0 · 8.4s", "text-success"],
    ["$ npm run lint", "text-fg-muted"],
    ["✓ 0 problems · exit 0", "text-success"],
  ];
  return (
    <Frame title="Verify · disposable sandbox">
      <div className="relative h-full rounded-lg border-2 border-dashed border-border-strong p-3">
        <div className="absolute -top-3 left-3 flex items-center gap-2 bg-surface px-1.5 text-2xs text-fg-muted">
          <TerminalSquare className="size-3.5" /> sandbox · non-root · 2 CPU · 15 min
        </div>
        <div className="absolute -top-3 right-3 flex items-center gap-1 bg-surface px-1.5 text-2xs text-warning">
          <Network className="size-3.5" /> egress: deny
        </div>
        <ol className="mt-2 flex flex-col gap-1 font-mono text-xs">
          {lines.map(([l, tone], i) => (
            <li key={i} className={cn("mk-anim", tone)} style={rise(200 + i * 260)}>
              {l}
            </li>
          ))}
        </ol>
        <p
          className="absolute inset-x-3 bottom-3 rounded-md bg-surface-sunken px-2.5 py-1.5 text-2xs text-fg-muted mk-anim"
          style={rise(2200)}
        >
          Pass/fail comes from real exit codes. Models can explain failures — never decide them.
        </p>
      </div>
    </Frame>
  );
}

export function HandoffScene() {
  return (
    <Frame title="Review & hand off">
      <div className="overflow-hidden rounded-md border border-border font-mono text-[11px] leading-6">
        {[
          ["-", "  // concurrent callers each refresh", "bg-diff-del-bg text-diff-del-fg"],
          ["+", "  inFlight ??= performRefresh(store)", "bg-diff-add-bg text-diff-add-fg"],
          ["+", "    .finally(() => (inFlight = null));", "bg-diff-add-bg text-diff-add-fg"],
        ].map(([sign, text, cls], i) => (
          <div key={i} className={cn("flex mk-anim", cls)} style={rise(100 + i * 160)}>
            <span className="w-6 shrink-0 text-center">{sign}</span>
            <span className="truncate whitespace-pre text-fg">{text}</span>
          </div>
        ))}
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        <li
          className="flex items-center gap-2 rounded-md border border-ai-border bg-ai-soft/40 px-3 py-2 text-xs mk-anim"
          style={rise(700)}
        >
          <Bot className="size-3.5 text-ai" />
          <span className="text-fg">AI review · medium · shared in-flight promise</span>
          <span className="ml-auto text-fg-muted">accepted</span>
        </li>
        <li
          className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs mk-anim"
          style={rise(900)}
        >
          <ShieldAlert className="size-3.5 text-danger" />
          <span className="text-fg">Security scanner · high</span>
          <span
            className="ml-auto rounded-xs bg-success-soft px-1.5 text-success mk-anim"
            style={pop(1500)}
          >
            fixed
          </span>
        </li>
      </ul>
      <div
        className="absolute inset-x-5 bottom-5 flex items-center gap-3 rounded-lg border border-success-border bg-success-soft px-4 py-3 mk-anim"
        style={pop(1900)}
      >
        <GitPullRequest className="size-5 text-success" />
        <div>
          <p className="text-sm font-semibold text-fg">Pull request #482 opened</p>
          <p className="text-2xs text-fg-muted">
            Approved by a human · evidence in the description · never auto-merged
          </p>
        </div>
      </div>
    </Frame>
  );
}
