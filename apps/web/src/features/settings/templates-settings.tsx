"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, FileStack, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Card, CardBody, CardHeader, Mono, SkeletonRows } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { createIdempotencyKey } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { useTemplates } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import {
  VERIFICATION_PROFILE_IDS,
  type CreateTemplateRequest,
  type RunBudgets,
  type TemplateWorkflow,
  type WorkflowTemplate,
} from "@/lib/api/types";
import { notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";

const BUDGET_FIELDS: { key: keyof RunBudgets; label: string }[] = [
  { key: "max_changed_files", label: "Max changed files" },
  { key: "max_repair_attempts", label: "Max repair attempts" },
  { key: "max_steps", label: "Max agent steps" },
  { key: "max_duration_seconds", label: "Max duration (seconds)" },
];

export interface TemplateDraft {
  key: string;
  name: string;
  description: string;
  workflow: TemplateWorkflow;
  title_prefix: string;
  description_template: string;
  labels: string;
  guidance: string;
  restrict_profiles: boolean;
  profiles: string[];
  budget: Partial<Record<keyof RunBudgets, string>>;
}

export const EMPTY_DRAFT: TemplateDraft = {
  key: "",
  name: "",
  description: "",
  workflow: "change",
  title_prefix: "",
  description_template: "",
  labels: "",
  guidance: "",
  restrict_profiles: false,
  profiles: [],
  budget: {},
};

/** Builds the strict request body from the form; returns field errors instead when invalid. */
export function draftToRequest(
  d: TemplateDraft,
): { ok: true; body: CreateTemplateRequest } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(d.key))
    errors.key = "2–40 lowercase letters, digits or underscores, starting with a letter";
  if (!d.name.trim()) errors.name = "Name is required";
  const guidance = d.guidance
    .split("\n")
    .map((g) => g.trim())
    .filter(Boolean);
  if (guidance.length > 8) errors.guidance = "At most 8 rules";
  if (guidance.some((g) => g.length > 300))
    errors.guidance = "Each rule must be at most 300 characters";
  const budget: Partial<RunBudgets> = {};
  for (const f of BUDGET_FIELDS) {
    const raw = d.budget[f.key]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) errors[`budget.${f.key}`] = "Whole number";
    else budget[f.key] = n;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      key: d.key,
      name: d.name.trim(),
      description: d.description.trim(),
      workflow: d.workflow,
      task_defaults: {
        title_prefix: d.title_prefix || null,
        description_template: d.description_template || null,
        labels: d.labels
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 10),
      },
      budget,
      allowed_profiles: d.restrict_profiles ? d.profiles : null,
      planning_guidance: guidance,
    },
  };
}

function TemplateCard({
  t,
  editable,
  onArchive,
}: {
  t: WorkflowTemplate;
  editable: boolean;
  onArchive?: (t: WorkflowTemplate) => void;
}) {
  const budget = Object.entries(t.budget);
  return (
    <li className="rounded-md border border-border p-3 text-sm" data-testid={`template-${t.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{t.name}</span>
        <Mono className="text-xs text-fg-muted">{t.key}</Mono>
        <Badge tone={t.source === "builtin" ? "neutral" : "info"}>
          {t.source === "builtin" ? "Built-in" : `Workspace · v${t.version}`}
        </Badge>
        {t.plan_only && <Badge tone="warning">Plan only</Badge>}
        {t.status === "archived" && <Badge tone="neutral">Archived</Badge>}
        {editable && t.source === "workspace" && t.status === "active" && onArchive && (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => onArchive(t)}>
            <Archive /> Archive
          </Button>
        )}
      </div>
      {t.description && <p className="mt-1 text-fg-muted">{t.description}</p>}
      <dl className="mt-2 grid gap-1 text-xs text-fg-muted sm:grid-cols-2">
        <div>
          <dt className="inline font-semibold">Budget ceilings: </dt>
          <dd className="inline">
            {budget.length
              ? budget
                  .map(([k, v]) => `${k.replace(/^max_/, "").replace(/_/g, " ")} ≤ ${v}`)
                  .join(", ")
              : "workspace limits"}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold">Verification: </dt>
          <dd className="inline">
            {t.allowed_profiles === null
              ? "all applicable profiles"
              : t.allowed_profiles.length
                ? t.allowed_profiles.join(", ")
                : "none (nothing is executed)"}
          </dd>
        </div>
      </dl>
      {t.planning_guidance.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-fg-muted">
          {t.planning_guidance.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function CreateTemplateForm({ onDone }: { onDone: () => void }) {
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const key = useRef(createIdempotencyKey());
  const set = <K extends keyof TemplateDraft>(k: K, v: TemplateDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const create = useMutation({
    mutationFn: (body: CreateTemplateRequest) =>
      api.templates.create(workspaceId, body, key.current),
    onSuccess: (t) => {
      key.current = createIdempotencyKey();
      void queryClient.invalidateQueries({ queryKey: ["ws", workspaceId, "templates"] });
      toast.success(`Template "${t.name}" created`, { description: "Recorded in the audit log." });
      onDone();
    },
    onError: (e) => {
      key.current = createIdempotencyKey();
      if (isApiError(e) && e.code === "TEMPLATE_KEY_TAKEN") {
        setErrors({ key: "A template with this key already exists" });
        return;
      }
      notifyError(e, "Template not created");
    },
  });
  return (
    <form
      noValidate
      aria-label="New template"
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const r = draftToRequest(draft);
        if (!r.ok) {
          setErrors(r.errors);
          return;
        }
        setErrors({});
        create.mutate(r.body);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required error={errors.name}>
          <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Key" required error={errors.key} hint="Used in the API, e.g. security_fix">
          <Input
            value={draft.key}
            className="font-mono"
            onChange={(e) => set("key", e.target.value)}
          />
        </Field>
        <Field label="Workflow">
          <Select
            value={draft.workflow}
            onChange={(e) => set("workflow", e.target.value as TemplateWorkflow)}
          >
            <option value="change">Change (plan → patch → verify → review)</option>
            <option value="migration_plan">Migration plan (plan only, nothing executed)</option>
          </Select>
        </Field>
        <Field label="Description">
          <Input value={draft.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <Field label="Title prefix" hint="Prefilled in the task title">
          <Input value={draft.title_prefix} onChange={(e) => set("title_prefix", e.target.value)} />
        </Field>
        <Field label="Labels" hint="Comma-separated">
          <Input value={draft.labels} onChange={(e) => set("labels", e.target.value)} />
        </Field>
      </div>
      <Field label="Description scaffold" hint="Prefilled when the task description is empty">
        <Textarea
          rows={3}
          value={draft.description_template}
          onChange={(e) => set("description_template", e.target.value)}
        />
      </Field>
      <Field
        label="Planning guidance"
        error={errors.guidance}
        hint="One rule per line (up to 8). Sent to the planner as workspace policy; it never overrides Anvaya's safety rules."
      >
        <Textarea
          rows={4}
          value={draft.guidance}
          onChange={(e) => set("guidance", e.target.value)}
        />
      </Field>
      <fieldset className="grid gap-4 sm:grid-cols-4">
        <legend className="mb-2 text-xs font-semibold text-fg-muted">
          Budget ceilings (can only lower workspace limits)
        </legend>
        {BUDGET_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} error={errors[`budget.${f.key}`]}>
            <Input
              type="number"
              min={0}
              className="tabular"
              value={draft.budget[f.key] ?? ""}
              onChange={(e) => set("budget", { ...draft.budget, [f.key]: e.target.value })}
            />
          </Field>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1 text-xs font-semibold text-fg-muted">Verification profiles</legend>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            className="size-4 accent-(--primary)"
            checked={draft.restrict_profiles}
            onChange={(e) => set("restrict_profiles", e.target.checked)}
          />
          Restrict to selected server-defined profiles
        </label>
        {draft.restrict_profiles && (
          <div className="flex flex-wrap gap-2">
            {VERIFICATION_PROFILE_IDS.map((p) => (
              <label
                key={p}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
              >
                <input
                  type="checkbox"
                  className="size-3.5 accent-(--primary)"
                  checked={draft.profiles.includes(p)}
                  onChange={(e) =>
                    set(
                      "profiles",
                      e.target.checked
                        ? [...draft.profiles, p]
                        : draft.profiles.filter((x) => x !== p),
                    )
                  }
                />
                <Mono>{p}</Mono>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={create.isPending}>
          Create template
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDone}
          disabled={create.isPending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function TemplatesSettings() {
  const { can, workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const editable = can("templates.manage");
  const templates = useTemplates(editable);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<WorkflowTemplate | null>(null);
  const archive = useMutation({
    mutationFn: (t: WorkflowTemplate) => api.templates.archive(workspaceId, t.id!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ws", workspaceId, "templates"] });
      toast.success("Template archived", { description: "Existing tasks keep their snapshot." });
      setArchiving(null);
    },
    onError: (e) => notifyError(e, "Template not archived"),
  });

  if (templates.isPending) return <SkeletonRows rows={6} />;
  if (templates.isError)
    return <ErrorState error={templates.error} onRetry={() => templates.refetch()} />;
  const builtins = templates.data.filter((t) => t.source === "builtin");
  const custom = templates.data.filter((t) => t.source === "workspace");

  return (
    <div className="flex flex-col gap-6">
      {!editable && (
        <InlineAlert tone="info" title="Read-only">
          Only workspace admins can create or archive templates.
        </InlineAlert>
      )}
      <Card>
        <CardHeader
          title="Workspace templates"
          description="Admin-managed policy for recurring kinds of work. Changes are versioned and audited; tasks keep the version they were created with."
          actions={
            editable && !creating ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus /> New template
              </Button>
            ) : undefined
          }
        />
        <CardBody className="flex flex-col gap-4">
          {creating && <CreateTemplateForm onDone={() => setCreating(false)} />}
          {custom.length === 0 && !creating ? (
            <EmptyState
              icon={<FileStack />}
              title="No workspace templates yet"
              description="Built-in templates are always available. Add your own to encode team conventions."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {custom.map((t) => (
                <TemplateCard key={t.key} t={t} editable={editable} onArchive={setArchiving} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Built-in templates" description="Application-owned and read-only." />
        <CardBody>
          <ul className="flex flex-col gap-2">
            {builtins.map((t) => (
              <TemplateCard key={t.key} t={t} editable={false} />
            ))}
          </ul>
        </CardBody>
      </Card>
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={`Archive "${archiving?.name ?? ""}"?`}
        description="New tasks can no longer use it. Existing tasks and runs keep the snapshot they were created with. This is audited."
        confirmLabel="Archive template"
        pending={archive.isPending}
        onConfirm={() => archiving && archive.mutate(archiving)}
      />
    </div>
  );
}
