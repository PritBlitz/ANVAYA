"use client";

import { Tabs as T } from "radix-ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export const Tabs = T.Root;
export const TabsContent = T.Content;

export function TabsList({ className, ...props }: ComponentPropsWithoutRef<typeof T.List>) {
  return (
    <T.List
      className={cn("flex items-center gap-1 border-b border-border", className)}
      {...props}
    />
  );
}

const tabClass =
  "relative -mb-px inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-sm font-medium text-fg-muted transition-colors hover:text-fg " +
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5";

export function TabsTrigger({ className, ...props }: ComponentPropsWithoutRef<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        tabClass,
        "data-[state=active]:border-primary data-[state=active]:text-fg",
        className,
      )}
      {...props}
    />
  );
}

export interface NavTab {
  href: string;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
  /** Match only the exact path (for index tabs). */
  exact?: boolean;
}

/** Route-backed tabs: each tab is a real URL so views are linkable and back/forward works. */
export function NavTabs({
  tabs,
  className,
  label,
}: {
  tabs: NavTab[];
  className?: string;
  label: string;
}) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={label}
      className={cn(
        "flex scrollbar-thin items-center gap-1 overflow-x-auto border-b border-border",
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(tabClass, "shrink-0", active && "border-primary text-fg")}
          >
            {tab.icon}
            {tab.label}
            {tab.badge}
          </Link>
        );
      })}
    </nav>
  );
}
