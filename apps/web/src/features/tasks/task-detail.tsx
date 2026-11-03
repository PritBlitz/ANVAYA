"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Activity, ExternalLink } from "lucide-react";
import { ModeBadge, RunStatusBadge, TaskStatusBadge } from "@/components/domain/badges";
import { RichText } from "@/components/domain/rich-text";
import { MetaList, PageContainer, PageHeader, SectionTitle } from "@/components/layout/page";
import { Card, CardBody, CardHeader, SkeletonRows } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useRepository, useTask, useTaskRuns } from "@/lib/api/queries";
import { isActiveRun } from "@/lib/domain/status";
import { useWorkspace } from "@/lib/workspace/context";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { sourceLabel, SourceIcon } from "./tasks-screen";
import { SourceContextCard } from "./source-context";
import { StartRunForm } from "./start-run-form";

export function TaskDetailScreen() {
  const { taskId } = useParams<{ taskId: string }>();
  const { base, can } = useWorkspace();
  const task = useTask(taskId);
  const runs = useTaskRuns(taskId);
  const repo = useRepository(task.data?.repository_id);

  if (task.isPending) {
    return (
      <PageContainer>
        <SkeletonRows rows={8} />
      </PageContainer>
    );
  }
  if (task.isError) return <ErrorState error={task.error} onRetry={() => task.refetch()} />;
  const t = task.data;
  const active = runs.data?.find((r) => isActiveRun(r.status));
  // The server-provided link (http/https only, checked by the mapper) wins; older tasks
  // without one fall back to the conventional GitHub URL.
  const githubUrl =
    t.source_url ??
    (t.external_number &&
    t.repository_full_name &&
    t.source_type !== "manual" &&
    t.source_type !== "failing_check"
      ? `https://github.com/${t.repository_full_name}/${t.source_type === "pull_request" ? "pull" : "issues"}/${t.external_number}`
      : null);

  return (
    <PageContainer>
      <PageHeader
        eyebrow={
          <Link href={`${base}/tasks`} className="hover:text-fg">
            Tasks
          </Link>
        }
        title={t.title}
        meta={
          <>
            <TaskStatusBadge status={t.status} />
            <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
              <SourceIcon source={t.source_type} /> {sourceLabel(t)}
            </span>
            {githubUrl && (
              <a
                href={githubUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-xs text-link hover:underline"
              >
                Open on GitHub <ExternalLink className="size-3" />
              </a>
            )}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              title="Description"
              description={
                t.source_type === "manual"
                  ? undefined
                  : "Imported from GitHub — treated as untrusted context."
              }
            />
            <CardBody>
              <RichText text={t.description} />
            </CardBody>
          </Card>
          {t.source_context && <SourceContextCard context={t.source_context} />}
          <section className="flex flex-col gap-3" aria-labelledby="runs-title">
            <SectionTitle>
              <span id="runs-title">Runs</span>
            </SectionTitle>
            <Card className="overflow-hidden">
              {runs.isPending ? (
                <SkeletonRows rows={2} className="p-4" />
              ) : runs.isError ? (
                <ErrorState compact error={runs.error} onRetry={() => runs.refetch()} />
              ) : runs.data.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Activity />}
                  title="No runs yet"
                  description="Start a run to investigate the repository and propose a plan."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {runs.data.map((r) => (
                    <li
                      key={r.id}
                      className="relative flex items-center gap-3 px-4 py-3 hover:bg-surface-hover"
                    >
                      <span className="font-mono text-xs text-fg-subtle">#{r.run_number}</span>
                      <Link
                        href={`${base}/runs/${r.id}`}
                        className="min-w-0 flex-1 truncate text-sm text-fg after:absolute after:inset-0"
                      >
                        Started {formatRelative(r.created_at)}
                      </Link>
                      <ModeBadge mode={r.mode} />
                      <RunStatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>
        </div>
        <aside className="flex flex-col gap-6">
          {can("runs.operate") && t.status !== "archived" && (
            <Card>
              <CardHeader
                title="Start a run"
                description="Investigation and planning first. Code changes wait for your approval."
              />
              <CardBody>
                <StartRunForm
                  taskId={t.id}
                  repo={repo.data}
                  disabledReason={active ? "This task already has an active run." : null}
                />
              </CardBody>
            </Card>
          )}
          <Card>
            <CardBody>
              <MetaList
                items={[
                  {
                    label: "Repository",
                    value: (
                      <Link
                        className="text-link hover:underline"
                        href={`${base}/repositories/${t.repository_id}`}
                      >
                        {t.repository_full_name ?? "—"}
                      </Link>
                    ),
                  },
                  {
                    label: "Created",
                    value: (
                      <span title={formatDateTime(t.created_at)}>
                        {formatRelative(t.created_at)}
                      </span>
                    ),
                  },
                  { label: "Updated", value: formatRelative(t.updated_at) },
                  { label: "Labels", value: t.labels.length ? t.labels.join(", ") : "—" },
                ]}
              />
            </CardBody>
          </Card>
        </aside>
      </div>
    </PageContainer>
  );
}
