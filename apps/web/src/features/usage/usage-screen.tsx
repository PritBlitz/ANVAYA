"use client";

import { Cpu, ShieldCheck } from "lucide-react";
import { ModeBadge } from "@/components/domain/badges";
import { PageContainer, PageHeader } from "@/components/layout/page";
import { Card, CardBody, CardHeader, Mono, Progress, SkeletonRows } from "@/components/ui/misc";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { useUsage } from "@/lib/api/queries";
import { humanize } from "@/lib/domain/status";
import {
  formatCompact,
  formatCost,
  formatDuration,
  formatNumber,
  formatPercent,
} from "@/lib/utils/format";
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
        (() => {
          const u = usage.data;
          const modes = u.requests_by_mode;
          const totalRequests = modes.local + modes.mock + modes.hosted;
          return (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <Stat label="Model requests" value={formatNumber(u.totals.requests)} />
                <Stat
                  label="Tokens"
                  value={formatCompact(u.totals.input_tokens + u.totals.output_tokens)}
                  hint={`${formatCompact(u.totals.input_tokens)} in · ${formatCompact(u.totals.output_tokens)} out`}
                />
                <Stat
                  label="Local or mock"
                  value={formatPercent(u.totals.local_share)}
                  hint="Share of requests"
                />
                <Stat label="Avg latency" value={formatDuration(u.totals.avg_duration_ms)} />
                <Stat
                  label="Estimated cost"
                  value={
                    u.totals.estimated_cost_microunits === null
                      ? "$0.00"
                      : formatCost(u.totals.estimated_cost_microunits)
                  }
                  hint="Hosted providers only"
                />
              </div>
              {modes.hosted === 0 && (
                <InlineAlert
                  tone="success"
                  icon={<ShieldCheck />}
                  title="No hosted inference in this period"
                >
                  No source code was sent to a hosted model provider.
                </InlineAlert>
              )}
              <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
                <Card>
                  <CardHeader
                    title="Tokens per day"
                    description={`${u.period_start.slice(0, 10)} – ${(u.period_end ?? new Date().toISOString()).slice(0, 10)} (UTC)`}
                  />
                  <CardBody>
                    {u.daily ? (
                      <DailyTokensChart daily={u.daily} />
                    ) : (
                      <p className="text-sm text-fg-muted">
                        A daily breakdown isn&apos;t available from this API version.
                      </p>
                    )}
                  </CardBody>
                </Card>
                <div className="flex flex-col gap-6">
                  <Card>
                    <CardHeader title="Requests by mode" />
                    <CardBody className="flex flex-col gap-3">
                      {(
                        [
                          ["Local", modes.local, "success"],
                          ["Mock", modes.mock, "primary"],
                          ["Hosted", modes.hosted, "warning"],
                        ] as const
                      ).map(([label, n, tone]) => (
                        <div key={label} className="flex flex-col gap-1">
                          <div className="flex justify-between text-xs">
                            <span className="text-fg-muted">{label}</span>
                            <span className="text-fg tabular">{formatNumber(n)}</span>
                          </div>
                          <Progress
                            value={n}
                            max={totalRequests || 1}
                            label={`${label} requests`}
                            tone={tone}
                          />
                        </div>
                      ))}
                    </CardBody>
                  </Card>
                  <Card className="overflow-hidden">
                    <CardHeader title="By provider" />
                    {u.by_provider.length === 0 ? (
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
                          {u.by_provider.map((p) => (
                            <tr key={`${p.provider}-${p.model}`}>
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
                                {p.estimated_cost_microunits === null
                                  ? "—"
                                  : formatCost(p.estimated_cost_microunits)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </Card>
                </div>
              </div>
              {u.by_operation.length > 0 && (
                <Card className="overflow-hidden">
                  <CardHeader title="By operation" description="What the model was used for." />
                  <table className="w-full text-sm">
                    <caption className="sr-only">Usage by operation</caption>
                    <thead className="text-left text-xs text-fg-muted">
                      <tr className="border-b border-border">
                        <th scope="col" className="px-4 py-2 font-medium">
                          Operation
                        </th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">
                          Requests
                        </th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">
                          Tokens
                        </th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">
                          Avg latency
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border tabular">
                      {u.by_operation.map((o) => (
                        <tr key={o.operation}>
                          <td className="px-4 py-2 text-fg">{humanize(o.operation)}</td>
                          <td className="px-4 py-2 text-right text-fg-muted">
                            {formatNumber(o.requests)}
                          </td>
                          <td className="px-4 py-2 text-right text-fg-muted">
                            {formatCompact(o.input_tokens + o.output_tokens)}
                          </td>
                          <td className="px-4 py-2 text-right text-fg-muted">
                            {formatDuration(o.avg_duration_ms)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              )}
              <p className="flex items-start gap-2 text-xs text-fg-muted">
                <Cpu className="mt-0.5 size-3.5 shrink-0" /> Local models have no per-token cost.
                Estimates for hosted providers use published rates and may differ from invoices.
              </p>
            </>
          );
        })()
      )}
    </PageContainer>
  );
}
