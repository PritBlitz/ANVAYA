import { Check, CircleDashed, Hand, Minus, X } from "lucide-react";
import { RUN_PHASES, type PhaseState } from "@/lib/domain/status";
import { cn } from "@/lib/utils/cn";

const STATE_LABEL: Record<PhaseState, string> = {
  done: "completed",
  current: "in progress",
  waiting: "waiting for your decision",
  upcoming: "not started",
  failed: "failed",
  skipped: "skipped",
};

export function RunStepper({ states }: { states: PhaseState[] }) {
  return (
    <ol
      className="flex w-full scrollbar-thin items-center overflow-x-auto pb-1"
      aria-label="Run progress"
    >
      {RUN_PHASES.map((phase, i) => {
        const s = states[i] ?? "upcoming";
        return (
          <li
            key={phase.key}
            className="flex min-w-0 flex-1 items-center gap-2 last:flex-none"
            aria-current={s === "current" || s === "waiting" ? "step" : undefined}
          >
            <span className="flex shrink-0 items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "flex size-6 items-center justify-center rounded-full border text-2xs [&_svg]:size-3.5",
                  s === "done" && "border-success bg-success text-white dark:text-fg-inverse",
                  s === "current" && "border-info bg-info-soft text-info",
                  s === "waiting" && "border-warning bg-warning-soft text-warning",
                  s === "failed" && "border-danger bg-danger text-white dark:text-fg-inverse",
                  s === "skipped" && "border-border-strong bg-neutral-soft text-fg-subtle",
                  s === "upcoming" && "border-border-strong text-fg-subtle",
                )}
              >
                {s === "done" ? (
                  <Check />
                ) : s === "failed" ? (
                  <X />
                ) : s === "waiting" ? (
                  <Hand />
                ) : s === "skipped" ? (
                  <Minus />
                ) : s === "current" ? (
                  <CircleDashed className="animate-spin [animation-duration:3s]" />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={cn(
                  "text-xs whitespace-nowrap",
                  s === "upcoming" || s === "skipped" ? "text-fg-subtle" : "font-medium text-fg",
                )}
              >
                {phase.label}
                <span className="sr-only">: {STATE_LABEL[s]}</span>
              </span>
            </span>
            {i < RUN_PHASES.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "mx-2 h-px min-w-4 flex-1",
                  s === "done" ? "bg-success/50" : "bg-border-strong",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
