"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CircleDot, GitPullRequest, ListTodo, Pencil, Plus, XOctagon } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { RunStatusBadge, TaskStatusBadge } from "@/components/domain/badges";
import { PageContainer, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Card, SkeletonRows } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useRepositories, useTasks } from "@/lib/api/queries";
import type { EngineeringTask, TaskSourceType, TaskStatus } from "@/lib/api/types";
import { TASK_SOURCE_LABEL } from "@/lib/domain/status";
import { useWorkspace } from "@/lib/workspace/context";
import { cn } from "@/lib/utils/cn";
import { formatRelative } from "@/lib/utils/format";
import { useRepoId } from "@/features/repositories/repo-layout";
import { CreateTaskDialog } from "./create-task-dialog";

export function SourceIcon({ source }: { source: TaskSourceType }) {
  const icon: Record<TaskSourceType, ReactNode> = {
    manual: <Pencil />,
    github_issue: <CircleDot />,
    pull_request: <GitPullRequest />,
    failing_check: <XOctagon />,
  };
  return <span className="text-fg-subtle [&_svg]:size-3.5">{icon[source]}</span>;
}

export function sourceLabel(task: Pick<EngineeringTask, "source_type" | "external_number">) {
  return task.external_number
    ? `${TASK_SOURCE_LABEL[task.source_type]} #${task.external_number}`
    : TASK_SOURCE_LABEL[task.source_type];
}

const FILTERS: { value: TaskStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "active", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

function TaskTable({ repositoryId }: { repositoryId?: string }) {
  const { base, can } = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const status = (params.get("status") as TaskStatus | null) ?? undefined;
  const repoFilter = repositoryId ?? params.get("repo") ?? undefined;
  const tasks = useTasks({ status, repository_id: repoFilter });
  const repos = useRepositories();
  const isNewOpen = params.get("new") === "1";

  const setParam = (key: string, value: string | null) => {
    const q = new URLSearchParams(params.toString());
    if (value) q.set(key, value);
    else q.delete(key);
    router.replace(`${pathname}${q.size ? `?${q}` : ""}`, { scroll: false });
  };

  const newButton = can("tasks.create") && (
    <Button variant="primary" onClick={() => setParam("new", "1")}>
      <Plus /> New task
    </Button>
  );

  const rows = useMemo(() => tasks.data ?? [], [tasks.data]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Filter by status"
          className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-0.5 shadow-xs"
        >
          {FILTERS.map((f) => {
            const active = (status ?? "all") === f.value;
            return (
              <button
                key={f.value}
                type="button"
                aria-pressed={active}
                onClick={() => setParam("status", f.value === "all" ? null : f.value)}
                className={cn(
                  "h-7 rounded-md px-2.5 text-sm font-medium",
                  active ? "bg-surface-selected text-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          {!repositoryId && (repos.data?.length ?? 0) > 1 && (
            <Select
              aria-label="Filter by repository"
              value={repoFilter ?? ""}
              onChange={(e) => setParam("repo", e.target.value || null)}
              className="w-56"
            >
              <option value="">All repositories</option>
              {repos.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.full_name}
                </option>
              ))}
            </Select>
          )}
          {repositoryId && newButton}
        </div>
      </div>
      <Card className="overflow-hidden">
        {tasks.isPending ? (
          <SkeletonRows rows={5} className="p-4" label="Loading tasks" />
        ) : tasks.isError ? (
          <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ListTodo />}
            title={status ? "No tasks with this status" : "No engineering tasks yet"}
            description="A task starts from an issue, a pull request, a failing check, or a plain description."
            action={!status && newButton}
          />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((t) => (
              <li
                key={t.id}
                className="relative flex items-center gap-3 px-4 py-3 hover:bg-surface-hover"
              >
                <SourceIcon source={t.source_type} />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`${base}/tasks/${t.id}`}
                    className="block truncate text-sm font-medium text-fg after:absolute after:inset-0"
                  >
                    {t.title}
                  </Link>
                  <p className="truncate text-xs text-fg-muted">
                    {!repositoryId && <>{t.repository_full_name} · </>}
                    {sourceLabel(t)} · updated {formatRelative(t.updated_at)}
                  </p>
                </div>
                {t.labels.slice(0, 2).map((l) => (
                  <span
                    key={l}
                    className="hidden rounded-xs bg-neutral-soft px-1.5 py-0.5 text-2xs text-fg-muted md:inline"
                  >
                    {l}
                  </span>
                ))}
                {t.latest_run ? (
                  <RunStatusBadge status={t.latest_run.status} />
                ) : (
                  <TaskStatusBadge status={t.status} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <CreateTaskDialog
        open={isNewOpen}
        onOpenChange={(o) => setParam("new", o ? "1" : null)}
        defaultRepositoryId={repositoryId ?? repoFilter}
      />
    </>
  );
}

export function TasksScreen() {
  const { can } = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  return (
    <PageContainer>
      <PageHeader
        title="Tasks"
        description="Engineering work items. Each run investigates, plans, implements, verifies, and reviews — with your approval at every consequential step."
        actions={
          can("tasks.create") && (
            <Button
              variant="primary"
              onClick={() => {
                const q = new URLSearchParams(params.toString());
                q.set("new", "1");
                router.replace(`${pathname}?${q}`, { scroll: false });
              }}
            >
              <Plus /> New task
            </Button>
          )
        }
      />
      <TaskTable />
    </PageContainer>
  );
}

export function RepoTasksScreen() {
  const repoId = useRepoId();
  return (
    <PageContainer>
      <TaskTable repositoryId={repoId} />
    </PageContainer>
  );
}
