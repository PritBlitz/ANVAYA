"use client";

import { AlertTriangle, Lock, RotateCw, SearchX, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { describeError, isApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils/cn";
import { Button } from "./button";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-16",
        className,
      )}
    >
      {icon && (
        <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-fg-muted shadow-xs [&_svg]:size-5">
          {icon}
        </div>
      )}
      <div className="max-w-sm">
        <h3 className="text-base font-semibold text-fg">{title}</h3>
        {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      </div>
      {action && <div className="mt-1 flex items-center gap-2">{action}</div>}
    </div>
  );
}

/** Renders the right state for any failed query: offline, forbidden, not found, or generic. */
export function ErrorState({
  error,
  onRetry,
  className,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}) {
  const { title, description, requestId } = describeError(error);
  const icon = isApiError(error) ? (
    error.isNetwork ? (
      <WifiOff />
    ) : error.isForbidden ? (
      <Lock />
    ) : error.isNotFound ? (
      <SearchX />
    ) : (
      <AlertTriangle />
    )
  ) : (
    <AlertTriangle />
  );
  const retryable = !isApiError(error) || !(error.isForbidden || error.isNotFound);
  return (
    <div role="alert" className={className}>
      <EmptyState
        compact={compact}
        icon={icon}
        title={title}
        description={
          <>
            {description}
            {requestId && (
              <span className="mt-2 block font-mono text-2xs text-fg-subtle">
                Request ID: {requestId}
              </span>
            )}
          </>
        }
        action={
          onRetry && retryable ? (
            <Button size="sm" onClick={onRetry}>
              <RotateCw /> Try again
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

export function InlineAlert({
  tone = "info",
  title,
  children,
  icon,
  className,
  action,
}: {
  tone?: "info" | "warning" | "danger" | "success" | "ai";
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const tones = {
    info: "border-info-border bg-info-soft [&>svg]:text-info",
    warning: "border-warning-border bg-warning-soft [&>svg]:text-warning",
    danger: "border-danger-border bg-danger-soft [&>svg]:text-danger",
    success: "border-success-border bg-success-soft [&>svg]:text-success",
    ai: "border-ai-border bg-ai-soft [&>svg]:text-ai",
  };
  return (
    <div
      className={cn(
        "flex gap-3 rounded-lg border px-3.5 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
        tones[tone],
        className,
      )}
    >
      {icon}
      <div className="min-w-0 flex-1 text-fg">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && "mt-0.5")}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
