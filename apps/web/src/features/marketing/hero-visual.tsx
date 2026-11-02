import {
  Check,
  CircleCheck,
  Cpu,
  FileSearch,
  GitPullRequest,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { anim } from "./motion";

const CODE = [
  "export async function refreshSession(store) {",
  "  const current = await store.read();",
  '  if (!current) throw new Error("No session");',
  "  if (!isExpired(current.accessToken, 30)) {",
  "    return current;",
  "  }",
  "  // concurrent callers each refresh",
  '  const response = await http.post("/oauth/token", {',
  '    grant_type: "refresh_token",',
  "    refresh_token: current.refreshToken,",
  "  });",
];

function TrailItem({
  step,
  icon,
  title,
  detail,
  tone,
}: {
  step: 1 | 2 | 3 | 4;
  icon: ReactNode;
  title: string;
  detail: ReactNode;
  tone: "ai" | "success" | "primary" | "info";
}) {
  const tones = {
    ai: "bg-ai-soft text-ai",
    success: "bg-success-soft text-success",
    primary: "bg-primary-soft text-primary-soft-fg",
    info: "bg-info-soft text-info",
  };
  return (
    <li
      className="flex items-start gap-3 mk-anim"
      style={anim(`mk-seq-${step}`, { duration: 9000, iteration: "infinite", easing: "linear" })}
    >
      <span
        className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full [&_svg]:size-3.5 ${tones[tone]}`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{title}</span>
        <span className="block truncate font-mono text-2xs text-fg-muted">{detail}</span>
      </span>
    </li>
  );
}

/**
 * Hero illustration: a run's evidence trail assembling over the code it cites.
 * Pure CSS animation (9s loop), disabled under prefers-reduced-motion.
 * Decorative: the same story is told in text beside it.
 */
export function HeroVisual() {
  return (
    <div aria-hidden className="relative mx-auto w-full max-w-xl min-w-0 select-none lg:max-w-none">
      <div
        className="absolute -top-10 -right-6 size-64 rounded-full bg-primary/25 blur-3xl mk-anim"
        style={anim("mk-glow", { duration: 6000, iteration: "infinite", easing: "ease-in-out" })}
      />
      <div
        className="absolute -bottom-12 -left-8 size-56 rounded-full bg-sand/70 blur-3xl mk-anim dark:bg-ai/20"
        style={anim("mk-glow", {
          duration: 7000,
          delay: 1200,
          iteration: "infinite",
          easing: "ease-in-out",
        })}
      />

      <div className="relative overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
        <div className="flex items-center gap-2 border-b border-border bg-bg-subtle px-4 py-2.5">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-border-strong" />
            <span className="size-2.5 rounded-full bg-border-strong" />
            <span className="size-2.5 rounded-full bg-border-strong" />
          </span>
          <span className="ml-2 truncate font-mono text-2xs text-fg-muted">
            acme/payments-api · run #1 · src/auth/refresh.ts @ 9f3c2a1
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1.15fr_1fr]">
          <div className="relative overflow-hidden border-b border-border bg-surface-sunken py-3 sm:border-r sm:border-b-0">
            {/* Scanning highlight over the cited range */}
            <div
              className="pointer-events-none absolute inset-x-0 top-3 h-[25%] border-y border-highlight-border bg-highlight/80 mk-anim"
              style={anim("mk-scan", {
                duration: 4500,
                iteration: "infinite",
                easing: "cubic-bezier(.45,0,.55,1)",
              })}
            />
            <ol className="relative font-mono text-[11.5px] leading-[1.7rem]">
              {CODE.map((line, i) => (
                <li key={i} className="flex">
                  <span className="w-10 shrink-0 pr-3 text-right text-fg-subtle">{16 + i}</span>
                  <span className="truncate pr-3 whitespace-pre text-fg">{line}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="flex flex-col gap-4 p-4">
            <p className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">
              Evidence trail
            </p>
            <ol className="flex flex-col gap-3.5">
              <TrailItem
                step={1}
                tone="info"
                icon={<FileSearch />}
                title="Evidence retrieved"
                detail="refresh.ts L16–31 · 9 chunks"
              />
              <TrailItem
                step={2}
                tone="primary"
                icon={<Check />}
                title="Plan approved by Ira"
                detail="2 files in scope · sha256:036c…"
              />
              <TrailItem
                step={3}
                tone="success"
                icon={<CircleCheck />}
                title="npm test · exit 0"
                detail="5 passed · 8.4s · sandbox"
              />
              <TrailItem
                step={4}
                tone="success"
                icon={<GitPullRequest />}
                title="Pull request #482 opened"
                detail="after human approval · not merged"
              />
            </ol>
          </div>
        </div>
      </div>

      <div
        className="absolute -bottom-5 left-6 hidden items-center gap-1.5 rounded-full border border-border bg-surface-raised px-3 py-1.5 text-xs text-fg shadow-md mk-anim sm:flex"
        style={anim("mk-float", { duration: 5000, iteration: "infinite", easing: "ease-in-out" })}
      >
        <Cpu className="size-3.5 text-success" /> Local inference · qwen2.5-coder
      </div>
      <div
        className="absolute -top-4 right-8 hidden items-center gap-1.5 rounded-full border border-ai-border bg-surface-raised px-3 py-1.5 text-xs text-fg shadow-md mk-anim sm:flex"
        style={anim("mk-float", {
          duration: 5600,
          delay: 800,
          iteration: "infinite",
          easing: "ease-in-out",
        })}
      >
        <Sparkles className="size-3.5 text-ai" /> AI proposes
        <span className="text-fg-subtle">·</span>
        <ShieldCheck className="size-3.5 text-primary" /> you decide
      </div>
    </div>
  );
}
