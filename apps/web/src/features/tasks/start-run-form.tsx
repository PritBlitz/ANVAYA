"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Bot, ChevronDown, Cloud, Cpu, Play } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InlineAlert } from "@/components/ui/states";
import { createIdempotencyKey } from "@/lib/api/client";
import { qk, useAiPolicy, useRunBudgetLimits } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type { InferenceMode, Repository, RunBudgets } from "@/lib/api/types";
import { notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { cn } from "@/lib/utils/cn";

const BUDGET_FIELDS: { key: keyof RunBudgets; label: string; unit?: string }[] = [
  { key: "max_steps", label: "Agent steps" },
  { key: "max_input_tokens", label: "Input tokens" },
  { key: "max_output_tokens", label: "Output tokens" },
  { key: "max_duration_seconds", label: "Duration", unit: "s" },
  { key: "max_changed_files", label: "Changed files" },
  { key: "max_repair_attempts", label: "Repair attempts" },
];

/** Clamp requested budgets to policy maxima. The server clamps too (API_SPEC §5). */
export function clampBudgets(requested: Partial<RunBudgets>, max: RunBudgets): RunBudgets {
  const out = { ...max };
  for (const { key } of BUDGET_FIELDS) {
    const v = requested[key];
    if (typeof v === "number" && Number.isFinite(v))
      out[key] = Math.max(0, Math.min(Math.floor(v), max[key]));
  }
  return out;
}

function ModeOption({
  value,
  current,
  onSelect,
  icon,
  title,
  description,
  disabled,
}: {
  value: InferenceMode;
  current: InferenceMode;
  onSelect: (m: InferenceMode) => void;
  icon: ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  const checked = value === current;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors [&_svg]:size-4",
        checked
          ? "border-primary bg-primary-soft/40 ring-1 ring-primary/30"
          : "border-border hover:border-border-strong",
        disabled && "cursor-not-allowed opacity-55",
      )}
    >
      <input
        type="radio"
        name="mode"
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(value)}
        className="sr-only"
      />
      <span className={cn("mt-0.5", checked ? "text-primary" : "text-fg-muted")}>{icon}</span>
      <span>
        <span className="block text-sm font-medium text-fg">{title}</span>
        <span className="block text-xs text-fg-muted">{description}</span>
      </span>
    </label>
  );
}

export function StartRunForm({
  taskId,
  repo,
  disabledReason,
}: {
  taskId: string;
  repo: Repository | undefined;
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { base, workspaceId } = useWorkspace();
  const policy = useAiPolicy();
  const ceilings = useRunBudgetLimits().data;
  const key = useRef(createIdempotencyKey());
  const [mode, setMode] = useState<InferenceMode | null>(null);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [showBudgets, setShowBudgets] = useState(false);
  const [budgets, setBudgets] = useState<Partial<RunBudgets>>({});

  const effectiveMode = mode ?? policy.data?.default_mode ?? "local";
  const branch = baseBranch ?? repo?.default_branch ?? "main";
  const allowed = policy.data?.allowed_modes ?? ["local"];
  const cloudAllowed = !!policy.data?.cloud.enabled && allowed.includes("cloud");

  const start = useMutation({
    mutationFn: () =>
      api.tasks.startRun(
        taskId,
        {
          mode: effectiveMode,
          base_branch: branch.trim(),
          ...(ceilings && Object.keys(budgets).length
            ? { budgets: clampBudgets(budgets, ceilings) }
            : {}),
        },
        key.current,
      ),
    onSuccess: (run) => {
      key.current = createIdempotencyKey();
      void queryClient.invalidateQueries({ queryKey: qk.ws(workspaceId) });
      toast.success(`Run #${run.run_number} started`);
      router.push(`${base}/runs/${run.id}`);
    },
    onError: (e) => {
      key.current = createIdempotencyKey();
      notifyError(e, "Couldn't start the run");
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
      className="flex flex-col gap-4"
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-fg">Inference</legend>
        <ModeOption
          value="local"
          current={effectiveMode}
          onSelect={setMode}
          icon={<Cpu />}
          title={allowed.includes("local") ? "Local · Ollama" : "Local · disabled by policy"}
          description="Code never leaves your infrastructure."
          disabled={!allowed.includes("local")}
        />
        <ModeOption
          value="cloud"
          current={effectiveMode}
          onSelect={setMode}
          icon={<Cloud />}
          title={
            cloudAllowed
              ? `Cloud · ${policy.data?.cloud.model ?? policy.data?.cloud.provider ?? "hosted"}`
              : "Cloud · disabled by policy"
          }
          description={
            cloudAllowed
              ? "Opt-in. Selected snippets are sent to the hosted provider."
              : "An admin can enable hosted inference in AI policy."
          }
          disabled={!cloudAllowed}
        />
        <ModeOption
          value="mock"
          current={effectiveMode}
          onSelect={setMode}
          icon={<Bot />}
          title={allowed.includes("mock") ? "Dry run · mock model" : "Dry run · disabled by policy"}
          description="Deterministic responses. Useful for testing the workflow (FR-WF-010)."
          disabled={!allowed.includes("mock")}
        />
      </fieldset>
      {effectiveMode === "cloud" && policy.data && (
        <InlineAlert tone="warning" icon={<Cloud />} title="Data sent to a hosted provider">
          {policy.data.cloud.provider}:{" "}
          {policy.data.cloud.data_categories.map((c) => c.replace(/_/g, " ")).join(", ")}. Secrets
          and excluded files are never sent.
        </InlineAlert>
      )}
      <Field label="Base branch">
        <Input
          value={branch}
          onChange={(e) => setBaseBranch(e.target.value)}
          className="font-mono"
          spellCheck={false}
        />
      </Field>
      <div>
        <button
          type="button"
          onClick={() => setShowBudgets((v) => !v)}
          aria-expanded={showBudgets}
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform", showBudgets && "rotate-180")}
          />{" "}
          Budgets
        </button>
        {showBudgets && ceilings && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            {BUDGET_FIELDS.map(({ key: k, label, unit }) => (
              <Field key={k} label={label} hint={`Max ${ceilings[k]}${unit ?? ""}`}>
                <Input
                  type="number"
                  min={0}
                  max={ceilings[k]}
                  value={budgets[k] ?? ceilings[k]}
                  onChange={(e) =>
                    setBudgets((b) => ({
                      ...b,
                      [k]: e.target.value === "" ? undefined : Number(e.target.value),
                    }))
                  }
                  className="tabular"
                />
              </Field>
            ))}
            <p className="col-span-2 text-xs text-fg-muted">
              You can lower budgets for this run. Workspace policy caps them; the server enforces
              the cap.
            </p>
          </div>
        )}
      </div>
      {disabledReason && <p className="text-xs text-fg-muted">{disabledReason}</p>}
      <Button
        type="submit"
        variant="primary"
        loading={start.isPending}
        disabled={!!disabledReason || !branch.trim()}
      >
        <Play /> Start run
      </Button>
    </form>
  );
}
