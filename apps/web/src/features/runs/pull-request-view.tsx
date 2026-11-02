"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Loader2,
  XCircle,
} from "lucide-react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { GitHubMark } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Card, CardBody, CardHeader, Mono } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { EmptyState, InlineAlert } from "@/components/ui/states";
import { createIdempotencyKey } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { qk, useRunDiff, useRunPlan, useRunReview, useRunVerification } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type { ApprovalDecision, WorkflowRun } from "@/lib/api/types";
import { applyServerErrors, notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { cn } from "@/lib/utils/cn";
import { formatRelative } from "@/lib/utils/format";
import { buildPrBody, gateAllows, prGateChecks, type GateCheck } from "./pr-gate";
import { useRunContext } from "./run-context";

export const prSchema = z.object({
  title: z
    .string()
    .trim()
    .min(5, "Title must be at least 5 characters")
    .max(256, "Title must be at most 256 characters"),
  body: z
    .string()
    .trim()
    .min(10, "Describe the change and its evidence")
    .max(60000, "The description is too long"),
  base_branch: z
    .string()
    .trim()
    .min(1, "Base branch is required")
    .regex(/^[A-Za-z0-9._/-]+$/, "Use a valid branch name")
    .refine((b) => !b.includes(".."), "Use a valid branch name"),
});
type PrValues = z.infer<typeof prSchema>;

function GateList({ checks }: { checks: GateCheck[] }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {checks.map((c) => (
        <li key={c.id} className="flex items-start gap-2.5 text-sm">
          {c.status === "pass" ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="passed" />
          ) : c.status === "fail" ? (
            <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-label="failed" />
          ) : c.status === "warn" ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-label="warning" />
          ) : (
            <Loader2
              className="mt-0.5 size-4 shrink-0 animate-spin text-fg-subtle"
              aria-label="loading"
            />
          )}
          <span>
            <span className="block text-fg">{c.label}</span>
            <span className="block text-xs text-fg-muted">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function PrCreated({ run }: { run: WorkflowRun }) {
  const pr = run.pull_request!;
  return (
    <Card className="max-w-2xl border-success-border">
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-success-soft text-success">
            <GitPullRequest className="size-5" />
          </span>
          <div>
            <p className="text-base font-semibold text-fg">Pull request #{pr.pr_number} opened</p>
            <p className="text-xs text-fg-muted">
              {formatRelative(pr.created_at)} · Anvaya does not merge — reviewers on GitHub decide.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-fg-muted">
          <GitBranch className="size-3.5" />
          <span className="text-fg">{pr.head_branch}</span> →{" "}
          <span className="text-fg">{pr.base_branch}</span>
        </div>
        <Button asChild variant="primary" className="self-start">
          <a href={pr.pr_url} target="_blank" rel="noreferrer noopener">
            <GitHubMark /> Open on GitHub <ExternalLink />
          </a>
        </Button>
      </CardBody>
    </Card>
  );
}

function PrComposer({ run, defaultBody }: { run: WorkflowRun; defaultBody: string }) {
  const queryClient = useQueryClient();
  const { workspaceId } = useWorkspace();
  // One key per composer: retrying after a network failure can never open two PRs.
  const key = useRef(createIdempotencyKey());
  const form = useForm<PrValues>({
    resolver: zodResolver(prSchema),
    defaultValues: {
      title: run.task?.title ?? "",
      body: defaultBody,
      base_branch: run.base_branch ?? "main",
    },
  });
  const create = useMutation({
    mutationFn: (v: PrValues) => api.runs.createPullRequest(run.id, v, key.current),
    onSuccess: (pr) => {
      void queryClient.invalidateQueries({ queryKey: qk.run(workspaceId, run.id) });
      void queryClient.invalidateQueries({ queryKey: qk.runs(workspaceId) });
      toast.success(`Pull request #${pr.pr_number} opened`, {
        action: {
          label: "Open",
          onClick: () => window.open(pr.pr_url, "_blank", "noopener,noreferrer"),
        },
      });
    },
    onError: (e) => {
      // Validation errors need a corrected body → new key. Network errors keep the key.
      if (isApiError(e) && (e.isValidation || e.isConflict)) key.current = createIdempotencyKey();
      applyServerErrors(e, form.setError, ["title", "body", "base_branch"]);
    },
  });
  const errors = form.formState.errors;
  return (
    <Card>
      <CardHeader
        title="Compose pull request"
        description="Approval recorded. Review the description, then create the pull request on GitHub."
      />
      <CardBody>
        <form
          noValidate
          onSubmit={form.handleSubmit((v) => create.mutate(v))}
          className="flex flex-col gap-4"
        >
          <Field label="Title" required error={errors.title?.message}>
            <Input {...form.register("title")} />
          </Field>
          <Field label="Base branch" required error={errors.base_branch?.message}>
            <Input className="w-64 font-mono" {...form.register("base_branch")} />
          </Field>
          <Field
            label="Description"
            required
            hint="Markdown. Anvaya appends a verification and review evidence section when it opens the pull request."
            error={errors.body?.message}
          >
            <Textarea rows={16} className="font-mono text-xs" {...form.register("body")} />
          </Field>
          <Button type="submit" variant="primary" loading={create.isPending} className="self-start">
            <GitHubMark /> Create pull request
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function PullRequestView() {
  const { run, root } = useRunContext();
  const { can, workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const reachedReview = [
    "awaiting_pr_approval",
    "creating_pr",
    "completed",
    "completed_without_pr",
  ].includes(run.status);
  const plan = useRunPlan(run.id, reachedReview);
  const diff = useRunDiff(run.id, reachedReview);
  const verification = useRunVerification(run.id, reachedReview);
  const review = useRunReview(run.id, reachedReview);
  const [decision, setDecision] = useState<ApprovalDecision | null>(null);
  const [comment, setComment] = useState("");
  const decideKey = useRef(createIdempotencyKey());

  const decide = useMutation({
    mutationFn: async (d: ApprovalDecision) => {
      // The approval is bound to the exact patch the user reviewed (409 PATCH_CHANGED otherwise).
      const patchHash = diff.data?.patch_hash;
      if (!patchHash) throw new Error("Patch not loaded");
      await api.runs.decidePullRequest(
        run.id,
        {
          decision: d,
          patch_hash: patchHash,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        },
        decideKey.current,
      );
      return d;
    },
    onSuccess: (decided) => {
      void queryClient.invalidateQueries({ queryKey: qk.run(workspaceId, run.id) });
      void queryClient.invalidateQueries({ queryKey: qk.runs(workspaceId) });
      setDecision(null);
      toast.success(
        decided === "approved"
          ? "Pull request creation approved"
          : "Completed without a pull request",
      );
    },
    onError: (e) => {
      decideKey.current = createIdempotencyKey();
      if (isApiError(e) && (e.code === "PATCH_CHANGED" || e.code === "BLOCKING_FINDINGS")) {
        void queryClient.invalidateQueries({ queryKey: qk.runPart(workspaceId, run.id, "diff") });
        void queryClient.invalidateQueries({ queryKey: qk.runPart(workspaceId, run.id, "review") });
        setDecision(null);
      }
      notifyError(e, "Decision not recorded");
    },
  });

  if (run.pull_request) return <PrCreated run={run} />;
  if (run.status === "completed_without_pr") {
    return (
      <Card>
        <EmptyState
          icon={<GitPullRequest />}
          title="Completed without a pull request"
          description="A member declined to open a pull request for this change. The patch and evidence remain available on this run."
        />
      </Card>
    );
  }
  if (!reachedReview) {
    return (
      <Card>
        <EmptyState
          icon={<CircleDashed />}
          title="Not ready for a pull request"
          description="A pull request can be requested after verification and review finish. Anvaya never creates one without explicit human approval."
        />
      </Card>
    );
  }

  const checks = prGateChecks({
    run,
    plan: plan.data,
    diff: diff.data,
    verification: verification.data,
    review: review.data,
  });
  const allowed = gateAllows(checks);
  const approved = run.approvals?.some(
    (a) => a.approval_type === "pull_request" && a.decision === "approved",
  );
  const canDecide = can("approvals.decide");
  const defaultBody = buildPrBody({
    task: { title: run.task?.title ?? "Change" },
    plan: plan.data,
    diff: diff.data,
    verification: verification.data,
    review: review.data,
    runUrl: typeof window !== "undefined" ? `${window.location.origin}${root}` : undefined,
    includeEvidence: false,
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
      <div className="flex flex-col gap-6">
        {approved ? (
          plan.data && diff.data && verification.data && review.data ? (
            <PrComposer run={run} defaultBody={defaultBody} />
          ) : (
            <Card className="p-6 text-sm text-fg-muted">Loading evidence…</Card>
          )
        ) : (
          <Card className={cn(allowed ? "border-warning-border" : "border-danger-border")}>
            <CardHeader
              title="Approve pull-request creation"
              description="Your approval is bound to this exact patch. If it changes, approval is required again."
            />
            <CardBody className="flex flex-col gap-5">
              <GateList checks={checks} />
              {diff.data && (
                <p className="rounded-md bg-surface-sunken px-3 py-2 text-xs text-fg-muted">
                  Approving patch{" "}
                  <Mono className="text-fg">{diff.data.patch_hash.slice(0, 23)}</Mono> ·{" "}
                  {diff.data.changed_files.length} files
                </p>
              )}
              {canDecide ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    disabled={!allowed}
                    onClick={() => setDecision("approved")}
                  >
                    <CheckCircle2 /> Approve pull request
                  </Button>
                  <Button onClick={() => setDecision("rejected")}>Complete without PR</Button>
                </div>
              ) : (
                <InlineAlert tone="info" title="Waiting for approval">
                  A workspace member must approve pull-request creation.
                </InlineAlert>
              )}
              {canDecide && !allowed && (
                <p className="text-xs text-danger">
                  Resolve the failing checks above before approving. You can still complete without
                  a pull request.
                </p>
              )}
            </CardBody>
          </Card>
        )}
      </div>
      <aside className="flex flex-col gap-4">
        <Card>
          <CardBody className="flex flex-col gap-2 text-sm">
            <p className="font-medium text-fg">What happens next</p>
            <ol className="list-decimal pl-4 text-fg-muted">
              <li className={cn(approved && "text-fg")}>
                A member approves the reviewed patch
                {approved && (
                  <Badge tone="success" className="ml-1.5">
                    done
                  </Badge>
                )}
              </li>
              <li>Anvaya re-checks permissions and the patch hash</li>
              <li>A branch, commit, and pull request are created on GitHub</li>
              <li>Humans review and merge on GitHub</li>
            </ol>
          </CardBody>
        </Card>
      </aside>
      <ConfirmDialog
        open={decision !== null}
        onOpenChange={(o) => !o && setDecision(null)}
        title={
          decision === "approved"
            ? "Approve pull-request creation?"
            : "Complete without a pull request?"
        }
        description={
          decision === "approved"
            ? "This authorizes Anvaya to push a branch and open a pull request for the reviewed patch. It will not merge."
            : "The run ends without writing to GitHub. The patch and evidence stay on this run."
        }
        confirmLabel={decision === "approved" ? "Approve" : "Complete without PR"}
        confirmVariant={decision === "approved" ? "primary" : "secondary"}
        pending={decide.isPending}
        onConfirm={() => decision && decide.mutate(decision)}
      >
        <Field label="Comment (optional)">
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
