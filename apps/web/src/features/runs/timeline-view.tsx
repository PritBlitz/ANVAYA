"use client";

import { Bot, ChevronDown, Cpu, TerminalSquare, Wrench } from "lucide-react";
import { useState } from "react";
import { MetaList, SectionTitle } from "@/components/layout/page";
import { Badge, type Tone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, Mono, Progress, SkeletonRows } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useRunSteps } from "@/lib/api/queries";
import type { AgentStep, AgentStepStatus, RunBudgets } from "@/lib/api/types";
import {
  agentLabel,
  describeEvent,
  isDeterministicAgent,
  type EventTone,
} from "@/lib/domain/events";
import { cn } from "@/lib/utils/cn";
import {
  formatCompact,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import { useRunContext } from "./run-context";

const STEP_TONE: Record<AgentStepStatus, Tone> = {
  queued: "neutral",
  running: "info",
  succeeded: "success",
  failed: "danger",
  skipped: "neutral",
  cancelled: "neutral",
};

function StepItem({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);
  const deterministic = isDeterministicAgent(step.agent_type);
  const tokens = (step.input_tokens ?? 0) + (step.output_tokens ?? 0);
  return (
    <li className="relative pl-9">
      <span
        aria-hidden
        className={cn(
          "absolute top-3 left-0 flex size-6 items-center justify-center rounded-md border [&_svg]:size-3.5",
          deterministic
            ? "border-border bg-surface text-fg-muted"
            : "border-ai-border bg-ai-soft text-ai",
        )}
      >
        {deterministic ? <TerminalSquare /> : <Bot />}
      </span>
      <div className="rounded-lg border border-border bg-surface">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          <span className="text-sm font-medium text-fg">{agentLabel(step.agent_type)}</span>
          <Badge tone={STEP_TONE[step.status]} dot pulse={step.status === "running"}>
            {step.status}
          </Badge>
          {deterministic ? <Badge>Deterministic</Badge> : <Badge tone="ai">Model</Badge>}
          <span className="ml-auto flex items-center gap-3 text-xs text-fg-muted tabular">
            {tokens > 0 && <span>{formatCompact(tokens)} tokens</span>}
            <span>{formatDuration(step.duration_ms)}</span>
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </span>
        </button>
        {open && (
          <div className="flex flex-col gap-3 border-t border-border px-3.5 py-3">
            <MetaList
              items={[
                {
                  label: "Provider / model",
                  value: step.provider ? <Mono>{`${step.provider} · ${step.model}`}</Mono> : "—",
                },
                { label: "Prompt version", value: <Mono>{step.prompt_version ?? "—"}</Mono> },
                {
                  label: "Tokens in / out",
                  value: (
                    <span className="tabular">
                      {formatNumber(step.input_tokens)} / {formatNumber(step.output_tokens)}
                    </span>
                  ),
                },
                { label: "Finished", value: formatDateTime(step.ended_at) },
                ...(step.error_code
                  ? [
                      {
                        label: "Error",
                        value: <Mono className="text-danger">{step.error_code}</Mono>,
                      },
                    ]
                  : []),
              ]}
            />
            {!!step.tools?.length && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-fg-muted">
                  Tool calls · inputs redacted
                </p>
                <ul className="flex flex-col gap-1">
                  {step.tools.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-start gap-2 rounded-md bg-surface-sunken px-2.5 py-1.5 font-mono text-2xs"
                    >
                      <Wrench className="mt-0.5 size-3 shrink-0 text-fg-subtle" />
                      <span className="text-fg">{t.tool_name}</span>
                      <span className="min-w-0 flex-1 truncate text-fg-subtle">
                        {JSON.stringify(t.input_redacted)}
                      </span>
                      <span className={t.status === "failed" ? "text-danger" : "text-fg-muted"}>
                        {t.status}
                      </span>
                      <span className="text-fg-subtle">{formatDuration(t.duration_ms)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

const DOT: Record<EventTone, string> = {
  neutral: "bg-fg-subtle",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  ai: "bg-ai",
};

function ActivityLog() {
  const { events } = useRunContext();
  const visible = events.map((e) => ({ e, d: describeEvent(e) })).filter(({ d }) => !d.quiet);
  return (
    <Card>
      <CardHeader title="Activity" description="Live event stream for this run." />
      {visible.length === 0 ? (
        <p className="px-4 py-5 text-sm text-fg-muted">Waiting for events…</p>
      ) : (
        <ol
          className="max-h-[420px] scrollbar-thin overflow-y-auto px-4 py-3"
          aria-live="polite"
          aria-relevant="additions"
        >
          {[...visible].reverse().map(({ e, d }) => (
            <li key={e.id} className="flex gap-3 py-1.5 text-sm">
              <span
                aria-hidden
                className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT[d.tone])}
              />
              <span className="min-w-0 flex-1">
                <span className="text-fg">{d.title}</span>
                {d.detail && (
                  <span className="block truncate font-mono text-2xs text-fg-subtle">
                    {d.detail}
                  </span>
                )}
              </span>
              <time
                className="shrink-0 text-2xs text-fg-subtle tabular"
                dateTime={e.payload.timestamp}
                title={formatDateTime(e.payload.timestamp)}
              >
                {e.payload.timestamp.slice(11, 19)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function BudgetRow({
  label,
  used,
  max,
  unit = "",
}: {
  label: string;
  used: number;
  max: number | undefined;
  unit?: string;
}) {
  if (max === undefined) return null;
  const ratio = max > 0 ? used / max : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-fg-muted">{label}</span>
        <span className="text-fg tabular">
          {formatCompact(used)}
          {unit} / {formatCompact(max)}
          {unit}
        </span>
      </div>
      <Progress
        value={Math.min(used, max)}
        max={max || 1}
        label={`${label} budget used`}
        tone={ratio > 0.9 ? "warning" : "primary"}
      />
    </div>
  );
}

export function TimelineView() {
  const { run } = useRunContext();
  const steps = useRunSteps(run.id);
  const b = run.budget as Partial<RunBudgets>;
  const u = run.usage_summary;
  const elapsed = run.started_at
    ? ((run.ended_at ? Date.parse(run.ended_at) : Date.parse(run.updated_at)) -
        Date.parse(run.started_at)) /
      1000
    : 0;

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
      <section aria-labelledby="steps-title" className="flex flex-col gap-3">
        <SectionTitle>
          <span id="steps-title">Agent stages</span>
        </SectionTitle>
        {steps.isPending ? (
          <SkeletonRows rows={4} />
        ) : steps.isError ? (
          <ErrorState compact error={steps.error} onRetry={() => steps.refetch()} />
        ) : steps.data.length === 0 ? (
          <Card>
            <EmptyState
              compact
              icon={<Cpu />}
              title="Queued"
              description="Waiting for an orchestration worker to pick up this run."
            />
          </Card>
        ) : (
          <ol className="relative flex flex-col gap-2.5 before:absolute before:top-4 before:bottom-4 before:left-3 before:w-px before:bg-border">
            {steps.data.map((s) => (
              <StepItem key={s.id} step={s} />
            ))}
          </ol>
        )}
      </section>
      <aside className="flex flex-col gap-6">
        <Card>
          <CardHeader
            title="Budget"
            description="Enforced server-side. Runs stop when a budget is exhausted."
          />
          <CardBody className="flex flex-col gap-3">
            <BudgetRow
              label="Agent steps"
              used={u.steps ?? steps.data?.length ?? 0}
              max={b.max_steps}
            />
            <BudgetRow label="Input tokens" used={u.input_tokens ?? 0} max={b.max_input_tokens} />
            <BudgetRow
              label="Output tokens"
              used={u.output_tokens ?? 0}
              max={b.max_output_tokens}
            />
            <BudgetRow
              label="Duration"
              used={Math.round(elapsed)}
              max={b.max_duration_seconds}
              unit="s"
            />
            <BudgetRow
              label="Repair attempts"
              used={u.repair_attempts ?? 0}
              max={b.max_repair_attempts}
            />
          </CardBody>
        </Card>
        <ActivityLog />
        <Card>
          <CardBody>
            <MetaList
              items={[
                { label: "Run ID", value: <Mono title={run.id}>{run.id.slice(0, 13)}…</Mono> },
                { label: "Provider", value: run.provider ?? "—" },
                { label: "Model", value: <Mono>{run.model ?? "—"}</Mono> },
                {
                  label: "State version",
                  value: <span className="tabular">{run.state_version}</span>,
                },
                { label: "Created", value: formatRelative(run.created_at) },
              ]}
            />
          </CardBody>
        </Card>
      </aside>
    </div>
  );
}
