"use client";

import { Dialog as D } from "radix-ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Menu, X } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { AnvayaMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useMe, useWorkspaces } from "@/lib/api/queries";
import { WorkspaceProvider } from "@/lib/workspace/context";
import { CommandPalette } from "./command-palette";
import {
  FixtureModeNotice,
  SearchTrigger,
  SidebarNav,
  UserMenu,
  WorkspaceSwitcher,
} from "./sidebar";

function SidebarBody({
  onOpenPalette,
  onNavigate,
}: {
  onOpenPalette: () => void;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <WorkspaceSwitcher />
      <SearchTrigger onOpen={onOpenPalette} />
      <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto">
        <SidebarNav onNavigate={onNavigate} />
      </div>
      <FixtureModeNotice />
      <UserMenu />
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

  return (
    <div className="flex h-dvh overflow-hidden bg-bg">
      <aside
        className="hidden w-60 shrink-0 border-r border-border bg-bg-subtle lg:block"
        aria-label="Sidebar"
      >
        <SidebarBody onOpenPalette={openPalette} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg-subtle px-3 lg:hidden">
          <D.Root open={mobileOpen} onOpenChange={setMobileOpen}>
            <D.Trigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open navigation">
                <Menu />
              </Button>
            </D.Trigger>
            <D.Portal>
              <D.Overlay className="fixed inset-0 z-50 animate-fade-in bg-[hsl(340_20%_8%/0.42)]" />
              <D.Content
                aria-describedby={undefined}
                className="fixed inset-y-0 left-0 z-50 w-72 border-r border-border bg-bg-subtle shadow-lg focus:outline-none"
              >
                <D.Title className="sr-only">Navigation</D.Title>
                <D.Close asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close navigation"
                    className="absolute top-4 right-2 z-10"
                  >
                    <X />
                  </Button>
                </D.Close>
                <SidebarBody
                  onOpenPalette={() => {
                    setMobileOpen(false);
                    openPalette();
                  }}
                  onNavigate={() => setMobileOpen(false)}
                />
              </D.Content>
            </D.Portal>
          </D.Root>
          <AnvayaMark size={22} />
          <span className="font-display text-lg text-fg">Anvaya</span>
        </div>
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto focus:outline-none">
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

export function ShellSkeleton() {
  return (
    <div className="flex h-dvh bg-bg" role="status" aria-label="Loading workspace">
      <div className="hidden w-60 shrink-0 flex-col gap-3 border-r border-border bg-bg-subtle p-3 lg:flex">
        <Skeleton className="h-10" />
        <Skeleton className="h-8" />
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-7" />
        ))}
      </div>
      <div className="flex-1 p-8">
        <Skeleton className="mb-3 h-7 w-64" />
        <Skeleton className="mb-8 h-4 w-96 max-w-full" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}

/**
 * Resolves the session and the workspace named in the URL. Every workspace route
 * renders inside this gate, so screens can assume an authenticated member.
 */
export function WorkspaceGate({ children }: { children: ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const me = useMe();
  const workspaces = useWorkspaces({ enabled: me.isSuccess });

  if (me.isPending || (me.isSuccess && workspaces.isPending)) return <ShellSkeleton />;
  if (me.isError) {
    // 401 is handled globally (redirect to /login). Show other failures here.
    return (
      <div className="flex h-dvh items-center justify-center">
        <ErrorState error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  }
  if (workspaces.isError) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <ErrorState error={workspaces.error} onRetry={() => workspaces.refetch()} />
      </div>
    );
  }
  const workspace = workspaces.data?.find((w) => w.slug === slug);
  if (!workspace) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <EmptyState
          icon={<AnvayaMark />}
          title="Workspace not found"
          description="It doesn't exist, or you're not a member. Ask a workspace admin for an invitation."
          action={
            <Button asChild variant="primary">
              <Link href="/app">Go to my workspaces</Link>
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <WorkspaceProvider workspace={workspace}>
      <Shell>{children}</Shell>
    </WorkspaceProvider>
  );
}
