"use client";

import { Command } from "cmdk";
import { Dialog as D } from "radix-ui";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { FolderGit2, ListTodo, Moon, Plus, PlugZap, Search, Sun } from "lucide-react";
import { useRepositories, useTasks } from "@/lib/api/queries";
import { useTheme } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace/context";
import { useNavItems } from "./sidebar";

function Item({
  children,
  onSelect,
  value,
  icon,
  hint,
}: {
  children: ReactNode;
  onSelect: () => void;
  value: string;
  icon?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-sm text-fg select-none data-[selected=true]:bg-surface-hover [&_svg]:size-4 [&_svg]:text-fg-muted"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-xs text-fg-subtle">{hint}</span>}
    </Command.Item>
  );
}

const groupClass =
  "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-subtle [&_[cmdk-group-heading]]:uppercase";

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { base, can } = useWorkspace();
  const nav = useNavItems();
  const repos = useRepositories();
  const tasks = useTasks();
  const { resolved, setPreference } = useTheme();
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  // Close when the route is hidden by Activity (Next.js "Preserving UI state").
  useEffect(() => () => onOpenChange(false), [onOpenChange]);

  const go = (href: string) => {
    onOpenChange(false);
    setQuery("");
    router.push(href);
  };

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 animate-fade-in bg-[hsl(340_20%_8%/0.35)]" />
        <D.Content
          aria-describedby={undefined}
          className="fixed top-[14vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 animate-pop-in overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lg"
        >
          <D.Title className="sr-only">Command palette</D.Title>
          <Command label="Command palette" loop>
            <div className="flex items-center gap-2 border-b border-border px-3.5">
              <Search className="size-4 text-fg-subtle" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search pages, repositories, tasks, actions…"
                className="h-12 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-subtle"
              />
            </div>
            <Command.List className="max-h-[50vh] scrollbar-thin overflow-y-auto p-1.5">
              <Command.Empty className="py-10 text-center text-sm text-fg-muted">
                No results for “{query}”.
              </Command.Empty>
              <Command.Group heading="Actions" className={groupClass}>
                {can("tasks.create") && (
                  <Item
                    value="create new engineering task"
                    icon={<Plus />}
                    onSelect={() => go(`${base}/tasks?new=1`)}
                  >
                    New engineering task
                  </Item>
                )}
                {can("repositories.manage") && (
                  <Item
                    value="connect repository github"
                    icon={<PlugZap />}
                    onSelect={() => go(`${base}/repositories/connect`)}
                  >
                    Connect a repository
                  </Item>
                )}
                <Item
                  value="toggle theme dark light"
                  icon={resolved === "dark" ? <Sun /> : <Moon />}
                  onSelect={() => {
                    setPreference(resolved === "dark" ? "light" : "dark");
                    onOpenChange(false);
                  }}
                >
                  Switch to {resolved === "dark" ? "light" : "dark"} theme
                </Item>
              </Command.Group>
              <Command.Group heading="Navigate" className={groupClass}>
                {nav.map((n) => (
                  <Item
                    key={n.href}
                    value={`go ${n.label}`}
                    icon={n.icon}
                    onSelect={() => go(n.href)}
                  >
                    {n.label}
                  </Item>
                ))}
              </Command.Group>
              {!!repos.data?.length && (
                <Command.Group heading="Repositories" className={groupClass}>
                  {repos.data.map((r) => (
                    <Item
                      key={r.id}
                      value={`repo ${r.full_name}`}
                      icon={<FolderGit2 />}
                      onSelect={() => go(`${base}/repositories/${r.id}`)}
                    >
                      {r.full_name}
                    </Item>
                  ))}
                  {query.length > 1 &&
                    repos.data
                      .filter(
                        (r) => r.indexing_status === "ready" || r.indexing_status === "partial",
                      )
                      .map((r) => (
                        <Item
                          key={`ask-${r.id}`}
                          value={`ask search ${r.full_name} ${query}`}
                          icon={<Search />}
                          hint={r.name}
                          onSelect={() =>
                            go(`${base}/repositories/${r.id}/search?q=${encodeURIComponent(query)}`)
                          }
                        >
                          Search “{query}”
                        </Item>
                      ))}
                </Command.Group>
              )}
              {!!tasks.data?.length && (
                <Command.Group heading="Tasks" className={groupClass}>
                  {tasks.data.slice(0, 20).map((t) => (
                    <Item
                      key={t.id}
                      value={`task ${t.title}`}
                      icon={<ListTodo />}
                      onSelect={() => go(`${base}/tasks/${t.id}`)}
                    >
                      {t.title}
                    </Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
