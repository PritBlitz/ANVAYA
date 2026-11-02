import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border bg-surface-sunken px-1 font-mono text-2xs text-fg-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-shimmer rounded-md bg-[linear-gradient(90deg,var(--surface-sunken)_25%,var(--surface-hover)_37%,var(--surface-sunken)_63%)] bg-size-[400%_100%]",
        className,
      )}
    />
  );
}

const ROW_WIDTHS = ["w-[72%]", "w-[58%]", "w-[86%]", "w-[64%]", "w-[78%]", "w-[52%]"];

/** Generic loading placeholder for lists. Announced once to screen readers. */
export function SkeletonRows({
  rows = 5,
  className,
  label = "Loading",
}: {
  rows?: number;
  className?: string;
  label?: string;
}) {
  return (
    <div role="status" aria-label={label} className={cn("flex flex-col gap-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton className={cn("h-3.5", ROW_WIDTHS[i % ROW_WIDTHS.length])} />
        </div>
      ))}
    </div>
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-surface shadow-xs", className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
  as: Heading = "h2",
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  as?: "h2" | "h3";
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-border px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0">
        <Heading className="text-sm font-semibold text-fg">{title}</Heading>
        {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...props} />;
}

export function Progress({
  value,
  max = 100,
  label,
  className,
  tone = "primary",
}: {
  value: number;
  max?: number;
  label: string;
  className?: string;
  tone?: "primary" | "success" | "warning";
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken", className)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500 ease-out",
          tone === "primary" && "bg-primary",
          tone === "success" && "bg-success",
          tone === "warning" && "bg-warning",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      className={cn(vertical ? "h-4 w-px" : "h-px w-full", "bg-border", className)}
    />
  );
}

/** Monospace hash / SHA with optional truncation. Full value exposed via title. */
export function Mono({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn("font-mono text-xs tracking-tight text-fg-muted tabular", className)}
    >
      {children}
    </span>
  );
}

export function Avatar({
  name,
  src,
  size = 24,
  className,
}: {
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const initials = name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.4) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent font-semibold text-accent-fg ring-1 ring-border",
        className,
      )}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- avatars come from arbitrary provider hosts
        <img src={src} alt="" className="size-full object-cover" />
      ) : (
        initials
      )}
    </span>
  );
}
