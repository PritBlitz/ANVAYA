"use client";

import Image, { type StaticImageData } from "next/image";
import {
  FileDiff,
  FlaskConical,
  Gauge,
  ListChecks,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import askDark from "./screenshots/ask-dark.png";
import askLight from "./screenshots/ask-light.png";
import changesDark from "./screenshots/changes-dark.png";
import changesLight from "./screenshots/changes-light.png";
import indexDark from "./screenshots/index-dark.png";
import indexLight from "./screenshots/index-light.png";
import planDark from "./screenshots/plan-dark.png";
import planLight from "./screenshots/plan-light.png";
import reviewDark from "./screenshots/review-dark.png";
import reviewLight from "./screenshots/review-light.png";
import verificationDark from "./screenshots/verification-dark.png";
import verificationLight from "./screenshots/verification-light.png";

interface Shot {
  key: string;
  label: string;
  icon: ReactNode;
  caption: string;
  alt: string;
  light: StaticImageData;
  dark: StaticImageData;
}

const SHOTS: Shot[] = [
  {
    key: "plan",
    label: "Plan approval",
    icon: <ListChecks />,
    caption:
      "The run pauses at the plan. Objective, steps, files in scope, tests and risks — with the version and hash you're approving.",
    alt: "Anvaya plan approval screen showing an implementation plan with two steps, files in scope, and Approve and Reject buttons.",
    light: planLight,
    dark: planDark,
  },
  {
    key: "ask",
    label: "Grounded Q&A",
    icon: <MessageSquareText />,
    caption:
      "Answers cite exact lines at the indexed commit. Expand any citation to read the code it points to.",
    alt: "Anvaya repository Q&A showing an AI answer with four numbered citations and the cited source lines highlighted.",
    light: askLight,
    dark: askDark,
  },
  {
    key: "changes",
    label: "Changes",
    icon: <FileDiff />,
    caption:
      "The real diff, its patch hash and base commit, and a check that every changed file is inside the approved scope.",
    alt: "Anvaya changes view showing a unified diff for charge.ts and a banner confirming changes are within the approved scope.",
    light: changesLight,
    dark: changesDark,
  },
  {
    key: "verification",
    label: "Verification",
    icon: <FlaskConical />,
    caption:
      "Passed, failed, skipped and unavailable checks, each with its command, exit code and duration from the sandbox.",
    alt: "Anvaya verification view with counts of passed, failed, skipped and unavailable checks and a list of commands with exit codes.",
    light: verificationLight,
    dark: verificationDark,
  },
  {
    key: "review",
    label: "Review",
    icon: <ShieldCheck />,
    caption:
      "AI review findings and deterministic scanner findings, clearly labelled. High-severity issues block the pull request until resolved.",
    alt: "Anvaya review view listing a high-severity security scanner finding and a low-severity AI review finding with actions.",
    light: reviewLight,
    dark: reviewDark,
  },
  {
    key: "index",
    label: "Index health",
    icon: <Gauge />,
    caption:
      "What was indexed, at which commit, which languages are parsed, what was excluded and why — and what Anvaya can't see.",
    alt: "Anvaya repository overview with language coverage, exclusions, known limitations and snapshot details.",
    light: indexLight,
    dark: indexDark,
  },
];

function BrowserFrame({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
      <div className="flex items-center gap-2 border-b border-border bg-bg-subtle px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-border-strong" />
          <span className="size-2.5 rounded-full bg-border-strong" />
          <span className="size-2.5 rounded-full bg-border-strong" />
        </span>
        <span className="mx-auto hidden rounded-md bg-surface-sunken px-16 py-1 font-mono text-2xs text-fg-subtle sm:block">
          anvaya.app
        </span>
      </div>
      {children}
    </div>
  );
}

export function ProductTour() {
  return (
    <Tabs defaultValue="plan" className="flex flex-col gap-6">
      <TabsList className="mx-auto max-w-full scrollbar-thin justify-start overflow-x-auto border-b-0 sm:justify-center">
        {SHOTS.map((s) => (
          <TabsTrigger key={s.key} value={s.key} className="shrink-0">
            {s.icon}
            {s.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {SHOTS.map((s) => (
        <TabsContent
          key={s.key}
          value={s.key}
          className="flex flex-col gap-4 focus-visible:outline-none"
        >
          <p className="mx-auto max-w-2xl text-center text-base text-fg-muted">{s.caption}</p>
          <BrowserFrame>
            <Image
              src={s.light}
              alt={s.alt}
              placeholder="blur"
              sizes="(min-width: 1280px) 1200px, 100vw"
              className="h-auto w-full dark:hidden"
            />
            <Image
              src={s.dark}
              alt={s.alt}
              placeholder="blur"
              sizes="(min-width: 1280px) 1200px, 100vw"
              className="hidden h-auto w-full dark:block"
            />
          </BrowserFrame>
        </TabsContent>
      ))}
    </Tabs>
  );
}
