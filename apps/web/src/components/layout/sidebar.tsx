"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  BarChart3,
  BookOpen,
  Check,
  ChevronsUpDown,
  FolderGit2,
  LayoutDashboard,
  ListTodo,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AnvayaMark } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Kbd, Avatar } from "@/components/ui/misc";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { useMe, useRuns, useWorkspaces } from "@/lib/api/queries";
import { api, API_MODE, getFixtureControls } from "@/lib/api/runtime";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace/context";
import { cn } from "@/lib/utils/cn";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  exact?: boolean;
  badge?: ReactNode;
}

export function useNavItems(): NavItem[] {
  const { base } = useWorkspace();
  const pending = useRuns({ status: ["awaiting_plan_approval", "awaiting_pr_approval"] });
  const count = pending.data?.length ?? 0;
  return [
    { href: base, label: "Overview", icon: <LayoutDashboard />, exact: true },
    { href: `${base}/repositories`, label: "Repositories", icon: <FolderGit2 /> },
    { href: `${base}/knowledge`, label: "Knowledge", icon: <BookOpen /> },
    { href: `${base}/tasks`, label: "Tasks", icon: <ListTodo /> },
    { href: `${base}/runs`, label: "Runs", icon: <Activity /> },
    {
      href: `${base}/reviews`,
      label: "Reviews",
      icon: <ShieldCheck />,
      badge:
        count > 0 ? (
          <Badge tone="warning" aria-label={`${count} awaiting approval`}>
            {count}
          </Badge>
        ) : null,
    },
    { href: `${base}/usage`, label: "Usage", icon: <BarChart3 /> },
    { href: `${base}/settings`, label: "Settings", icon: <Settings /> },
  ];
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const items = useNavItems();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex h-8 items-center gap-2.5 rounded-md px-2 text-sm font-medium transition-colors [&>svg]:size-4 [&>svg]:shrink-0",
              active
                ? "bg-surface text-fg shadow-xs ring-1 ring-border [&>svg]:text-primary"
                : "text-fg-muted hover:bg-surface-hover hover:text-fg [&>svg]:text-fg-subtle group-hover:[&>svg]:text-fg-muted",
            )}
          >
            {item.icon}
            <span className="flex-1 truncate">{item.label}</span>
            {item.badge}
          </Link>
        );
      })}
    </nav>
  );
}

export function WorkspaceSwitcher() {
  const { workspace } = useWorkspace();
  const workspaces = useWorkspaces();
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">
        <AnvayaMark size={22} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-fg">{workspace.name}</span>
          <span className="block truncate text-2xs text-fg-muted capitalize">{workspace.role}</span>
          <span className="sr-only">, switch workspace</span>
        </span>
        <ChevronsUpDown className="size-3.5 text-fg-subtle" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.data?.map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => router.push(`/w/${w.slug}`)}>
            <span className="flex size-5 items-center justify-center rounded-sm bg-accent text-2xs font-semibold text-accent-fg">
              {w.name[0]?.toUpperCase()}
            </span>
            <span className="flex-1 truncate">{w.name}</span>
            {w.id === workspace.id && <Check className="!text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/onboarding")}>
          <Plus /> Create workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  { value: "light", label: "Light", icon: <Sun /> },
  { value: "dark", label: "Dark", icon: <Moon /> },
  { value: "system", label: "System", icon: <Monitor /> },
];

export function UserMenu() {
  const me = useMe();
  const { preference, setPreference } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const user = me.data?.user;
  const name = user?.display_name ?? user?.email ?? "Account";

  async function signOut() {
    try {
      await api.auth.logout();
    } catch {
      // Even if the server call fails, clear local state and leave.
    }
    queryClient.clear();
    router.replace("/login");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">
        <Avatar name={name} src={user?.avatar_url} size={22} />
        <span className="min-w-0 flex-1 truncate text-sm text-fg">
          {name}
          <span className="sr-only">, account menu</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="w-60">
        <DropdownMenuLabel className="normal-case">
          <span className="block truncate text-xs font-medium text-fg">{name}</span>
          <span className="block truncate font-normal tracking-normal">{user?.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {THEME_OPTIONS.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => setPreference(o.value)}>
            {o.icon}
            <span className="flex-1">{o.label}</span>
            {preference === o.value && <Check className="!text-primary" />}
          </DropdownMenuItem>
        ))}
        {API_MODE === "fixtures" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={async () => {
                const controls = await getFixtureControls();
                controls?.reset();
                controls?.signIn();
                queryClient.clear();
                router.replace("/app");
              }}
            >
              <Activity /> Reset development fixtures
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SearchTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-surface px-2 text-sm text-fg-subtle shadow-xs transition-colors hover:border-border-strong hover:text-fg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Search className="size-3.5" />
      <span className="flex-1 text-left">Jump to…</span>
      <Kbd>⌘K</Kbd>
    </button>
  );
}

export function FixtureModeNotice() {
  if (API_MODE !== "fixtures") return null;
  return (
    <div
      data-dev-notice
      className="rounded-md border border-dashed border-highlight-border bg-highlight px-2.5 py-2 text-2xs leading-snug text-accent-fg"
    >
      <span className="font-semibold">Development fixtures.</span> Data is simulated in your browser
      — no backend, GitHub, or model calls.
    </div>
  );
}
