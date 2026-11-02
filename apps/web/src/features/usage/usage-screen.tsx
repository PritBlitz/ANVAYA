"use client";

import { Cpu, ShieldCheck } from "lucide-react";
import { ModeBadge } from "@/components/domain/badges";
import { PageContainer, PageHeader } from "@/components/layout/page";
import { Card, CardBody, CardHeader, Mono, Progress, SkeletonRows } from "@/components/ui/misc";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { useUsage } from "@/lib/api/queries";
import { formatCompact, formatCost, formatNumber, formatPercent } from "@/lib/utils/format";
import { DailyTokensChart } from "./daily-chart";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="mt-1.5 text-xl font-semibold tracking-tight text-fg tabular">{value}</p>
      {hint && <p className="mt-0.5 text-2xs text-fg-subtle">{hint}</p>}
    </Card>
  );
}

export function UsageScreen() {
  const usage = useUsage();
  return (
    <PageContainer>
      <PageHeader
        title="Usage"
        description="Model consumption across the workspace. These aggregates support budgeting and capacity planning, not individual productivity measurement."
      />
      {usage.isPending ? (
        <SkeletonRows rows={8} />
      ) : usage.isError ? (
        <ErrorState error={usage.error} onRetry={() => usage.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat
              label="Tokens"
              value={formatCompact(
                usage.data.totals.input_tokens + usage.data.totals.output_tokens,
              )}
              hint={`${formatCompact(usage.data.totals.input_tokens)} in · ${formatCompact(usage.data.totals.output_tokens)} out`}
            />
            <Stat label="Runs" value={formatNumber(usage.data.totals.runs)} />
            <Stat label="Questions" value={formatNumber(usage.data.totals.questions)} />
            <Stat
              label="Local inference"
              value={formatPercent(usage.data.totals.local_share)}
              hint="Share of requests"
            />
            <Stat
              label="Estimated cost"
              value={formatCost(usage.data.totals.estimated_cost_microunits)}
              hint="Hosted providers only"
            />
          </div>
          {usage.data.totals.local_share === 1 && (
            <InlineAlert tone="success" icon={<ShieldCheck />} title="All inference ran locally">
              No source code was sent to a hosted model provider in this period.
            </InlineAlert>
          )}
          <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
            <Card>
              <CardHeader
                title="Tokens per day"
                description={`${usage.data.period_start.slice(0, 10)} – ${usage.data.period_end.slice(0, 10)}`}
              />
              <CardBody>
                <DailyTokensChart daily={usage.data.daily} />
              </CardBody>
            </Card>
            <div className="flex flex-col gap-6">
              <Card>
                <CardHeader title="Budget" />
                <CardBody className="flex flex-col gap-2">
                  {usage.data.budget.limit_microunits === null ? (
                    <p className="text-sm text-fg-muted">
                      No monthly spend limit. Hosted inference is governed by AI policy.
                    </p>
                  ) : (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-fg-muted">Spent</span>
                        <span className="text-fg tabular">
                          {formatCost(usage.data.budget.used_microunits)} /{" "}
                          {formatCost(usage.data.budget.limit_microunits)}
                        </span>
                      </div>
                      <Progress
                        value={usage.data.budget.used_microunits}
                        max={usage.data.budget.limit_microunits || 1}
                        label="Monthly budget used"
                      />
                    </>
                  )}
                </CardBody>
              </Card>
              <Card className="overflow-hidden">
                <CardHeader title="By provider" />
                {usage.data.by_provider.length === 0 ? (
                  <p className="p-4 text-sm text-fg-muted">No model usage yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <caption className="sr-only">Usage by provider and model</caption>
                    <thead className="text-left text-xs text-fg-muted">
                      <tr className="border-b border-border">
                        <th scope="col" className="px-4 py-2 font-medium">
                          Model
                        </th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">
                          Requests
                        </th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">
                          Tokens
                        </th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">
                          Cost
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border tabular">
                      {usage.data.by_provider.map((p) => (
                        <tr key={`${p.provider}-${p.model}-${p.mode}`}>
                          <td className="px-4 py-2">
                            <div className="flex flex-col gap-1">
                              <Mono className="text-fg">{p.model}</Mono>
                              <ModeBadge mode={p.mode} />
                            </div>
                          </td>
                          <td className="px-4 py-2 text-right text-fg-muted">
                            {formatNumber(p.requests)}
                          </td>
                          <td className="px-4 py-2 text-right text-fg-muted">
                            {formatCompact(p.input_tokens + p.output_tokens)}
                          </td>
                          <td className="px-4 py-2 text-right text-fg-muted">
                            {formatCost(p.estimated_cost_microunits)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
              <p className="flex items-start gap-2 text-xs text-fg-muted">
                <Cpu className="mt-0.5 size-3.5 shrink-0" /> Local models have no per-token cost.
                Estimates for hosted providers use published rates and may differ from invoices.
              </p>
            </div>
          </div>
        </>
      )}
    </PageContainer>
  );
}
