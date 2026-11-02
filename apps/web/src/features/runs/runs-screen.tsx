"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Activity, GitPullRequest, Hand, ListChecks, ShieldCheck } from "lucide-react";
import { ModeBadge, RunStatusBadge } from "@/components/domain/badges";
import { PageContainer, PageHeader, SectionTitle } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, SkeletonRows } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useRuns } from "@/lib/api/queries";
import { ACTIVE_RUN_STATUSES, type RunListItem, type RunStatus } from "@/lib/api/types";
import { useWorkspace } from "@/lib/workspace/context";
import { cn } from "@/lib/utils/cn";
import { formatRelative } from "@/lib/utils/format";

const FILTERS: { key: string; label: string; statuses?: RunStatus[] }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active", statuses: [...ACTIVE_RUN_STATUSES] },
  {
    key: "awaiting",
    label: "Needs decision",
    statuses: ["awaiting_plan_approval", "awaiting_pr_approval"],
  },
  { key: "completed", label: "Completed", statuses: ["completed", "completed_without_pr"] },
  { key: "failed", label: "Failed", statuses: ["failed", "timed_out", "cancelled", "rejected"] },
];

function RunRows({ runs }: { runs: RunListItem[] }) {
  const { base } = useWorkspace();
  return (
    <ul className="divide-y divide-border">
      {runs.map((r) => (
        <li
          key={r.id}
          className="relative flex items-center gap-3 px-4 py-3 hover:bg-surface-hover"
        >
          <span className="w-8 font-mono text-xs text-fg-subtle">#{r.run_number}</span>
          <div className="min-w-0 flex-1">
            <Link
              href={`${base}/runs/${r.id}`}
              className="block truncate text-sm font-medium text-fg after:absolute after:inset-0"
            >
              {r.task_title}
            </Link>
            <p className="truncate text-xs text-fg-muted">
              {r.repository_full_name} · updated {formatRelative(r.updated_at)}
            </p>
          </div>
          <span className="hidden md:inline-flex">
            <ModeBadge mode={r.mode} />
          </span>
          <RunStatusBadge status={r.status} />
        </li>
      ))}
    </ul>
  );
}

export function RunsScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const key = params.get("filter") ?? "all";
  const filter = FILTERS.find((f) => f.key === key) ?? FILTERS[0]!;
  const runs = useRuns(filter.statuses ? { status: filter.statuses } : {});

  return (
    <PageContainer>
      <PageHeader
        title="Runs"
        description="Every workflow run, with its durable state, evidence, and decisions."
      />
      <div
        role="group"
        aria-label="Filter runs"
        className="flex flex-wrap gap-1 self-start rounded-lg border border-border bg-surface p-0.5 shadow-xs"
      >
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={f.key === filter.key}
            onClick={() =>
              router.replace(f.key === "all" ? pathname : `${pathname}?filter=${f.key}`, {
                scroll: false,
              })
            }
            className={cn(
              "h-7 rounded-md px-2.5 text-sm font-medium",
              f.key === filter.key ? "bg-surface-selected text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <Card className="overflow-hidden">
        {runs.isPending ? (
          <SkeletonRows rows={5} className="p-4" label="Loading runs" />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
        ) : runs.data.length === 0 ? (
          <EmptyState
            icon={<Activity />}
            title="No runs"
            description="Runs start from a task. Each one is bounded by budgets and pauses for your approval."
          />
        ) : (
          <RunRows runs={runs.data} />
        )}
      </Card>
    </PageContainer>
  );
}

export function ReviewsScreen() {
  const { base } = useWorkspace();
  const plans = useRuns({ status: ["awaiting_plan_approval"] });
  const prs = useRuns({ status: ["awaiting_pr_approval"] });
  const recent = useRuns({ status: ["completed", "completed_without_pr", "rejected"] });

  const section = (
    title: string,
    icon: React.ReactNode,
    q: ReturnType<typeof useRuns>,
    empty: string,
    cta: (r: RunListItem) => { href: string; label: string },
  ) => (
    <section className="flex flex-col gap-3">
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5 [&_svg]:size-3.5">
          {icon} {title}
          {q.data && q.data.length > 0 && <span className="text-fg">· {q.data.length}</span>}
        </span>
      </SectionTitle>
      <Card className="overflow-hidden">
        {q.isPending ? (
          <SkeletonRows rows={2} className="p-4" />
        ) : q.isError ? (
          <ErrorState compact error={q.error} onRetry={() => q.refetch()} />
        ) : q.data.length === 0 ? (
          <p className="px-4 py-5 text-sm text-fg-muted">{empty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {q.data.map((r) => {
              const action = cta(r);
              return (
                <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{r.task_title}</p>
                    <p className="truncate text-xs text-fg-muted">
                      {r.repository_full_name} · run #{r.run_number} · waiting{" "}
                      {formatRelative(r.updated_at).replace(" ago", "")}
                    </p>
                  </div>
                  <Button asChild size="sm" variant="primary">
                    <Link href={action.href}>{action.label}</Link>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );

  return (
    <PageContainer className="max-w-4xl">
      <PageHeader
        title="Reviews"
        description="Decisions waiting on a human. AI proposes; authorized members approve."
      />
      {section(
        "Plans to approve",
        <ListChecks />,
        plans,
        "No plans are waiting for approval.",
        (r) => ({ href: `${base}/runs/${r.id}/plan`, label: "Review plan" }),
      )}
      {section(
        "Pull requests to approve",
        <GitPullRequest />,
        prs,
        "No changes are waiting for pull-request approval.",
        (r) => ({ href: `${base}/runs/${r.id}/pull-request`, label: "Review changes" }),
      )}
      <section className="flex flex-col gap-3">
        <SectionTitle>
          <span className="inline-flex items-center gap-1.5 [&_svg]:size-3.5">
            <ShieldCheck /> Recently decided
          </span>
        </SectionTitle>
        <Card className="overflow-hidden">
          {recent.isPending ? (
            <SkeletonRows rows={2} className="p-4" />
          ) : recent.data && recent.data.length ? (
            <RunRows runs={recent.data.slice(0, 8)} />
          ) : (
            <EmptyState compact icon={<Hand />} title="Nothing decided yet" />
          )}
        </Card>
      </section>
    </PageContainer>
  );
}
