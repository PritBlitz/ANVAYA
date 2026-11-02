"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import { cn } from "@/lib/utils/cn";
import { AskScene, ConnectScene, HandoffScene, IndexScene, PlanScene, VerifyScene } from "./scenes";

interface Step {
  key: string;
  label: string;
  title: string;
  body: string;
  points: string[];
  Scene: ComponentType;
}

const STEPS: Step[] = [
  {
    key: "connect",
    label: "Connect",
    title: "Install the GitHub App. Choose what it can see.",
    body: "Pick an account and the repositories to index. Permissions are listed up front, tokens are short-lived, and you can disconnect at any time.",
    points: ["GitHub App, not personal tokens", "Per-repository access", "Revocable in one click"],
    Scene: ConnectScene,
  },
  {
    key: "index",
    label: "Understand",
    title: "Anvaya indexes your code at an exact commit.",
    body: "Files are classified, secrets and generated code are excluded, supported languages are parsed into syntax trees, and chunks are embedded locally — each one tied to a path, line range, and commit.",
    points: [
      "Version-aware snapshots",
      "Exclusions you can audit",
      "Coverage and limitations shown",
    ],
    Scene: IndexScene,
  },
  {
    key: "ask",
    label: "Ask",
    title: "Ask questions. Get answers that cite lines.",
    body: "Hybrid retrieval finds the relevant code; the answer cites path, lines, and commit. When the evidence isn't there, Anvaya says so instead of guessing.",
    points: [
      "Lexical + semantic search",
      "Citations open at the exact commit",
      "Refuses to invent evidence",
    ],
    Scene: AskScene,
  },
  {
    key: "plan",
    label: "Plan",
    title: "Review the plan before any code changes.",
    body: "From an issue, a failing check, or a description, Anvaya investigates and proposes a structured plan: objective, steps, files in scope, tests, and risks. Edit it, approve it, or reject it.",
    points: [
      "Observed vs. inferred, labelled",
      "Scope is explicit",
      "Approval bound to the exact plan",
    ],
    Scene: PlanScene,
  },
  {
    key: "verify",
    label: "Verify",
    title: "Changes run in a disposable sandbox.",
    body: "The patch is applied in an isolated environment with no network by default. Server-defined test, lint, and build profiles run — real exit codes, not a model's opinion.",
    points: ["No arbitrary shell commands", "CPU, memory, time limits", "Bounded repair attempts"],
    Scene: VerifyScene,
  },
  {
    key: "handoff",
    label: "Hand off",
    title: "You approve the pull request. Humans merge it.",
    body: "A reviewer inspects the actual diff alongside deterministic scanners. You see every finding with its source, then approve — and only then is a branch pushed and a PR opened.",
    points: [
      "AI and scanner findings kept distinct",
      "Approval bound to the reviewed patch",
      "Never auto-merges or deploys",
    ],
    Scene: HandoffScene,
  },
];

export function HowItWorks() {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.index));
        }
      },
      // A step becomes active when it crosses the vertical middle of the viewport.
      { rootMargin: "-45% 0px -50% 0px" },
    );
    refs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const ActiveScene = STEPS[active]!.Scene;

  return (
    <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_1.05fr] lg:gap-16">
      <ol className="relative flex min-w-0 flex-col">
        {/* Progress rail */}
        <span
          aria-hidden
          className="absolute top-2 bottom-2 left-[15px] hidden w-px bg-border lg:block"
        />
        <span
          aria-hidden
          className="absolute top-2 left-[15px] hidden w-px bg-primary transition-[height] duration-500 ease-out lg:block"
          style={{ height: `calc(${(active / (STEPS.length - 1)) * 100}% - 1rem)` }}
        />
        {STEPS.map((step, i) => {
          const isActive = i === active;
          return (
            <li
              key={step.key}
              ref={(el) => {
                refs.current[i] = el;
              }}
              data-index={i}
              className="relative flex gap-5 py-6 lg:min-h-[62vh] lg:items-center lg:py-0"
            >
              <span
                className={cn(
                  "relative z-10 hidden size-8 shrink-0 items-center justify-center rounded-full border font-mono text-xs transition-colors duration-300 lg:flex",
                  isActive
                    ? "border-primary bg-primary text-primary-fg"
                    : i < active
                      ? "border-link bg-bg text-link"
                      : "border-border-strong bg-bg text-fg-subtle",
                )}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className={cn("min-w-0 flex-1 transition-opacity duration-500")}>
                <button
                  type="button"
                  onClick={() =>
                    refs.current[i]?.scrollIntoView({ behavior: "smooth", block: "center" })
                  }
                  className="text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                  aria-current={isActive ? "step" : undefined}
                >
                  <span className="font-mono text-xs tracking-wide text-link uppercase lg:hidden">
                    {String(i + 1).padStart(2, "0")} ·{" "}
                  </span>
                  <span className="font-mono text-xs tracking-wide text-link uppercase">
                    {step.label}
                  </span>
                  <h3
                    className={cn(
                      "mt-2 font-display text-[1.9rem] leading-tight text-fg transition-colors duration-500 sm:text-[2.2rem]",
                      !isActive && "lg:text-fg-muted",
                    )}
                  >
                    {step.title}
                  </h3>
                </button>
                <p className="mt-3 max-w-lg text-base leading-relaxed text-fg-muted">{step.body}</p>
                <ul className="mt-4 flex flex-wrap gap-2">
                  {step.points.map((p) => (
                    <li
                      key={p}
                      className="rounded-full border border-border px-3 py-1 text-xs text-fg-muted"
                    >
                      {p}
                    </li>
                  ))}
                </ul>
                {/* Mobile: the scene sits under its step */}
                <div className="mt-6 lg:hidden">
                  <step.Scene />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="hidden lg:block">
        <div className="sticky top-[calc(50vh-190px)]">
          {/* Re-keyed so each scene's choreography restarts when it becomes active */}
          <div key={STEPS[active]!.key} className="animate-fade-in">
            <ActiveScene />
          </div>
          <p className="mt-4 text-center text-xs text-fg-subtle" aria-live="polite">
            Step {active + 1} of {STEPS.length} · {STEPS[active]!.label}
          </p>
        </div>
      </div>
    </div>
  );
}
