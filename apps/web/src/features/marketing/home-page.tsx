import Link from "next/link";
import {
  ArrowRight,
  Ban,
  BookOpen,
  Check,
  Cpu,
  FileSearch,
  GitMerge,
  Lock,
  ScrollText,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { AnvayaMark, AnvayaWordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { HeroVisual } from "./hero-visual";
import { HowItWorks } from "./how-it-works";
import { anim, revealDelay } from "./motion";
import { ProductTour } from "./product-tour";
import { RevealObserver } from "./reveal-observer";
import { TrustDiagram } from "./trust-diagram";

const NAV = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#product", label: "Product" },
  { href: "#capabilities", label: "Capabilities" },
  { href: "#security", label: "Security" },
];

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-bg/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-5 sm:px-8">
        <Link
          href="/"
          aria-label="Anvaya home"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <AnvayaWordmark />
        </Link>
        <nav aria-label="Homepage sections" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <a
              key={n.href}
              href={n.href}
              className="rounded-md px-3 py-1.5 text-sm text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
            >
              {n.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="ghost" className="hidden sm:inline-flex">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild variant="primary">
            <Link href="/login">
              Get started <ArrowRight />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background-image:linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_75%)] [background-size:44px_44px] opacity-60"
      />
      <div className="relative mx-auto grid max-w-7xl grid-cols-1 items-center gap-14 px-5 pt-16 pb-24 sm:px-8 lg:grid-cols-[1fr_1.05fr] lg:pt-24 lg:pb-32">
        <div className="min-w-0">
          <p
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-fg-muted shadow-xs mk-anim"
            style={anim("mk-rise", { duration: 700 })}
          >
            <span className="size-1.5 rounded-full bg-primary" />
            AI-native software engineering, with receipts
          </p>
          <h1
            id="hero-title"
            className="mt-6 font-display text-[2.9rem] leading-[1.02] tracking-tight text-fg mk-anim sm:text-[4rem] lg:text-[4.6rem]"
            style={anim("mk-rise", { delay: 80, duration: 800 })}
          >
            From codebase understanding to{" "}
            <em className="text-primary not-italic dark:text-link">evidence-backed</em> engineering
            change.
          </h1>
          <p
            className="mt-6 max-w-xl text-lg leading-relaxed text-fg-muted mk-anim"
            style={anim("mk-rise", { delay: 180, duration: 800 })}
          >
            Anvaya understands your repository as a connected system, then investigates, plans,
            implements, verifies and reviews changes — showing what it examined, what it ran, and
            what passed. You approve every consequential step.
          </p>
          <div
            className="mt-9 flex flex-wrap items-center gap-3 mk-anim"
            style={anim("mk-rise", { delay: 280, duration: 800 })}
          >
            <Button asChild variant="primary" size="lg" className="h-11 px-5">
              <Link href="/login">
                Get started <ArrowRight />
              </Link>
            </Button>
            <Button asChild variant="secondary" size="lg" className="h-11 px-5">
              <a href="#how-it-works">See how it works</a>
            </Button>
          </div>
          <ul
            className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm text-fg-muted mk-anim"
            style={anim("mk-rise", { delay: 380, duration: 800 })}
          >
            {[
              "Local inference by default",
              "No code changes before you approve",
              "Never auto-merges",
            ].map((t) => (
              <li key={t} className="flex items-center gap-1.5">
                <Check className="size-4 text-success" /> {t}
              </li>
            ))}
          </ul>
        </div>
        <HeroVisual />
      </div>
    </section>
  );
}

const PRINCIPLES: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <FileSearch />,
    title: "Evidence before assertion",
    body: "Claims cite files, line ranges, commits, and command output.",
  },
  {
    icon: <ShieldCheck />,
    title: "Human accountability",
    body: "AI proposes. Authorized people approve plans and pull requests.",
  },
  {
    icon: <TerminalSquare />,
    title: "Deterministic verification",
    body: "Tests and scanners decide outcomes — never a model's confidence.",
  },
  {
    icon: <Cpu />,
    title: "Local-first",
    body: "Inference runs on your hardware unless your workspace opts in.",
  },
];

function Principles() {
  return (
    <section aria-label="Principles" className="border-y border-border bg-bg-subtle">
      <ul className="mx-auto grid max-w-7xl gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
        {PRINCIPLES.map((p, i) => (
          <li
            key={p.title}
            data-reveal
            style={revealDelay(i * 90)}
            className="flex gap-4 bg-bg-subtle px-6 py-8 sm:px-8"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-fg [&_svg]:size-4">
              {p.icon}
            </span>
            <div>
              <p className="font-medium text-fg">{p.title}</p>
              <p className="mt-1 text-sm text-fg-muted">{p.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SectionHeading({
  eyebrow,
  title,
  body,
  id,
  center,
}: {
  eyebrow: string;
  title: ReactNode;
  body?: ReactNode;
  id: string;
  center?: boolean;
}) {
  return (
    <div data-reveal className={center ? "mx-auto max-w-3xl text-center" : "max-w-3xl"}>
      <p className="font-mono text-xs tracking-[0.18em] text-primary uppercase dark:text-link">
        {eyebrow}
      </p>
      <h2
        id={id}
        className="mt-3 font-display text-[2.4rem] leading-[1.08] tracking-tight text-fg sm:text-[3.2rem]"
      >
        {title}
      </h2>
      {body && <p className="mt-4 text-lg leading-relaxed text-fg-muted">{body}</p>}
    </div>
  );
}

function HowItWorksSection() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-title"
      className="dark scroll-mt-16 overflow-x-clip bg-bg text-fg"
    >
      <div className="relative mx-auto max-w-7xl px-5 py-24 sm:px-8 lg:py-32">
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 left-1/2 h-72 w-[48rem] -translate-x-1/2 rounded-full bg-primary/25 blur-3xl"
        />
        <div className="relative">
          <SectionHeading
            id="how-title"
            eyebrow="How it works"
            title={
              <>
                Six steps from intent to a reviewed pull request.
                <span className="text-fg-muted"> Two of them are yours.</span>
              </>
            }
            body="Every run is a durable, observable workflow with budgets, checkpoints and cancellation. It pauses for you at the plan and again before anything is written to GitHub."
          />
          <div className="mt-16 lg:mt-8">
            <HowItWorks />
          </div>
        </div>
      </div>
    </section>
  );
}

function ProductSection() {
  return (
    <section id="product" aria-labelledby="product-title" className="scroll-mt-16">
      <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8 lg:py-32">
        <SectionHeading
          center
          id="product-title"
          eyebrow="The product"
          title="An engineering workspace, not a chat box."
          body="Every screen is built to inspect and control work: what was retrieved, what was proposed, what changed, what ran, and who approved it."
        />
        <div data-reveal className="mt-12">
          <ProductTour />
        </div>
      </div>
    </section>
  );
}

function CapabilityCard({
  title,
  body,
  children,
  className,
  delay = 0,
}: {
  title: string;
  body: string;
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <li
      data-reveal
      style={revealDelay(delay)}
      className={`flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xs ${className ?? ""}`}
    >
      <div
        aria-hidden
        className="relative flex min-h-40 flex-1 items-center justify-center overflow-hidden border-b border-border bg-bg-subtle p-6"
      >
        {children}
      </div>
      <div className="p-6">
        <h3 className="text-base font-semibold text-fg">{title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{body}</p>
      </div>
    </li>
  );
}

function Capabilities() {
  return (
    <section
      id="capabilities"
      aria-labelledby="cap-title"
      className="scroll-mt-16 border-t border-border bg-bg-subtle"
    >
      <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8 lg:py-32">
        <SectionHeading
          id="cap-title"
          eyebrow="Capabilities"
          title="Built for the questions reviewers actually ask."
        />
        <ul className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          <CapabilityCard
            title="Repository intelligence"
            body="Tree-sitter parsing, line-aware chunks, local embeddings, and coverage you can audit — versioned by commit SHA."
          >
            <div className="w-full max-w-md space-y-2 font-mono text-xs">
              {[
                ["typescript", 92, "tree-sitter"],
                ["python", 64, "tree-sitter"],
                ["markdown", 100, "text"],
              ].map(([lang, pct, parser]) => (
                <div key={lang as string} className="flex items-center gap-3">
                  <span className="w-20 text-fg">{lang}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                    <span
                      className="block h-full origin-left rounded-full bg-chart-1"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="w-20 text-right text-fg-muted">{parser}</span>
                </div>
              ))}
              <p className="pt-1 text-fg-subtle">excluded: secrets · dependencies · build output</p>
            </div>
          </CapabilityCard>
          <CapabilityCard
            title="Grounded answers"
            body="Hybrid lexical and semantic retrieval. Citations carry path, lines, commit and content hash — or the answer says evidence is missing."
            delay={80}
          >
            <p className="max-w-56 text-sm leading-relaxed text-fg">
              Expiry is checked in{" "}
              <code className="rounded-xs bg-surface px-1 font-mono text-xs">isExpired</code>
              <span className="mx-0.5 rounded-xs bg-accent px-1 font-mono text-2xs font-semibold text-accent-fg">
                1
              </span>{" "}
              with a 30s skew
              <span className="mx-0.5 rounded-xs bg-accent px-1 font-mono text-2xs font-semibold text-accent-fg">
                2
              </span>
            </p>
          </CapabilityCard>
          <CapabilityCard
            title="Bounded autonomy"
            body="Every run has step, token, time, changed-file and repair budgets, enforced by the server. Cancel any time."
            delay={120}
          >
            <div className="w-full max-w-56 space-y-3 text-xs">
              {[
                ["Steps", 5, 8],
                ["Tokens", 9.6, 12],
                ["Repairs", 0, 1],
              ].map(([l, u, m]) => (
                <div key={l as string}>
                  <div className="flex justify-between text-fg-muted">
                    <span>{l}</span>
                    <span className="font-mono text-fg">
                      {u}/{m}
                      {l === "Tokens" ? "k" : ""}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${((u as number) / (m as number)) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CapabilityCard>
          <CapabilityCard
            title="Provenance on every finding"
            body="AI review findings are labelled as AI. Scanner and test results are labelled as tools. You never have to guess which is which."
            delay={160}
          >
            <div className="flex flex-col gap-2 text-xs">
              <span className="flex items-center gap-1.5 rounded-sm border border-ai-border bg-ai-soft px-2 py-1 text-ai">
                <Sparkles className="size-3" /> AI review · medium
              </span>
              <span className="flex items-center gap-1.5 rounded-sm border border-border bg-surface px-2 py-1 text-fg-muted">
                <ShieldCheck className="size-3" /> Security scanner · high
              </span>
              <span className="flex items-center gap-1.5 rounded-sm border border-border bg-surface px-2 py-1 text-fg-muted">
                <TerminalSquare className="size-3" /> npm test · exit 0
              </span>
            </div>
          </CapabilityCard>
          <CapabilityCard
            title="Audit and cost, in the open"
            body="Approvals, policy changes and PR creation are audited. Token use, local share and hosted spend are visible per workspace."
            delay={200}
          >
            <ul className="w-full max-w-64 space-y-1.5 font-mono text-2xs">
              {[
                ["10:42", "plan.approved", "Ira Shah"],
                ["10:51", "pull_request.approved", "Mei Lin"],
                ["10:51", "pull_request.created", "#482"],
              ].map(([t, a, w]) => (
                <li key={a} className="flex gap-2">
                  <span className="text-fg-subtle">{t}</span>
                  <span className="text-fg">{a}</span>
                  <span className="ml-auto text-fg-muted">{w}</span>
                </li>
              ))}
            </ul>
          </CapabilityCard>
          <CapabilityCard
            title="Knowledge that compounds"
            body="Architecture docs, decision records and engineering notes are indexed with provenance and cited alongside code."
            delay={240}
          >
            <div className="flex items-center gap-3 text-xs">
              <BookOpen className="size-8 text-accent-fg" />
              <div className="space-y-1">
                <p className="text-fg">ADR-006 · Idempotent charges</p>
                <p className="text-fg-muted">cited in 3 plans · indexed 5 days ago</p>
              </div>
            </div>
          </CapabilityCard>
        </ul>
      </div>
    </section>
  );
}

function Security() {
  return (
    <section id="security" aria-labelledby="security-title" className="scroll-mt-16">
      <div className="mx-auto flex max-w-7xl flex-col gap-14 px-5 py-24 sm:px-8 lg:py-32">
        <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:items-end">
          <SectionHeading
            id="security-title"
            eyebrow="Security & privacy"
            title="Repository code is untrusted. So is model output."
            body="Anvaya is designed so that a malicious README, a poisoned dependency, or a confident model can't reach your secrets, your network, or your main branch."
          />
          <ul className="space-y-3">
            {[
              [
                <Lock key="l" />,
                "Tenant-scoped authorization on every request; roles enforced by the server.",
              ],
              [
                <TerminalSquare key="t" />,
                "Code executes only in a disposable sandbox: non-root, resource-limited, network denied by default.",
              ],
              [
                <Cpu key="c" />,
                "Local inference by default. Hosted models are opt-in, disclosed, and never a silent fallback.",
              ],
              [
                <ScrollText key="s" />,
                "Secrets are excluded from indexing and prompts. Security-relevant actions are audited.",
              ],
            ].map(([icon, text], i) => (
              <li
                key={i}
                data-reveal
                style={revealDelay(i * 80)}
                className="flex gap-3 text-sm text-fg"
              >
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-hover text-primary [&_svg]:size-3.5">
                  {icon}
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <div
          data-reveal
          tabIndex={0}
          role="region"
          aria-label="Trust boundaries diagram"
          className="overflow-x-auto rounded-2xl border border-border bg-surface p-4 shadow-md sm:p-8"
        >
          <div className="min-w-[720px]">
            <TrustDiagram />
          </div>
        </div>
      </div>
    </section>
  );
}

const ALWAYS = [
  "Cites the evidence behind every claim",
  "Pauses for your approval before changing code",
  "Runs only server-defined test, lint and build profiles",
  "Shows failed, skipped and unavailable checks separately",
  "Binds approvals to the exact plan and patch",
];
const NEVER = [
  "Merges or deploys on its own",
  "Executes arbitrary shell commands from a model",
  "Sends private code to a hosted model without opt-in",
  "Treats a model's confidence as proof",
  "Reads secrets to improve its context",
];

function Boundaries() {
  return (
    <section aria-labelledby="boundaries-title" className="border-t border-border bg-bg-subtle">
      <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
        <SectionHeading
          center
          id="boundaries-title"
          eyebrow="Clear boundaries"
          title="What Anvaya always does — and never does."
        />
        <div className="mx-auto mt-12 grid max-w-5xl gap-5 md:grid-cols-2">
          <div data-reveal className="rounded-xl border border-success-border bg-surface p-7">
            <p className="flex items-center gap-2 font-semibold text-fg">
              <ShieldCheck className="size-5 text-success" /> Always
            </p>
            <ul className="mt-5 space-y-3">
              {ALWAYS.map((t) => (
                <li key={t} className="flex gap-2.5 text-sm text-fg">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" /> {t}
                </li>
              ))}
            </ul>
          </div>
          <div
            data-reveal
            style={revealDelay(120)}
            className="rounded-xl border border-border bg-surface p-7"
          >
            <p className="flex items-center gap-2 font-semibold text-fg">
              <Ban className="size-5 text-danger" /> Never
            </p>
            <ul className="mt-5 space-y-3">
              {NEVER.map((t) => (
                <li key={t} className="flex gap-2.5 text-sm text-fg">
                  <X className="mt-0.5 size-4 shrink-0 text-danger" /> {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="dark relative overflow-hidden bg-[#2a0710]">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 -bottom-40 size-[34rem] rounded-full bg-[#7f011f] opacity-60 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background-image:linear-gradient(#f5ebd0_1px,transparent_1px),linear-gradient(90deg,#f5ebd0_1px,transparent_1px)] [background-size:36px_36px] opacity-[0.07]"
      />
      <div className="relative mx-auto flex max-w-4xl flex-col items-center px-5 py-24 text-center sm:px-8 lg:py-28">
        <div data-reveal>
          <AnvayaMark size={44} className="mx-auto" />
          <h2
            id="cta-title"
            className="mt-6 font-display text-[2.6rem] leading-[1.05] text-[#f5ebd0] sm:text-[3.6rem]"
          >
            Bring your repository.
            <br /> Keep your judgment.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-[#f5ebd0]/75">
            Connect a repository, ask your first question, and watch a change go from plan to pull
            request — with you in control.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <Button
              asChild
              size="lg"
              className="h-11 border-transparent bg-[#f5ebd0] px-5 text-[#2a0710] hover:bg-[#eadbb4]"
            >
              <Link href="/login">
                Get started <ArrowRight />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-11 border-[#f5ebd0]/30 px-5 text-[#f5ebd0] hover:bg-[#f5ebd0]/10"
            >
              <a href="#how-it-works">
                <GitMerge /> Walk through a run
              </a>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-border bg-bg">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div>
          <AnvayaWordmark />
          <p className="mt-2 text-sm text-fg-muted">
            From codebase understanding to evidence-backed engineering change.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-fg-muted">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className="hover:text-fg">
              {n.label}
            </a>
          ))}
          <Link href="/login" className="hover:text-fg">
            Sign in
          </Link>
        </nav>
      </div>
      <div className="border-t border-border">
        <p className="mx-auto flex max-w-7xl items-center gap-2 px-5 py-4 text-xs text-fg-subtle sm:px-8">
          <span>
            <span className="italic">Anvaya</span> (Sanskrit): connection, relation, coherent
            sequence.
          </span>
        </p>
      </div>
    </footer>
  );
}

/** Public homepage. Server-rendered and static; motion is CSS plus two small client islands. */
export function HomePage() {
  return (
    <div className="min-h-dvh bg-bg">
      <SiteHeader />
      <main id="main">
        <Hero />
        <Principles />
        <HowItWorksSection />
        <ProductSection />
        <Capabilities />
        <Security />
        <Boundaries />
        <FinalCta />
      </main>
      <SiteFooter />
      <RevealObserver />
    </div>
  );
}
