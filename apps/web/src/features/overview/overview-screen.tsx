"use client";

import Link from "next/link";
import {
  ArrowRight,
  Cpu,
  FolderGit2,
  GitPullRequest,
  ListChecks,
  Plus,
  PlugZap,
} from "lucide-react";
import { useEffect } from "react";
import { IndexingBadge, RunStatusBadge, TaskStatusBadge } from "@/components/domain/badges";
import { PageContainer, PageHeader, SectionTitle } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, Mono, SkeletonRows } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { LAST_WORKSPACE_KEY } from "@/features/auth/home-redirect";
import { useMe, useRepositories, useRuns, useTasks, useUsage } from "@/lib/api/queries";
import { isActiveRun, runStatusMeta } from "@/lib/domain/status";
import { useWorkspace } from "@/lib/workspace/context";
import { formatCompact, formatPercent, formatRelative, shortSha } from "@/lib/utils/format";

export function OverviewScreen() {
  const { workspace, base, can, slug } = useWorkspace();
  const me = useMe();
  const repos = useRepositories();
  const runs = useRuns();
  const tasks = useTasks();
  const usage = useUsage();

  useEffect(() => {
    try {
      localStorage.setItem(LAST_WORKSPACE_KEY, slug);
    } catch {
      // ignore
    }
  }, [slug]);

  const awaiting = runs.data?.filter((r) => runStatusMeta(r.status).awaiting) ?? [];
  const active =
    runs.data?.filter((r) => isActiveRun(r.status) && !runStatusMeta(r.status).awaiting) ?? [];
  const firstName = me.data?.user.display_name?.split(" ")[0];

  if (repos.isSuccess && repos.data.length === 0) {
    return (
      <PageContainer>
        <PageHeader
          title={`Welcome${firstName ? `, ${firstName}` : ""}`}
          description={workspace.name}
        />
        <Card>
          <EmptyState
            icon={<PlugZap />}
            title="Connect your first repository"
            description="Anvaya indexes a repository at a specific commit so every answer, plan, and finding can cite exact lines."
            action={
              can("repositories.manage") ? (
                <Button asChild variant="primary">
                  <Link href={`${base}/repositories/connect`}>
                    <PlugZap /> Connect GitHub repository
                  </Link>
                </Button>
              ) : (
                <p className="text-sm text-fg-muted">
                  Ask a workspace admin to connect a repository.
                </p>
              )
            }
          />
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : "Overview"}
        description="What needs a decision, what's running, and the health of your indexed code."
        actions={
          can("tasks.create") && (
            <Button asChild variant="primary">
              <Link href={`${base}/tasks?new=1`}>
                <Plus /> New task
              </Link>
            </Button>
          )
        }
      />

      <section aria-labelledby="attention" className="flex flex-col gap-3">
        <SectionTitle>
          <span id="attention">Needs your decision</span>
        </SectionTitle>
        {runs.isPending ? (
          <Card className="p-4">
            <SkeletonRows rows={2} />
          </Card>
        ) : runs.isError ? (
          <Card>
            <ErrorState compact error={runs.error} onRetry={() => runs.refetch()} />
          </Card>
        ) : awaiting.length === 0 ? (
          <Card className="px-4 py-5 text-sm text-fg-muted">
            Nothing is waiting on a human decision right now.
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {awaiting.map((run) => {
              const isPlan = run.status === "awaiting_plan_approval";
              return (
                <Link
                  key={run.id}
                  href={`${base}/runs/${run.id}/${isPlan ? "plan" : "review"}`}
                  className="group flex flex-col gap-3 rounded-lg border border-warning-border bg-surface p-4 shadow-xs transition-colors hover:border-warning focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <div className="flex items-center justify-between gap-3">
                    <RunStatusBadge status={run.status} />
                    <span className="text-xs text-fg-subtle">{formatRelative(run.updated_at)}</span>
                  </div>
                  <div>
                    <p className="line-clamp-2 font-medium text-fg">{run.task_title}</p>
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {run.repository_full_name} · run #{run.run_number}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-link">
                    {isPlan ? "Review plan" : "Review changes"}
                    <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section aria-labelledby="runs-heading" className="flex flex-col gap-3">
          <SectionTitle
            action={
              <Link href={`${base}/runs`} className="text-xs text-link hover:underline">
                All runs
              </Link>
            }
          >
            <span id="runs-heading">In progress</span>
          </SectionTitle>
          <Card>
            {runs.isPending ? (
              <div className="p-4">
                <SkeletonRows rows={3} />
              </div>
            ) : active.length === 0 ? (
              <p className="px-4 py-5 text-sm text-fg-muted">No runs are executing.</p>
            ) : (
              <ul className="divide-y divide-border">
                {active.map((run) => (
                  <li key={run.id}>
                    <Link
                      href={`${base}/runs/${run.id}`}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-surface-hover"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-fg">
                          {run.task_title}
                        </span>
                        <span className="block truncate text-xs text-fg-muted">
                          {run.repository_full_name}
                        </span>
                      </span>
                      <RunStatusBadge status={run.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <SectionTitle
            action={
              <Link href={`${base}/tasks`} className="text-xs text-link hover:underline">
                All tasks
              </Link>
            }
            className="mt-3"
          >
            Recent tasks
          </SectionTitle>
          <Card>
            {tasks.isPending ? (
              <div className="p-4">
                <SkeletonRows rows={4} />
              </div>
            ) : tasks.isError ? (
              <ErrorState compact error={tasks.error} onRetry={() => tasks.refetch()} />
            ) : tasks.data.length === 0 ? (
              <EmptyState
                compact
                icon={<ListChecks />}
                title="No tasks yet"
                description="Create a task from an issue, failing check, or a description."
              />
            ) : (
              <ul className="divide-y divide-border">
                {tasks.data.slice(0, 5).map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`${base}/tasks/${t.id}`}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-surface-hover"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-fg">{t.title}</span>
                        <span className="block truncate text-xs text-fg-muted">
                          {t.repository_full_name} · updated {formatRelative(t.updated_at)}
                        </span>
                      </span>
                      {t.latest_run ? (
                        <RunStatusBadge status={t.latest_run.status} />
                      ) : (
                        <TaskStatusBadge status={t.status} />
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        <aside className="flex flex-col gap-3" aria-label="Workspace health">
          <SectionTitle
            action={
              <Link href={`${base}/repositories`} className="text-xs text-link hover:underline">
                Manage
              </Link>
            }
          >
            Repositories
          </SectionTitle>
          <Card>
            {repos.isPending ? (
              <div className="p-4">
                <SkeletonRows rows={2} />
              </div>
            ) : repos.isError ? (
              <ErrorState compact error={repos.error} onRetry={() => repos.refetch()} />
            ) : (
              <ul className="divide-y divide-border">
                {repos.data.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`${base}/repositories/${r.id}`}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-surface-hover"
                    >
                      <FolderGit2 className="size-4 shrink-0 text-fg-subtle" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-fg">
                          {r.full_name}
                        </span>
                        <Mono>
                          {r.latest_indexed_commit_sha
                            ? `@ ${shortSha(r.latest_indexed_commit_sha)}`
                            : "not indexed"}
                        </Mono>
                      </span>
                      <IndexingBadge status={r.indexing_status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <SectionTitle
            action={
              <Link href={`${base}/usage`} className="text-xs text-link hover:underline">
                Usage
              </Link>
            }
            className="mt-3"
          >
            Inference · 14 days
          </SectionTitle>
          <Card className="grid grid-cols-2 divide-x divide-border">
            <div className="p-4">
              <p className="text-xs text-fg-muted">Tokens</p>
              <p className="mt-1 text-lg font-semibold text-fg tabular">
                {usage.data
                  ? formatCompact(usage.data.totals.input_tokens + usage.data.totals.output_tokens)
                  : "—"}
              </p>
            </div>
            <div className="p-4">
              <p className="flex items-center gap-1 text-xs text-fg-muted">
                <Cpu className="size-3" /> Local share
              </p>
              <p className="mt-1 text-lg font-semibold text-fg tabular">
                {usage.data ? formatPercent(usage.data.totals.local_share) : "—"}
              </p>
            </div>
          </Card>
          <Card className="flex items-start gap-3 p-4 text-sm">
            <GitPullRequest className="mt-0.5 size-4 shrink-0 text-primary" />
            <p className="text-fg-muted">
              Anvaya opens pull requests only after a member approves the reviewed patch. It never
              merges or deploys.
            </p>
          </Card>
        </aside>
      </div>
    </PageContainer>
  );
}
