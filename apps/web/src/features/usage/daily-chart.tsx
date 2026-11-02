"use client";

import { useState } from "react";
import type { UsageSummary } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { formatCompact, formatNumber } from "@/lib/utils/format";

/** "Ticks" at 0, ½ and max, rounded to a readable step. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const n = value / magnitude;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * Single-series bar chart of daily tokens (dataviz: one hue, no legend, thin bars
 * with rounded data-ends, 2px gaps, recessive axes, per-bar tooltip, table view).
 */
export function DailyTokensChart({ daily }: { daily: UsageSummary["daily"] }) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const totals = daily.map((d) => d.input_tokens + d.output_tokens);
  const max = niceMax(Math.max(0, ...totals));
  const H = 160;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          className="text-xs text-link hover:underline"
          aria-pressed={asTable}
        >
          {asTable ? "Show chart" : "Show as table"}
        </button>
      </div>
      {asTable ? (
        <table className="w-full text-sm">
          <caption className="sr-only">Tokens per day</caption>
          <thead className="text-left text-xs text-fg-muted">
            <tr className="border-b border-border">
              <th scope="col" className="py-1.5 font-medium">
                Date
              </th>
              <th scope="col" className="py-1.5 text-right font-medium">
                Input
              </th>
              <th scope="col" className="py-1.5 text-right font-medium">
                Output
              </th>
              <th scope="col" className="py-1.5 text-right font-medium">
                Runs
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border tabular">
            {daily.map((d) => (
              <tr key={d.date}>
                <td className="py-1.5 text-fg">{d.date}</td>
                <td className="py-1.5 text-right text-fg-muted">{formatNumber(d.input_tokens)}</td>
                <td className="py-1.5 text-right text-fg-muted">{formatNumber(d.output_tokens)}</td>
                <td className="py-1.5 text-right text-fg-muted">{d.runs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative flex gap-2" onMouseLeave={() => setActive(null)}>
          <div
            aria-hidden
            className="flex w-10 flex-col justify-between text-right text-2xs text-fg-subtle tabular"
            style={{ height: H }}
          >
            <span>{formatCompact(max)}</span>
            <span>{formatCompact(max / 2)}</span>
            <span>0</span>
          </div>
          <div className="relative flex-1">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 flex flex-col justify-between"
              style={{ height: H }}
            >
              <span className="border-t border-dashed border-border" />
              <span className="border-t border-dashed border-border" />
              <span className="border-t border-border-strong" />
            </div>
            <ul
              className="relative flex items-end gap-[2px]"
              style={{ height: H }}
              aria-label="Tokens per day"
            >
              {daily.map((d, i) => {
                const total = totals[i]!;
                const h = total > 0 ? Math.max(3, (total / max) * H) : 0;
                return (
                  <li key={d.date} className="flex h-full flex-1 items-end">
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onFocus={() => setActive(i)}
                      onBlur={() => setActive(null)}
                      aria-label={`${d.date}: ${formatNumber(total)} tokens, ${d.runs} runs`}
                      className="flex h-full w-full items-end justify-center rounded-xs focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <span
                        className={cn(
                          "w-full max-w-6 rounded-t-[4px] bg-chart-1 transition-opacity",
                          active !== null && active !== i && "opacity-45",
                        )}
                        style={{ height: h }}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
            <div
              aria-hidden
              className="mt-1.5 flex justify-between text-2xs text-fg-subtle tabular"
            >
              <span>{daily[0]?.date.slice(5)}</span>
              <span>{daily[daily.length - 1]?.date.slice(5)}</span>
            </div>
            {active !== null && daily[active] && (
              <div
                role="status"
                className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs shadow-md"
                style={{ left: `${((active + 0.5) / daily.length) * 100}%` }}
              >
                <p className="font-medium text-fg">{daily[active].date}</p>
                <p className="text-fg-muted tabular">
                  {formatNumber(daily[active].input_tokens)} in ·{" "}
                  {formatNumber(daily[active].output_tokens)} out
                </p>
                <p className="text-fg-muted">{daily[active].runs} runs</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
