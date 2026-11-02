"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, Cloud, Cpu, ShieldCheck } from "lucide-react";
import { Switch } from "radix-ui";
import { useState } from "react";
import { toast } from "sonner";
import { MetaList } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Card, CardBody, CardHeader, Mono, SkeletonRows } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { qk, useAiPolicy } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type {
  AiPolicy,
  InferenceMode,
  ProviderHealth,
  RunBudgets,
  UpdateAiPolicyRequest,
} from "@/lib/api/types";
import { notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { cn } from "@/lib/utils/cn";
import { formatDuration, formatRelative } from "@/lib/utils/format";

const BUDGET_LABELS: Record<keyof RunBudgets, string> = {
  max_steps: "Agent steps per run",
  max_input_tokens: "Input tokens per run",
  max_output_tokens: "Output tokens per run",
  max_duration_seconds: "Run duration (seconds)",
  max_changed_files: "Changed files per run",
  max_repair_attempts: "Repair attempts",
};

function usePolicyUpdate() {
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
    onError: (e) => notifyError(e, "Policy not updated"),
  });
}

function HealthCheck({ mode, disabled }: { mode: InferenceMode; disabled?: boolean }) {
  const [result, setResult] = useState<ProviderHealth | null>(null);
  const check = useMutation({
    mutationFn: () => api.ai.healthCheck({ mode }),
    onSuccess: setResult,
    onError: (e) => notifyError(e, "Health check failed"),
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        onClick={() => check.mutate()}
        loading={check.isPending}
        disabled={disabled}
      >
        <Activity /> Check health
      </Button>
      {result && (
        <span className="text-xs text-fg-muted" role="status">
          <Badge
            tone={
              result.status === "healthy"
                ? "success"
                : result.status === "degraded"
                  ? "warning"
                  : "danger"
            }
            dot
          >
            {result.status}
          </Badge>{" "}
          {formatDuration(result.latency_ms)} {result.message && `· ${result.message}`}
        </span>
      )}
    </div>
  );
}

function BudgetsForm({ policy, editable }: { policy: AiPolicy; editable: boolean }) {
  const update = usePolicyUpdate();
  const [values, setValues] = useState<RunBudgets>(policy.budgets);
  const [limit, setLimit] = useState(
    policy.monthly_budget_microunits === null
      ? ""
      : String(policy.monthly_budget_microunits / 1_000_000),
  );
  const invalid =
    Object.values(values).some((v) => !Number.isInteger(v) || v < 0) ||
    (limit !== "" && !(Number(limit) >= 0));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate({
          budgets: values,
          monthly_budget_microunits: limit === "" ? null : Math.round(Number(limit) * 1_000_000),
        });
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
        <Field
          label="Monthly hosted spend limit (USD)"
          hint="Leave empty for no limit. Local inference is never limited by cost."
        >
          <Input
            type="number"
            min={0}
            step="0.01"
            className="tabular"
            disabled={!editable}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </Field>
      </div>
      {editable && (
        <Button
          type="submit"
          size="sm"
          className="self-start"
          loading={update.isPending}
          disabled={invalid}
        >
          Save budgets
        </Button>
      )}
    </form>
  );
}

export function AiSettings() {
  const { can } = useWorkspace();
  const policy = useAiPolicy();
  const update = usePolicyUpdate();
  const [confirmCloud, setConfirmCloud] = useState(false);
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
          description="The default. Code and prompts never leave your infrastructure."
          actions={<Badge tone="success">Always on</Badge>}
        />
        <CardBody className="flex flex-col gap-4">
          <MetaList
            items={[
              { label: "Provider", value: p.local_provider.name },
              {
                label: "Generation model",
                value: <Mono className="text-fg">{p.local_provider.model}</Mono>,
              },
              {
                label: "Embedding model",
                value: <Mono className="text-fg">{p.local_provider.embedding_model}</Mono>,
              },
            ]}
          />
          <HealthCheck mode="local" />
        </CardBody>
      </Card>

      <Card className={cn(p.cloud_inference_enabled && "border-warning-border")}>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Cloud className="size-4" /> Hosted inference
            </span>
          }
          description="Opt-in. When enabled, members may choose a hosted model per run. Anvaya never falls back to a paid provider silently."
          actions={
            <Switch.Root
              checked={p.cloud_inference_enabled}
              disabled={!editable || update.isPending}
              onCheckedChange={(on) =>
                on ? setConfirmCloud(true) : update.mutate({ cloud_inference_enabled: false })
              }
              aria-label="Allow hosted inference"
              className="relative h-5 w-9 shrink-0 rounded-full bg-border-strong transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 data-[state=checked]:bg-primary"
            >
              <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[18px]" />
            </Switch.Root>
          }
        />
        <CardBody className="flex flex-col gap-3 text-sm">
          {p.cloud_inference_enabled && p.cloud_provider ? (
            <>
              <MetaList
                items={[
                  { label: "Provider", value: p.cloud_provider.name },
                  {
                    label: "Model",
                    value: <Mono className="text-fg">{p.cloud_provider.model}</Mono>,
                  },
                  { label: "Data sent", value: p.data_categories_disclosed.join(", ") },
                ]}
              />
              <HealthCheck mode="cloud" />
            </>
          ) : (
            <p className="flex items-center gap-2 text-fg-muted">
              <ShieldCheck className="size-4 text-success" /> Disabled. Every request runs on the
              local model.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Default mode for new runs" />
        <CardBody>
          <Field
            label="Default inference mode"
            hint={`Last changed ${formatRelative(p.updated_at)}.`}
          >
            <Select
              value={p.default_mode}
              disabled={!editable || update.isPending}
              onChange={(e) => update.mutate({ default_mode: e.target.value as InferenceMode })}
              className="w-64"
            >
              <option value="local">Local</option>
              <option value="cloud" disabled={!p.cloud_inference_enabled}>
                Cloud{p.cloud_inference_enabled ? "" : " (disabled)"}
              </option>
              <option value="mock">Mock (dry run)</option>
            </Select>
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Run budgets"
          description="Upper bounds for every run. Members can lower them per run, never raise them."
          actions={<Cpu className="size-4 text-fg-subtle" />}
        />
        <CardBody>
          <BudgetsForm key={p.updated_at} policy={p} editable={editable} />
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirmCloud}
        onOpenChange={setConfirmCloud}
        title="Allow hosted inference?"
        description="Members will be able to send selected code snippets, task descriptions, and test output excerpts to a hosted model provider. Secrets and excluded files are never sent. This change is audited."
        confirmLabel="Allow hosted inference"
        pending={update.isPending}
        onConfirm={() =>
          update.mutate(
            { cloud_inference_enabled: true },
            { onSuccess: () => setConfirmCloud(false) },
          )
        }
      />
    </div>
  );
}
