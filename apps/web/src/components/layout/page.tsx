import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/** Standard page frame: title row + content. Keeps spacing identical on every screen. */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}
    >
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-xs text-fg-muted">{eyebrow}</div>}
        <h1 className="truncate text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-fg-muted">{description}</p>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function PageContainer({
  children,
  className,
  wide,
}: {
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8",
        wide ? "max-w-[1600px]" : "max-w-6xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-2", className)}>
      <h2 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">{children}</h2>
      {action}
    </div>
  );
}

/** Key/value metadata list used in side panels. */
export function MetaList({
  items,
  className,
}: {
  items: { label: string; value: ReactNode }[];
  className?: string;
}) {
  return (
    <dl className={cn("grid grid-cols-[minmax(0,auto)_1fr] gap-x-4 gap-y-2 text-sm", className)}>
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-fg-muted">{item.label}</dt>
          <dd className="min-w-0 truncate text-right text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
