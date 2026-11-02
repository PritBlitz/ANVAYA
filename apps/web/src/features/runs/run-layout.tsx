"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  AlertOctagon,
  ArrowRight,
  Ban,
  FileDiff,
  FlaskConical,
  GitPullRequest,
  Hand,
  ListChecks,
  RotateCw,
  ShieldCheck,
  Waypoints,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ModeBadge, RunStatusBadge } from "@/components/domain/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Mono, Skeleton } from "@/components/ui/misc";
import { ConfirmDialog, Tooltip } from "@/components/ui/overlays";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { NavTabs } from "@/components/ui/tabs";
import { createIdempotencyKey } from "@/lib/api/client";
import { qk, useRun, useRunSteps } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type { WorkflowRun } from "@/lib/api/types";
import { reachedPhase } from "@/lib/domain/events";
import { canCancelRun, canRetryRun, phaseStates } from "@/lib/domain/status";
import { notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { formatDuration, formatRelative } from "@/lib/utils/format";
import { RunContext } from "./run-context";
import { RunStepper } from "./run-stepper";
import { useRunEvents, type StreamState } from "./use-run-events";

/** Live elapsed time while a run is active; fixed once it has ended. */
function Elapsed({ startedAt, endedAt }: { startedAt: string; endedAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [endedAt]);
  const end = endedAt ? Date.parse(endedAt) : now;
  return (
    <span className="tabular">{formatDuration(Math.max(0, end - Date.parse(startedAt)))}</span>
  );
}

function StreamIndicator({ state, active }: { state: StreamState; active: boolean }) {
  if (!active) return null;
  const live = state === "live";
  return (
    <Tooltip
      content={
        live
          ? "Receiving live events"
          : state === "reconnecting"
            ? "Reconnecting — polling meanwhile"
            : "Live updates unavailable — polling"
      }
    >
      <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted" role="status">
        {live ? (
          <Wifi className="size-3.5 text-success" />
        ) : (
          <WifiOff className="size-3.5 text-warning" />
        )}
        {live ? "Live" : state === "connecting" ? "Connecting" : "Reconnecting"}
      </span>
    </Tooltip>
  );
}

function RunActions({ run }: { run: WorkflowRun }) {
  const { can, base, workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelKey = useRef(createIdempotencyKey());
  const cancel = useMutation({
    mutationFn: () => api.runs.cancel(run.id, cancelKey.current),
    onSuccess: (updated) => {
      queryClient.setQueryData(qk.run(workspaceId, run.id), updated);
      void queryClient.invalidateQueries({ queryKey: qk.ws(workspaceId) });
      setConfirmCancel(false);
      toast.success("Run cancelled", {
        description: "Model and tool calls stopped; the sandbox was terminated.",
      });
    },
    onError: (e) => {
      cancelKey.current = createIdempotencyKey();
      notifyError(e, "Couldn't cancel the run");
    },
  });
  const retry = useMutation({
    mutationFn: () => api.runs.retry(run.id, `retry-${run.id}`),
    onSuccess: (next) => {
      void queryClient.invalidateQueries({ queryKey: qk.ws(workspaceId) });
      toast.success(`Run #${next.run_number} started`);
      router.push(`${base}/runs/${next.id}`);
    },
    onError: (e) => notifyError(e, "Couldn't retry the run"),
  });
  if (!can("runs.operate")) return null;
  return (
    <div className="flex items-center gap-2">
      {canRetryRun(run.status) && (
        <Button size="sm" onClick={() => retry.mutate()} loading={retry.isPending}>
          <RotateCw /> Retry as new run
        </Button>
      )}
      {canCancelRun(run.status) && (
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          onClick={() => setConfirmCancel(true)}
        >
          <Ban /> Cancel run
        </Button>
      )}
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this run?"
        description="Anvaya stops new model and tool calls, terminates the sandbox, and records the run as cancelled. This can't be undone, but you can retry as a new run."
        confirmLabel="Cancel run"
        confirmVariant="danger"
        pending={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
    </div>
  );
}

function DecisionBanner({ run, root }: { run: WorkflowRun; root: string }) {
  const { can } = useWorkspace();
  const pathname = usePathname();
  // The decision panel is already on screen on the target tab; don't repeat the CTA.
  if (run.status === "awaiting_plan_approval" && pathname === `${root}/plan`) return null;
  if (run.status === "awaiting_pr_approval" && pathname === `${root}/pull-request`) return null;
  if (run.status === "awaiting_plan_approval") {
    return (
      <InlineAlert
        tone="warning"
        icon={<Hand />}
        title="Plan approval needed"
        action={
          <Button asChild size="sm" variant="primary">
            <Link href={`${root}/plan`}>
              Review plan <ArrowRight />
            </Link>
          </Button>
        }
      >
        {can("approvals.decide")
          ? "The run is paused. No code is modified until a member approves the plan."
          : "Waiting for a member to approve the plan."}
      </InlineAlert>
    );
  }
  if (run.status === "awaiting_pr_approval" && !run.pull_request) {
    return (
      <InlineAlert
        tone="warning"
        icon={<GitPullRequest />}
        title="Ready for pull-request approval"
        action={
          <Button asChild size="sm" variant="primary">
            <Link href={`${root}/pull-request`}>
              Review and decide <ArrowRight />
            </Link>
          </Button>
        }
      >
        Verification and review finished. Inspect the changes and evidence before approving.
      </InlineAlert>
    );
  }
  if (run.status === "failed" || run.status === "timed_out") {
    return (
      <InlineAlert
        tone="danger"
        icon={<AlertOctagon />}
        title={run.status === "timed_out" ? "Run timed out" : "Run failed"}
      >
        {run.error_summary ?? "The run stopped before completion."}{" "}
        {run.error_code && <Mono className="ml-1">{run.error_code}</Mono>}
      </InlineAlert>
    );
  }
  return null;
}

function RunFrame({ runId, children }: { runId: string; children: ReactNode }) {
  const { base, workspaceId } = useWorkspace();
  const { events, state } = useRunEvents(runId, workspaceId);
  const run = useRun(runId, state !== "live");
  const steps = useRunSteps(runId);
  const root = `${base}/runs/${runId}`;

  if (run.isPending) {
    return (
      <div
        className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8"
        role="status"
        aria-label="Loading run"
      >
        <Skeleton className="mb-3 h-4 w-40" />
        <Skeleton className="mb-6 h-7 w-[28rem] max-w-full" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (run.isError) return <ErrorState error={run.error} onRetry={() => run.refetch()} />;
  const r = run.data;
  const states = phaseStates(r.status, reachedPhase(steps.data ?? [], events));
  const active = ![
    "completed",
    "completed_without_pr",
    "failed",
    "cancelled",
    "timed_out",
    "rejected",
  ].includes(r.status);

  return (
    <RunContext.Provider value={{ run: r, events, stream: state, root }}>
      <div className="flex min-h-full flex-col">
        <div className="border-b border-border bg-bg-subtle">
          <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 pt-5 sm:px-6 lg:px-8">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <nav
                  aria-label="Breadcrumb"
                  className="mb-1.5 flex flex-wrap items-center gap-1 text-xs text-fg-muted"
                >
                  <Link href={`${base}/runs`} className="hover:text-fg">
                    Runs
                  </Link>
                  <span aria-hidden>/</span>
                  {r.task && (
                    <Link
                      href={`${base}/repositories/${r.task.repository_id}`}
                      className="hover:text-fg"
                    >
                      {r.task.repository_full_name}
                    </Link>
                  )}
                </nav>
                <h1 className="text-lg font-semibold tracking-tight text-fg">
                  {r.task ? (
                    <Link href={`${base}/tasks/${r.task.id}`} className="hover:underline">
                      {r.task.title}
                    </Link>
                  ) : (
                    "Run"
                  )}
                  <span className="ml-2 font-mono text-sm font-normal text-fg-subtle">
                    #{r.run_number}
                  </span>
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <RunStatusBadge status={r.status} size="md" />
                  <ModeBadge mode={r.mode} provider={r.provider} model={r.model} />
                  {r.base_branch && <Badge>base: {r.base_branch}</Badge>}
                  <span className="text-xs text-fg-muted">
                    started {formatRelative(r.started_at ?? r.created_at)}
                    {r.started_at && (
                      <>
                        {" · "}
                        <Elapsed startedAt={r.started_at} endedAt={r.ended_at} />
                      </>
                    )}
                  </span>
                  <StreamIndicator state={state} active={active} />
                </div>
              </div>
              <RunActions run={r} />
            </div>
            <RunStepper states={states} />
            <DecisionBanner run={r} root={root} />
            <NavTabs
              label="Run sections"
              className="border-b-0"
              tabs={[
                { href: root, label: "Timeline", icon: <Waypoints />, exact: true },
                {
                  href: `${root}/plan`,
                  label: "Plan",
                  icon: <ListChecks />,
                  badge:
                    r.status === "awaiting_plan_approval" ? (
                      <span
                        className="size-1.5 rounded-full bg-warning"
                        aria-label="needs decision"
                      />
                    ) : null,
                },
                { href: `${root}/changes`, label: "Changes", icon: <FileDiff /> },
                { href: `${root}/verification`, label: "Verification", icon: <FlaskConical /> },
                { href: `${root}/review`, label: "Review", icon: <ShieldCheck /> },
                {
                  href: `${root}/pull-request`,
                  label: "Pull request",
                  icon: <GitPullRequest />,
                  badge:
                    r.status === "awaiting_pr_approval" && !r.pull_request ? (
                      <span
                        className="size-1.5 rounded-full bg-warning"
                        aria-label="needs decision"
                      />
                    ) : null,
                },
              ]}
            />
          </div>
        </div>
        <div className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </div>
      </div>
    </RunContext.Provider>
  );
}

export function RunLayout({ children }: { children: ReactNode }) {
  const { runId } = useParams<{ runId: string }>();
  // Keyed so that the event stream and its local state reset per run.
  return (
    <RunFrame key={runId} runId={runId}>
      {children}
    </RunFrame>
  );
}

export function useRunQueryKey() {
  const { workspaceId } = useWorkspace();
  return (runId: string) => qk.run(workspaceId, runId);
}
