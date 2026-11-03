"use client";

import {
  Ban,
  ChevronDown,
  CircleCheck,
  CircleSlash,
  CircleX,
  FlaskConical,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { VerificationBadge } from "@/components/domain/badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, Mono, SkeletonRows } from "@/components/ui/misc";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { isApiError } from "@/lib/api/errors";
import { useRunVerification } from "@/lib/api/queries";
import type { VerificationReport, VerificationResult } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { formatDuration } from "@/lib/utils/format";
import { ImpactPanel } from "./impact-panel";
import { useRunContext } from "./run-context";

export function summarizeVerification(report: VerificationReport) {
  const failed = report.results.filter(
    (r) => r.status === "failed" || r.status === "timed_out" || r.status === "error",
  );
  const passed = report.results.filter((r) => r.status === "passed");
  const skipped = report.results.filter((r) => r.status === "skipped");
  return {
    failed,
    passed,
    skipped,
    unavailable: report.unavailable,
    allPassed: failed.length === 0 && passed.length > 0,
  };
}

function ResultRow({ result }: { result: VerificationResult }) {
  const failed = result.status !== "passed" && result.status !== "skipped";
  const [open, setOpen] = useState(failed);
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!result.output_excerpt}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <VerificationBadge status={result.status} />
        <Mono className="text-fg">{result.command_display}</Mono>
        <span className="text-2xs text-fg-subtle">{result.profile_id}</span>
        {result.test_selection && (
          <Badge tone="warning" title="Heuristic test selection narrowed this run">
            {result.test_selection.files.length} selected test file
            {result.test_selection.files.length === 1 ? "" : "s"} · heuristic
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-3 font-mono text-xs text-fg-muted tabular">
          <span>exit {result.exit_code ?? "—"}</span>
          <span>{formatDuration(result.duration_ms)}</span>
          {result.output_excerpt && (
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          )}
        </span>
      </button>
      {result.test_selection && (
        <p className="px-4 pb-2 text-xs text-fg-muted" data-testid="test-selection-note">
          Only {result.test_selection.files.join(", ")} ran ({result.test_selection.not_run} other
          test file{result.test_selection.not_run === 1 ? "" : "s"} did not). The selection is
          heuristic; this result covers only the files that ran.
        </p>
      )}
      {open && result.output_excerpt && (
        <div className="px-4 pb-3">
          <pre
            className={cn(
              "max-h-72 scrollbar-thin overflow-auto rounded-md border bg-surface-sunken p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg",
              failed ? "border-danger-border" : "border-border",
            )}
          >
            {result.output_excerpt}
          </pre>
          <p className="mt-1 text-2xs text-fg-subtle">
            Output is bounded and redacted. Full logs are available as run artifacts.
          </p>
        </div>
      )}
    </li>
  );
}

function Group({
  title,
  icon,
  items,
  tone,
}: {
  title: string;
  icon: ReactNode;
  items: VerificationResult[];
  tone: string;
}) {
  if (!items.length) return null;
  return (
    <Card className="overflow-hidden">
      <div
        className={cn(
          "flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold [&_svg]:size-4",
          tone,
        )}
      >
        {icon} {title} <span className="font-normal text-fg-muted">· {items.length}</span>
      </div>
      <ul>
        {items.map((r) => (
          <ResultRow key={r.id} result={r} />
        ))}
      </ul>
    </Card>
  );
}

export function VerificationView() {
  const { run } = useRunContext();
  const report = useRunVerification(run.id);
  if (report.isPending) return <SkeletonRows rows={6} />;
  if (report.isError) {
    if (isApiError(report.error) && report.error.isNotFound) {
      return (
        <div className="flex flex-col gap-4">
          <Card>
            <EmptyState
              icon={<FlaskConical />}
              title="No verification yet"
              description="After the patch is applied in an isolated sandbox, server-defined test, lint, and build profiles run here. Only their exit codes decide pass or fail."
            />
          </Card>
          {!run.plan_only && <ImpactPanel />}
        </div>
      );
    }
    return <ErrorState error={report.error} onRetry={() => report.refetch()} />;
  }
  const s = summarizeVerification(report.data);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          {
            label: "Passed",
            value: s.passed.length,
            icon: <CircleCheck className="text-success" />,
          },
          { label: "Failed", value: s.failed.length, icon: <CircleX className="text-danger" /> },
          {
            label: "Skipped",
            value: s.skipped.length,
            icon: <CircleSlash className="text-fg-subtle" />,
          },
          {
            label: "Unavailable",
            value: s.unavailable.length,
            icon: <Ban className="text-fg-subtle" />,
          },
        ].map((m) => (
          <Card key={m.label} className="flex items-center gap-3 p-3.5 [&_svg]:size-5">
            {m.icon}
            <div>
              <p className="text-lg leading-none font-semibold text-fg tabular">{m.value}</p>
              <p className="mt-1 text-xs text-fg-muted">{m.label}</p>
            </div>
          </Card>
        ))}
      </div>
      <p className="flex items-center gap-2 text-xs text-fg-muted">
        <TerminalSquare className="size-3.5" /> Results come from real exit codes in the sandbox.
        Models cannot set pass/fail.
      </p>

      <Group title="Failed" icon={<CircleX />} items={s.failed} tone="text-danger" />
      <ImpactPanel compact />
      {report.data.ai_summary && (
        <InlineAlert
          tone="ai"
          icon={<Sparkles />}
          title={
            <span className="flex items-center gap-2">
              AI explanation of failures <Badge tone="ai">Not a verdict</Badge>
            </span>
          }
        >
          {report.data.ai_summary}
        </InlineAlert>
      )}
      <Group title="Passed" icon={<CircleCheck />} items={s.passed} tone="text-success" />
      <Group title="Skipped" icon={<CircleSlash />} items={s.skipped} tone="text-fg-muted" />
      {s.unavailable.length > 0 && (
        <Card>
          <CardHeader
            title={`Unavailable · ${s.unavailable.length}`}
            description="Configured checks that couldn't run for this repository."
          />
          <ul className="divide-y divide-border">
            {s.unavailable.map((u) => (
              <li key={u.profile_id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <Ban className="size-4 text-fg-subtle" />
                <Mono className="text-fg">{u.profile_id}</Mono>
                <span className="text-fg-muted">{u.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
