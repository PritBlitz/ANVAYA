import { Check } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export const ONBOARDING_STEPS = [
  "Create workspace",
  "Connect GitHub",
  "Choose repositories",
  "Index",
] as const;

export function OnboardingSteps({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2" aria-label="Setup progress">
      {ONBOARDING_STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li
            key={label}
            className="flex items-center gap-2"
            aria-current={active ? "step" : undefined}
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full border text-2xs font-semibold",
                done && "border-primary bg-primary text-primary-fg",
                active && "border-primary text-primary",
                !done && !active && "border-border-strong text-fg-subtle",
              )}
            >
              {done ? <Check className="size-3" aria-hidden /> : i + 1}
            </span>
            <span className={cn("text-xs", active ? "font-medium text-fg" : "text-fg-muted")}>
              {label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
            {i < ONBOARDING_STEPS.length - 1 && (
              <span aria-hidden className="mx-1 h-px w-6 bg-border-strong" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
