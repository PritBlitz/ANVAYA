"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, Cloud, Cpu, ShieldCheck } from "lucide-react";
import { Switch } from "radix-ui";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { MetaList } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Card, CardBody, CardHeader, Mono, SkeletonRows } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { isApiError } from "@/lib/api/errors";
import { qk, useAiPolicy, useRunBudgetLimits } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import {
  DATA_CATEGORIES,
  type AiPolicy,
  type InferenceMode,
  type ProviderHealth,
  type RunBudgets,
  type UpdateAiPolicyRequest,
} from "@/lib/api/types";
import { notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { cn } from "@/lib/utils/cn";
import { formatDuration } from "@/lib/utils/format";

const MODE_LABEL: Record<InferenceMode, { label: string; icon: ReactNode; description: string }> = {
  local: {
    label: "Local",
    icon: <Cpu />,
    description: "Ollama on your infrastructure. Code never leaves it.",
  },
  mock: {
    label: "Mock",
    icon: <Bot />,
    description: "Deterministic responses for dry runs and testing.",
  },
  cloud: {
    label: "Cloud",
    icon: <Cloud />,
    description: "Hosted provider. Requires opt-in and disclosure.",
  },
};

const BUDGET_LABELS: Record<keyof RunBudgets, string> = {
  max_steps: "Agent steps per run",
  max_input_tokens: "Input tokens per run",
  max_output_tokens: "Output tokens per run",
  max_duration_seconds: "Run duration (seconds)",
  max_changed_files: "Changed files per run",
  max_repair_attempts: "Repair attempts",
};

const category = (c: string) => c.replace(/_/g, " ");

interface Disclosure {
  provider: string | null;
  data_categories: string[];
}

function usePolicyUpdate(onDisclosure?: (d: Disclosure) => void) {
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAiPolicyRequest) => api.workspaces.updateAiPolicy(workspaceId, body),
    onSuccess: (policy) => {
      queryClient.setQueryData(qk.aiPolicy(workspaceId), policy);
      toast.success("AI policy updated", {
        description: "The change is recorded in the audit log.",
      });
    },
    onError: (e) => {
      // Enabling cloud first returns what would be sent; the admin must acknowledge it.
      if (isApiError(e) && e.code === "DATA_DISCLOSURE_REQUIRED" && onDisclosure) {
        onDisclosure({
          provider: typeof e.details.provider === "string" ? e.details.provider : null,
          data_categories: Array.isArray(e.details.data_categories)
            ? e.details.data_categories.map(String)
            : [],
        });
        return;
      }
      notifyError(e, "Policy not updated");
    },
  });
}

function HealthCheck({ mode }: { mode: InferenceMode }) {
  const [result, setResult] = useState<ProviderHealth | null>(null);
  const check = useMutation({
    mutationFn: () => api.ai.healthCheck({ mode }),
    onSuccess: setResult,
    onError: (e) => notifyError(e, "Health check failed"),
  });
  return (
    <div className="flex flex-col gap-2">
      <Button
        size="xs"
        className="self-start"
        onClick={() => check.mutate()}
        loading={check.isPending}
      >
        <Activity /> Check {MODE_LABEL[mode].label.toLowerCase()} provider
      </Button>
      {result && (
        <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <Badge tone={result.available ? "success" : "danger"} dot>
            {result.available ? "Available" : "Unavailable"}
          </Badge>
          {result.provider && <span>{result.provider}</span>}
          {result.models.length > 0 && <Mono className="text-fg">{result.models.join(", ")}</Mono>}
          {result.detail && <span>· {result.detail}</span>}
        </div>
      )}
    </div>
  );
}

function ModesCard({ policy, editable }: { policy: AiPolicy; editable: boolean }) {
  const update = usePolicyUpdate();
  const toggle = (mode: InferenceMode, on: boolean) => {
    const next = on
      ? [...new Set([...policy.allowed_modes, mode])]
      : policy.allowed_modes.filter((m) => m !== mode);
    if (next.length === 0) {
      toast.error("At least one mode must stay allowed");
      return;
    }
    update.mutate({
      allowed_modes: next,
      ...(next.includes(policy.default_mode) ? {} : { default_mode: next[0] }),
    });
  };
  return (
    <Card>
      <CardHeader
        title="Inference modes"
        description="Which modes members may choose for questions and runs."
      />
      <CardBody className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2" disabled={!editable || update.isPending}>
          <legend className="sr-only">Allowed modes</legend>
          {(["local", "mock", "cloud"] as const).map((m) => {
            const checked = policy.allowed_modes.includes(m);
            const blocked = m === "cloud" && !policy.cloud.enabled;
            return (
              <label
                key={m}
                className={cn(
                  "flex items-start gap-3 rounded-md border border-border p-3 text-sm",
                  blocked && "opacity-60",
                )}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-(--primary)"
                  checked={checked}
                  disabled={blocked}
                  onChange={(e) => toggle(m, e.target.checked)}
                />
                <span className="text-fg-muted [&_svg]:size-4">{MODE_LABEL[m].icon}</span>
                <span>
                  <span className="block font-medium text-fg">{MODE_LABEL[m].label}</span>
                  <span className="block text-xs text-fg-muted">
                    {blocked ? "Enable hosted inference below first." : MODE_LABEL[m].description}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <Field label="Default mode" hint="Used when a member doesn't choose a mode.">
          <Select
            value={policy.default_mode}
            disabled={!editable || update.isPending}
            onChange={(e) => update.mutate({ default_mode: e.target.value as InferenceMode })}
            className="w-56"
          >
            {policy.allowed_modes.map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m].label}
              </option>
            ))}
          </Select>
        </Field>
      </CardBody>
    </Card>
  );
}

function CloudCard({ policy, editable }: { policy: AiPolicy; editable: boolean }) {
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const update = usePolicyUpdate(setDisclosure);
  const enabled = policy.cloud.enabled;
  return (
    <Card className={cn(enabled && "border-warning-border")}>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Cloud className="size-4" /> Hosted inference
          </span>
        }
        description="Opt-in. Anvaya never falls back to a paid provider silently."
        actions={
          <Switch.Root
            checked={enabled}
            disabled={!editable || update.isPending}
            onCheckedChange={(on) => update.mutate({ cloud: { enabled: on } })}
            aria-label="Allow hosted inference"
            className="relative h-5 w-9 shrink-0 rounded-full bg-border-strong transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 data-[state=checked]:bg-primary"
          >
            <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[18px]" />
          </Switch.Root>
        }
      />
      <CardBody className="flex flex-col gap-4 text-sm">
        {enabled ? (
          <>
            <MetaList
              items={[
                { label: "Provider", value: policy.cloud.provider ?? "—" },
                {
                  label: "Model",
                  value: <Mono className="text-fg">{policy.cloud.model ?? "—"}</Mono>,
                },
              ]}
            />
            <fieldset disabled={!editable || update.isPending}>
              <legend className="mb-2 text-xs font-semibold text-fg-muted">
                Data that may be sent
              </legend>
              <div className="flex flex-wrap gap-2">
                {DATA_CATEGORIES.map((c) => {
                  const on = policy.cloud.data_categories.includes(c);
                  return (
                    <label
                      key={c}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs capitalize"
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 accent-(--primary)"
                        checked={on}
                        onChange={(e) =>
                          update.mutate({
                            cloud: {
                              data_categories: e.target.checked
                                ? [...policy.cloud.data_categories, c]
                                : policy.cloud.data_categories.filter((x) => x !== c),
                            },
                          })
                        }
                      />
                      {category(c)}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            {policy.allowed_modes.includes("cloud") && <HealthCheck mode="cloud" />}
          </>
        ) : (
          <p className="flex items-center gap-2 text-fg-muted">
            <ShieldCheck className="size-4 text-success" /> Disabled. Every request runs on a local
            or mock model.
          </p>
        )}
      </CardBody>
      <ConfirmDialog
        open={!!disclosure}
        onOpenChange={(o) => !o && setDisclosure(null)}
        title="Allow hosted inference?"
        description="Members will be able to send the data below to a hosted model provider. Secrets and excluded files are never sent. This change is audited."
        confirmLabel="Acknowledge and enable"
        pending={update.isPending}
        onConfirm={() =>
          update.mutate(
            { cloud: { enabled: true }, acknowledge_data_disclosure: true },
            { onSuccess: () => setDisclosure(null) },
          )
        }
      >
        {disclosure && (
          <div className="rounded-md bg-surface-sunken px-3 py-2 text-sm">
            <p className="text-fg">
              Provider:{" "}
              <span className="font-medium">
                {disclosure.provider ?? "configured hosted provider"}
              </span>
            </p>
            <p className="mt-1 text-fg-muted">
              Data categories:{" "}
              {disclosure.data_categories.map(category).join(", ") || "none configured"}
            </p>
          </div>
        )}
      </ConfirmDialog>
    </Card>
  );
}

function LimitsCard({ policy, editable }: { policy: AiPolicy; editable: boolean }) {
  const update = usePolicyUpdate();
  const [values, setValues] = useState(policy.limits);
  const invalid = Object.values(values).some((v) => !Number.isInteger(v) || v <= 0);
  const fields: { key: keyof AiPolicy["limits"]; label: string; hint: string }[] = [
    { key: "max_input_tokens", label: "Max input tokens per request", hint: "1,024 – 200,000" },
    { key: "max_output_tokens", label: "Max output tokens per request", hint: "128 – 32,000" },
    { key: "request_timeout_seconds", label: "Request timeout (seconds)", hint: "10 – 1,800" },
  ];
  return (
    <Card>
      <CardHeader
        title="Model limits"
        description="Per-request limits applied to every model call."
      />
      <CardBody>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ limits: values });
          }}
          className="flex flex-col gap-4"
        >
          <div className="grid gap-4 sm:grid-cols-3">
            {fields.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                <Input
                  type="number"
                  min={1}
                  className="tabular"
                  disabled={!editable}
                  value={values[f.key]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: Number(e.target.value) }))}
                />
              </Field>
            ))}
          </div>
          {editable && (
            <Button
              type="submit"
              size="sm"
              className="self-start"
              loading={update.isPending}
              disabled={invalid}
            >
              Save limits
            </Button>
          )}
        </form>
      </CardBody>
    </Card>
  );
}

function BudgetsCard({ ceilings, editable }: { ceilings: RunBudgets; editable: boolean }) {
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<RunBudgets>(ceilings);
  const save = useMutation({
    mutationFn: () =>
      api.workspaces.update(workspaceId, { settings: { run_budget_limits: values } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.workspace(workspaceId) });
      toast.success("Run budgets updated");
    },
    onError: (e) => notifyError(e, "Budgets not updated"),
  });
  const invalid = Object.values(values).some((v) => !Number.isInteger(v) || v < 0);
  return (
    <Card>
      <CardHeader
        title="Run budget ceilings"
        description="Upper bounds for every run. Members can lower them per run, never raise them."
      />
      <CardBody>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {(Object.keys(BUDGET_LABELS) as (keyof RunBudgets)[]).map((k) => (
              <Field key={k} label={BUDGET_LABELS[k]}>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  className="tabular"
                  disabled={!editable}
                  value={values[k]}
                  onChange={(e) => setValues((v) => ({ ...v, [k]: Number(e.target.value) }))}
                />
              </Field>
            ))}
          </div>
          {editable && (
            <Button
              type="submit"
              size="sm"
              className="self-start"
              loading={save.isPending}
              disabled={invalid}
            >
              Save budgets
            </Button>
          )}
        </form>
      </CardBody>
    </Card>
  );
}

export function AiSettings() {
  const { can } = useWorkspace();
  const policy = useAiPolicy();
  const ceilings = useRunBudgetLimits();
  const editable = can("ai_policy.manage");

  if (policy.isPending) return <SkeletonRows rows={8} />;
  if (policy.isError) return <ErrorState error={policy.error} onRetry={() => policy.refetch()} />;
  const p = policy.data;

  return (
    <div className="flex flex-col gap-6">
      {!editable && (
        <InlineAlert tone="info" title="Read-only">
          Only workspace admins can change AI policy.
        </InlineAlert>
      )}
      <Card>
        <CardHeader
          title="Local inference"
          description="The default. Code and prompts stay on your infrastructure."
          actions={<Badge tone="success">Local-first</Badge>}
        />
        <CardBody>
          {p.allowed_modes.includes("local") ? (
            <HealthCheck mode="local" />
          ) : (
            <p className="text-sm text-fg-muted">Local mode is not currently allowed.</p>
          )}
        </CardBody>
      </Card>
      <ModesCard policy={p} editable={editable} />
      <CloudCard policy={p} editable={editable} />
      <LimitsCard key={JSON.stringify(p.limits)} policy={p} editable={editable} />
      {ceilings.data && (
        <BudgetsCard
          key={JSON.stringify(ceilings.data)}
          ceilings={ceilings.data}
          editable={editable && can("workspace.manage")}
        />
      )}
      <p className="text-xs text-fg-subtle">
        Durations shown in runs use {formatDuration(p.limits.request_timeout_seconds * 1000)} as the
        per-request timeout.
      </p>
    </div>
  );
}
