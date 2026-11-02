import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

export type Tone =
  "neutral" | "primary" | "success" | "warning" | "danger" | "info" | "ai" | "accent";

const tones: Record<Tone, string> = {
  neutral: "bg-neutral-soft text-fg-muted border-border",
  primary: "bg-primary-soft text-primary-soft-fg border-primary/20",
  success: "bg-success-soft text-success border-success-border",
  warning: "bg-warning-soft text-warning border-warning-border",
  danger: "bg-danger-soft text-danger border-danger-border",
  info: "bg-info-soft text-info border-info-border",
  ai: "bg-ai-soft text-ai border-ai-border",
  accent: "bg-accent text-accent-fg border-transparent",
};

const dots: Record<Tone, string> = {
  neutral: "bg-fg-subtle",
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  ai: "bg-ai",
  accent: "bg-accent-fg",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  size?: "sm" | "md";
}

export function Badge({
  tone = "neutral",
  dot,
  pulse,
  size = "sm",
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-sm border font-medium whitespace-nowrap",
        size === "sm" ? "h-5 px-1.5 text-2xs" : "h-6 px-2 text-xs",
        tones[tone],
        className,
      )}
      {...props}
    >
      {dot && (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", dots[tone], pulse && "animate-pulse-dot")}
        />
      )}
      <span className="flex min-w-0 items-center gap-1 truncate [&_svg]:shrink-0">{children}</span>
    </span>
  );
}
