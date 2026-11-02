"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCheck, FileCode2, ShieldAlert, ShieldCheck, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AiBadge, SeverityBadge, SourceBadge } from "@/components/domain/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Card, Mono, SkeletonRows } from "@/components/ui/misc";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/overlays";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { isApiError } from "@/lib/api/errors";
import { qk, useRunReview } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type { FindingDispositionRequest, ReviewFinding } from "@/lib/api/types";
import {
  findingSourceMeta,
  isTerminalRun,
  SEVERITY_ORDER,
  severityMeta,
} from "@/lib/domain/status";
import { notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { cn } from "@/lib/utils/cn";
import { lineRange } from "@/lib/utils/format";
import { useRunContext } from "./run-context";

export function openBlockingFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.filter((f) => f.status === "open" && severityMeta(f.severity).blocking);
}

type SourceFilter = "all" | "ai" | "deterministic";

const STATUS_LABEL = {
  open: "Open",
  accepted: "Accepted",
  dismissed: "Dismissed",
  fixed: "Marked fixed",
} as const;

function DismissDialog({ finding, onClose }: { finding: ReviewFinding; onClose: () => void }) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dispose = useDisposition(finding, onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && !dispose.isPending && onClose()}>
      <DialogContent
        size="sm"
        title="Dismiss finding"
        description="Dismissals are recorded in the audit trail with your reason."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant="primary"
              loading={dispose.isPending}
              onClick={() => {
                if (!comment.trim()) return setError("Explain why this finding doesn't apply");
                dispose.mutate({ status: "dismissed", comment: comment.trim() });
              }}
            >
              Dismiss finding
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm font-medium text-fg">{finding.title}</p>
        <Field label="Reason" required error={error ?? undefined}>
          <Textarea
            rows={3}
            value={comment}
            onChange={(e) => (setComment(e.target.value), setError(null))}
            placeholder="Only one TokenStore exists per process in this service."
          />
        </Field>
      </DialogContent>
    </Dialog>
  );
}

function useDisposition(finding: ReviewFinding, onDone?: () => void) {
  const { run } = useRunContext();
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: FindingDispositionRequest) =>
      api.runs.disposeFinding(run.id, finding.id, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        qk.runPart(workspaceId, run.id, "review"),
        (prev: { findings: ReviewFinding[] } | undefined) =>
          prev
            ? {
                ...prev,
                findings: prev.findings.map((f) =>
                  f.id === updated.id ? { ...f, status: updated.status } : f,
                ),
              }
            : prev,
      );
      toast.success(`Finding ${STATUS_LABEL[updated.status].toLowerCase()}`);
      onDone?.();
    },
    onError: (e) => notifyError(e),
  });
}

function FindingCard({ finding, editable }: { finding: ReviewFinding; editable: boolean }) {
  const { root } = useRunContext();
  const [dismissing, setDismissing] = useState(false);
  const dispose = useDisposition(finding);
  const ai = !findingSourceMeta(finding.source).deterministic;
  const open = finding.status === "open";
  return (
    <li>
      <Card className={cn("overflow-hidden", ai && "border-ai-border", !open && "opacity-75")}>
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <SeverityBadge severity={finding.severity} />
          <SourceBadge source={finding.source} />
          {finding.confidence && <Badge>{finding.confidence} confidence</Badge>}
          {!open && (
            <Badge tone={finding.status === "dismissed" ? "neutral" : "success"}>
              {STATUS_LABEL[finding.status]}
            </Badge>
          )}
        </div>
        <div className="px-4 py-3">
          <h3 className="text-sm font-semibold text-fg">{finding.title}</h3>
          {finding.file_path && (
            <Link
              href={`${root}/changes`}
              className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-link hover:underline"
            >
              <FileCode2 className="size-3" />
              {finding.file_path}
              {finding.start_line
                ? ` ${lineRange(finding.start_line, finding.end_line ?? finding.start_line)}`
                : ""}
            </Link>
          )}
          <p className="mt-2 text-sm text-fg-muted">{finding.description}</p>
          {(finding.evidence.items?.length ||
            finding.evidence.rationale ||
            finding.evidence.rule_id) && (
            <div className="mt-3 rounded-md bg-surface-sunken px-3 py-2 text-xs">
              {finding.evidence.rule_id && (
                <p className="text-fg-muted">
                  Rule <Mono className="text-fg">{finding.evidence.rule_id}</Mono>
                </p>
              )}
              {finding.evidence.rationale && (
                <p className="text-fg">{finding.evidence.rationale}</p>
              )}
              {!!finding.evidence.items?.length && (
                <ul className="mt-1 list-disc pl-4 text-fg-muted">
                  {finding.evidence.items.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {finding.evidence.suggested_action && (
            <p className="mt-2 text-xs text-fg">
              <span className="font-medium">Suggested: </span>
              {finding.evidence.suggested_action}
            </p>
          )}
        </div>
        {editable && open && (
          <div className="flex flex-wrap gap-2 border-t border-border bg-bg-subtle px-4 py-2">
            <Button
              size="xs"
              onClick={() => dispose.mutate({ status: "accepted" })}
              disabled={dispose.isPending}
            >
              <Check /> Accept risk
            </Button>
            <Button
              size="xs"
              onClick={() => dispose.mutate({ status: "fixed" })}
              disabled={dispose.isPending}
            >
              <CheckCheck /> Mark fixed
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setDismissing(true)}
              disabled={dispose.isPending}
            >
              <X /> Dismiss…
            </Button>
          </div>
        )}
      </Card>
      {dismissing && <DismissDialog finding={finding} onClose={() => setDismissing(false)} />}
    </li>
  );
}

export function ReviewView() {
  const { run } = useRunContext();
  const { can } = useWorkspace();
  const review = useRunReview(run.id);
  const [filter, setFilter] = useState<SourceFilter>("all");

  if (review.isPending) return <SkeletonRows rows={6} />;
  if (review.isError) {
    if (isApiError(review.error) && review.error.isNotFound) {
      return (
        <Card>
          <EmptyState
            icon={<ShieldCheck />}
            title="Not reviewed yet"
            description="The reviewer inspects the actual diff and verification evidence. Deterministic scanners run alongside it."
          />
        </Card>
      );
    }
    return <ErrorState error={review.error} onRetry={() => review.refetch()} />;
  }
  const findings = [...review.data.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const shown = findings.filter(
    (f) => filter === "all" || (filter === "ai") === !findingSourceMeta(f.source).deterministic,
  );
  const blocking = openBlockingFindings(findings);
  const editable = can("approvals.decide") && !isTerminalRun(run.status);
  const counts = {
    all: findings.length,
    ai: findings.filter((f) => f.source === "ai_review").length,
    deterministic: findings.filter((f) => f.source !== "ai_review").length,
  };

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {review.data.summary && (
        <InlineAlert
          tone="ai"
          icon={<Sparkles />}
          title={
            <span className="flex items-center gap-2">
              Reviewer summary <AiBadge />
            </span>
          }
        >
          {review.data.summary}
        </InlineAlert>
      )}
      {blocking.length > 0 ? (
        <InlineAlert
          tone="danger"
          icon={<ShieldAlert />}
          title={`${blocking.length} blocking finding${blocking.length > 1 ? "s" : ""}`}
        >
          High and critical findings must be accepted, fixed, or dismissed with a reason before
          pull-request approval.
        </InlineAlert>
      ) : (
        findings.length > 0 && (
          <InlineAlert tone="success" icon={<ShieldCheck />} title="No blocking findings">
            Remaining findings are informational or already resolved.
          </InlineAlert>
        )
      )}
      <div
        role="group"
        aria-label="Filter findings by source"
        className="flex gap-1 self-start rounded-lg border border-border bg-surface p-0.5 shadow-xs"
      >
        {(["all", "ai", "deterministic"] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              "h-7 rounded-md px-2.5 text-sm font-medium",
              filter === f ? "bg-surface-selected text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {f === "all" ? "All" : f === "ai" ? "AI review" : "Deterministic tools"}{" "}
            <span className="text-fg-subtle">{counts[f]}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <Card>
          <EmptyState
            compact
            icon={<ShieldCheck />}
            title="No findings"
            description="Nothing reported for this filter."
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((f) => (
            <FindingCard key={f.id} finding={f} editable={editable} />
          ))}
        </ul>
      )}
    </div>
  );
}
