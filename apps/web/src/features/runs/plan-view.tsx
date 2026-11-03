"use client";

import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  FileCode2,
  HelpCircle,
  Lightbulb,
  ListChecks,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { AiBadge } from "@/components/domain/badges";
import { SectionTitle } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Card, CardBody, CardHeader, Mono, SkeletonRows } from "@/components/ui/misc";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/overlays";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { isApiError } from "@/lib/api/errors";
import { createIdempotencyKey } from "@/lib/api/client";
import { qk, useMembers, useRunPlan } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type {
  ApprovalDecision,
  EngineeringPlan,
  EvidenceRef,
  Investigation,
  RunPlan,
} from "@/lib/api/types";
import { codeHref } from "@/lib/code";
import { applyServerErrors, notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { cn } from "@/lib/utils/cn";
import { formatRelative, lineRange } from "@/lib/utils/format";
import {
  formToPlan,
  keepMigration,
  planFormSchema,
  planToForm,
  undeclaredStepFiles,
  type PlanFormValues,
} from "./plan-schema";
import { useRunContext } from "./run-context";

function EvidenceLink({ evidence, repoId }: { evidence: EvidenceRef; repoId: string }) {
  const { base } = useWorkspace();
  return (
    <Link
      href={codeHref(
        base,
        repoId,
        evidence.path,
        { start: evidence.start_line, end: evidence.end_line },
        evidence.commit_sha,
      )}
      className="inline-flex items-center gap-1 rounded-sm border border-highlight-border bg-highlight px-1.5 py-0.5 font-mono text-2xs text-accent-fg hover:underline"
    >
      <FileCode2 className="size-3" />
      {evidence.path}:{lineRange(evidence.start_line, evidence.end_line).slice(1)}
    </Link>
  );
}

function List({
  items,
  icon,
  empty = "None",
}: {
  items: string[];
  icon?: ReactNode;
  empty?: string;
}) {
  if (!items.length) return <p className="text-sm text-fg-subtle">{empty}</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => (
        <li
          key={item}
          className="flex gap-2 text-sm text-fg [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0"
        >
          {icon}
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function InvestigationCard({
  investigation,
  repoId,
}: {
  investigation: Investigation;
  repoId: string;
}) {
  return (
    <Card>
      <CardHeader
        title="Investigation"
        description="What the investigator examined and found."
        actions={<AiBadge />}
      />
      <CardBody className="flex flex-col gap-5">
        <p className="text-sm text-fg">{investigation.summary}</p>
        <div className="flex flex-col gap-3">
          {investigation.findings.map((f, i) => (
            <div key={i} className="rounded-md border border-border p-3">
              <div className="flex items-start gap-2">
                <Badge tone={f.kind === "observed" ? "success" : "warning"}>
                  {f.kind === "observed" ? "Observed" : "Inferred"}
                </Badge>
                <p className="text-sm text-fg">{f.claim}</p>
              </div>
              {f.evidence.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {f.evidence.map((e) => (
                    <EvidenceLink key={`${e.path}:${e.start_line}`} evidence={e} repoId={repoId} />
                  ))}
                </div>
              ) : (f.unresolved_evidence ?? 0) > 0 ? (
                <p className="mt-2 text-xs text-fg-muted">
                  Cites {f.unresolved_evidence} retrieved{" "}
                  {f.unresolved_evidence === 1 ? "excerpt" : "excerpts"}; file locations aren’t
                  available for this run.
                </p>
              ) : (
                <p className="mt-2 text-xs text-warning">No evidence cited for this claim.</p>
              )}
            </div>
          ))}
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs font-semibold text-fg-muted">Hypotheses · unverified</h4>
            <List items={investigation.hypotheses} icon={<Lightbulb className="text-warning" />} />
          </div>
          <div>
            <h4 className="mb-2 text-xs font-semibold text-fg-muted">Unknowns</h4>
            <List
              items={investigation.unknowns}
              icon={<HelpCircle className="text-info" />}
              empty="No open questions."
            />
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/** Migration-plan section: affected areas with server-resolved evidence, prerequisites, rollback. */
function MigrationSectionView({ runPlan, repoId }: { runPlan: RunPlan; repoId: string }) {
  const m = runPlan.plan.migration;
  if (!m) return null;
  const evidence = new Map(runPlan.migration_evidence.map((e) => [e.id, e]));
  return (
    <Card data-testid="migration-plan">
      <CardHeader
        title="Migration details"
        description="Affected areas cite retrieved evidence; locations come from the run's own retrieval records."
      />
      <CardBody className="flex flex-col gap-5 text-sm">
        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Affected areas · {m.affected_areas.length}
          </h3>
          <ul className="flex flex-col gap-2">
            {m.affected_areas.map((a) => (
              <li key={a.area} className="rounded-md border border-border p-3">
                <p className="font-medium text-fg">{a.area}</p>
                <p className="text-fg-muted">{a.description}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {a.evidence_ids.map((id) => {
                    const e = evidence.get(id);
                    return e ? <EvidenceLink key={id} evidence={e} repoId={repoId} /> : null;
                  })}
                  {a.evidence_ids.every((id) => !evidence.has(id)) && (
                    <span className="text-xs text-warning">
                      No resolved evidence for this area.
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
              Prerequisites
            </h3>
            <List items={m.prerequisites} icon={<ListChecks className="text-fg-subtle" />} />
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
              Rollback strategy
            </h3>
            <List items={m.rollback_strategy} icon={<ShieldAlert className="text-warning" />} />
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function PlanDocument({ plan }: { plan: EngineeringPlan }) {
  const undeclared = undeclaredStepFiles(plan);
  const rollback = new Map(
    (plan.migration?.step_rollback ?? []).map((r) => [r.step_id, r.rollback]),
  );
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Objective</h3>
        <p className="mt-1.5 text-base font-medium text-fg">{plan.objective}</p>
      </div>
      <div>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">Steps</h3>
        <ol className="flex flex-col gap-2.5">
          {plan.steps.map((s, i) => (
            <li key={s.id} className="flex gap-3 rounded-md border border-border p-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-fg">{s.description}</p>
                {s.files.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {s.files.map((f) => (
                      <Mono key={f} className="rounded-xs bg-surface-sunken px-1.5 py-0.5 text-fg">
                        {f}
                      </Mono>
                    ))}
                  </div>
                )}
                {s.verification.length > 0 && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-fg-muted">
                    <Check className="mt-0.5 size-3 shrink-0 text-success" />{" "}
                    {s.verification.join(" · ")}
                  </p>
                )}
                {rollback.has(s.id) && (
                  <p className="mt-1 text-xs text-fg-muted">
                    <span className="font-semibold">Rollback:</span> {rollback.get(s.id)}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Files in scope · {plan.files_to_modify.length}
          </h3>
          <ul className="flex flex-col gap-1">
            {plan.files_to_modify.map((f) => (
              <li key={f}>
                <Mono className="text-fg">{f}</Mono>
              </li>
            ))}
          </ul>
          {undeclared.length > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> Steps reference files not in
              scope: {undeclared.join(", ")}
            </p>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Tests
          </h3>
          <List items={plan.tests} icon={<ListChecks className="text-fg-subtle" />} />
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Risks
          </h3>
          <List items={plan.risks} icon={<ShieldAlert className="text-warning" />} />
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Assumptions
          </h3>
          <List items={plan.assumptions} icon={<Lightbulb className="text-fg-subtle" />} />
        </div>
        <div className="md:col-span-2">
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Out of scope
          </h3>
          <List items={plan.out_of_scope} icon={<X className="text-fg-subtle" />} />
        </div>
      </div>
    </div>
  );
}

function PlanEditor({ runPlan, onDone }: { runPlan: RunPlan; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { workspaceId } = useWorkspace();
  const form = useForm<PlanFormValues>({
    resolver: zodResolver(planFormSchema),
    defaultValues: planToForm(runPlan.plan),
  });
  const steps = useFieldArray({ control: form.control, name: "steps" });
  const errors = form.formState.errors;
  const save = useMutation({
    mutationFn: (v: PlanFormValues) =>
      api.runs.updatePlan(
        runPlan.run_id,
        keepMigration(formToPlan(v), runPlan.plan),
        runPlan.plan_hash,
      ),
    onSuccess: (revision) => {
      // The response is the new revision only: keep the investigation, then refetch.
      const key = qk.runPart(workspaceId, runPlan.run_id, "plan");
      queryClient.setQueryData(key, {
        ...runPlan,
        plan: revision.plan,
        plan_hash: revision.plan_hash,
        version: revision.version,
        source: revision.source,
        state: "edited" as const,
        approval: null,
      });
      void queryClient.invalidateQueries({ queryKey: key });
      toast.success(`Plan saved as version ${revision.version}`);
      onDone();
    },
    onError: (e) => {
      if (isApiError(e) && e.code === "PLAN_CHANGED") {
        // Someone else changed the plan: reload it rather than overwrite their edit.
        void queryClient.invalidateQueries({
          queryKey: qk.runPart(workspaceId, runPlan.run_id, "plan"),
        });
        toast.error("The plan changed while you were editing", {
          description: "The latest version was loaded. Re-apply your edits.",
        });
        onDone();
        return;
      }
      applyServerErrors(e, form.setError, ["objective", "files_to_modify", "steps"]);
    },
  });
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((v) => save.mutate(v))}
      className="flex flex-col gap-5"
      aria-label="Edit plan"
    >
      <Field label="Objective" required error={errors.objective?.message}>
        <Input {...form.register("objective")} />
      </Field>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-fg">Steps</legend>
        {steps.fields.map((field, i) => (
          <div key={field.id} className="flex flex-col gap-3 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-fg-muted">Step {i + 1}</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => steps.remove(i)}
                disabled={steps.fields.length === 1}
                aria-label={`Remove step ${i + 1}`}
              >
                <Trash2 /> Remove
              </Button>
            </div>
            <Field label="Description" required error={errors.steps?.[i]?.description?.message}>
              <Textarea rows={2} {...form.register(`steps.${i}.description`)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Files"
                hint="One path per line"
                error={errors.steps?.[i]?.files?.message}
              >
                <Textarea
                  rows={2}
                  className="font-mono text-xs"
                  {...form.register(`steps.${i}.files`)}
                />
              </Field>
              <Field label="Verification" hint="One check per line">
                <Textarea rows={2} {...form.register(`steps.${i}.verification`)} />
              </Field>
            </div>
          </div>
        ))}
        {errors.steps?.root?.message && (
          <p className="text-xs text-danger">{errors.steps.root.message}</p>
        )}
        <Button
          size="sm"
          className="self-start"
          onClick={() =>
            steps.append({
              id: `step-${steps.fields.length + 1}`,
              description: "",
              files: "",
              verification: "",
            })
          }
        >
          <Plus /> Add step
        </Button>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Files in scope"
          required
          hint="One path per line. The developer can only change these."
          error={errors.files_to_modify?.message}
        >
          <Textarea rows={4} className="font-mono text-xs" {...form.register("files_to_modify")} />
        </Field>
        <Field label="Tests" hint="One per line">
          <Textarea rows={4} {...form.register("tests")} />
        </Field>
        <Field label="Risks" hint="One per line">
          <Textarea rows={3} {...form.register("risks")} />
        </Field>
        <Field label="Assumptions" hint="One per line">
          <Textarea rows={3} {...form.register("assumptions")} />
        </Field>
        <Field label="Out of scope" hint="One per line" className="sm:col-span-2">
          <Textarea rows={2} {...form.register("out_of_scope")} />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={save.isPending}>
          Discard changes
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          Save plan
        </Button>
      </div>
    </form>
  );
}

function DecisionDialog({
  runPlan,
  decision,
  open,
  onOpenChange,
}: {
  runPlan: RunPlan;
  decision: ApprovalDecision;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { workspaceId } = useWorkspace();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const key = useRef(createIdempotencyKey());
  const decide = useMutation({
    mutationFn: () =>
      api.runs.decidePlan(
        runPlan.run_id,
        {
          decision,
          plan_hash: runPlan.plan_hash,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        },
        key.current,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.run(workspaceId, runPlan.run_id) });
      void queryClient.invalidateQueries({
        queryKey: qk.runPart(workspaceId, runPlan.run_id, "plan"),
      });
      void queryClient.invalidateQueries({ queryKey: qk.runs(workspaceId) });
      toast.success(decision === "approved" ? "Plan approved" : "Plan rejected", {
        description:
          decision === "approved"
            ? "Anvaya is preparing an isolated workspace."
            : "The run ended. You can start a new run with different guidance.",
      });
      onOpenChange(false);
    },
    onError: (e) => {
      key.current = createIdempotencyKey();
      if (isApiError(e) && e.code === "PLAN_CHANGED") {
        void queryClient.invalidateQueries({
          queryKey: qk.runPart(workspaceId, runPlan.run_id, "plan"),
        });
        toast.error("The plan changed before your decision", {
          description: "Review the latest version, then decide again.",
        });
        onOpenChange(false);
        return;
      }
      if (isApiError(e) && e.fieldErrors.comment) setError(e.fieldErrors.comment);
      else notifyError(e);
    },
  });
  const approving = decision === "approved";
  return (
    <Dialog open={open} onOpenChange={(o) => !decide.isPending && onOpenChange(o)}>
      <DialogContent
        size="md"
        title={approving ? "Approve this plan?" : "Reject this plan?"}
        description={
          approving
            ? "Anvaya will create a disposable workspace and implement only the files in scope. You'll review the result before any pull request."
            : "The run ends without modifying code. Explain why so the next run can do better."
        }
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost" disabled={decide.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant={approving ? "primary" : "danger"}
              loading={decide.isPending}
              onClick={() => {
                if (!approving && !comment.trim()) {
                  setError("Add a reason for rejecting");
                  return;
                }
                decide.mutate();
              }}
            >
              {approving ? "Approve plan" : "Reject plan"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="rounded-md bg-surface-sunken px-3 py-2 text-xs text-fg-muted">
            Deciding on plan version{" "}
            <span className="font-semibold text-fg">{runPlan.version}</span> ·{" "}
            <Mono>{runPlan.plan_hash.slice(0, 23)}</Mono>
          </p>
          <Field
            label={approving ? "Comment (optional)" : "Reason"}
            required={!approving}
            error={error ?? undefined}
          >
            <Textarea
              rows={3}
              value={comment}
              onChange={(e) => {
                setComment(e.target.value);
                setError(null);
              }}
              placeholder={
                approving
                  ? "Proceed with this implementation scope."
                  : "The fix should live in the HTTP client, not the token module."
              }
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PlanView() {
  const { run } = useRunContext();
  const { can } = useWorkspace();
  const members = useMembers();
  const memberName = (userId: string) => {
    const m = members.data?.find((x) => x.user.id === userId);
    return m ? (m.user.display_name ?? m.user.email) : "a member";
  };
  const plan = useRunPlan(run.id);
  const [editing, setEditing] = useState(false);
  const [decision, setDecision] = useState<ApprovalDecision | null>(null);
  const awaiting = run.status === "awaiting_plan_approval";
  const repoId = run.task?.repository_id ?? "";

  if (plan.isPending) return <SkeletonRows rows={8} />;
  if (plan.isError) {
    if (isApiError(plan.error) && plan.error.isNotFound) {
      return (
        <Card>
          <EmptyState
            icon={<ListChecks />}
            title="Plan not proposed yet"
            description={
              ["queued", "retrieving_context", "investigating", "planning"].includes(run.status)
                ? "The planner runs after the investigation. This page updates automatically."
                : "This run ended before a plan was proposed."
            }
          />
        </Card>
      );
    }
    return <ErrorState error={plan.error} onRetry={() => plan.refetch()} />;
  }
  const p = plan.data;
  const decidable = awaiting && can("approvals.decide");

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_400px]">
      <div className="flex flex-col gap-6">
        <Card className={cn(awaiting && "border-warning-border")}>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                Implementation plan
                <Badge
                  tone={
                    p.state === "approved"
                      ? "success"
                      : p.state === "rejected"
                        ? "danger"
                        : p.state === "edited"
                          ? "info"
                          : "neutral"
                  }
                >
                  {p.state === "edited" ? "Edited by a human" : p.state}
                </Badge>
              </span>
            }
            description={
              <>
                Version {p.version} · <Mono>{p.plan_hash.slice(0, 23)}</Mono> · updated{" "}
                {formatRelative(p.updated_at)}
              </>
            }
            actions={
              decidable && !editing ? (
                <Button size="sm" onClick={() => setEditing(true)}>
                  <Pencil /> Edit
                </Button>
              ) : (
                <AiBadge label={p.state === "edited" ? "AI draft, human-edited" : "AI-proposed"} />
              )
            }
          />
          <CardBody>
            {editing ? (
              <PlanEditor runPlan={p} onDone={() => setEditing(false)} />
            ) : (
              <PlanDocument plan={p.plan} />
            )}
          </CardBody>
        </Card>
        <MigrationSectionView runPlan={p} repoId={repoId} />
        {p.investigation && <InvestigationCard investigation={p.investigation} repoId={repoId} />}
      </div>
      <aside className="flex flex-col gap-4">
        <SectionTitle>Decision</SectionTitle>
        {p.state === "approved" || p.state === "rejected" ? (
          <InlineAlert
            tone={p.state === "approved" ? "success" : "danger"}
            icon={p.state === "approved" ? <Check /> : <X />}
            title={`Plan ${p.state}${p.approval ? ` by ${memberName(p.approval.user_id)}` : ""}`}
          >
            {p.approval?.comment ?? "No comment."}
          </InlineAlert>
        ) : awaiting ? (
          decidable ? (
            <Card className="border-warning-border">
              <CardBody className="flex flex-col gap-3">
                {p.plan_only ? (
                  <p className="text-sm text-fg" data-testid="plan-only-note">
                    This is a plan-only run. Approving records this plan as the deliverable and ends
                    the run: no workspace is created and no code is changed or executed.
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-fg">
                      Approving lets Anvaya modify only the {p.plan.files_to_modify.length} files in
                      scope, inside a disposable sandbox.
                    </p>
                    <p className="text-xs text-fg-muted">
                      No branch, commit, or pull request is created without a second approval.
                    </p>
                  </>
                )}
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={() => setDecision("approved")}
                    disabled={editing}
                  >
                    <Check /> Approve plan
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => setDecision("rejected")}
                    disabled={editing}
                  >
                    <X /> Reject
                  </Button>
                </div>
                {editing && (
                  <p className="text-xs text-fg-muted">
                    Save or discard your edits before deciding.
                  </p>
                )}
              </CardBody>
            </Card>
          ) : (
            <InlineAlert tone="info" title="Waiting for approval">
              A workspace member must approve this plan. Your role is read-only.
            </InlineAlert>
          )
        ) : (
          <p className="text-sm text-fg-muted">This plan is no longer awaiting a decision.</p>
        )}
      </aside>
      {decision && (
        <DecisionDialog
          key={decision}
          runPlan={p}
          decision={decision}
          open
          onOpenChange={(o) => !o && setDecision(null)}
        />
      )}
    </div>
  );
}
