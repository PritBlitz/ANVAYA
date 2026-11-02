"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Check, ExternalLink, Lock, Search, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { GitHubMark } from "@/components/brand";
import { PageContainer, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, SkeletonRows } from "@/components/ui/misc";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { OnboardingSteps } from "@/features/onboarding/onboarding-steps";
import { qk, useAvailableRepositories, useInstallations } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type { AvailableRepository, GitInstallation } from "@/lib/api/types";
import { notifyError } from "@/lib/forms";
import { beginGitHubInstall, goToInstallUrl } from "@/lib/github-install";
import { useWorkspace } from "@/lib/workspace/context";
import { cn } from "@/lib/utils/cn";
import { VisibilityIcon } from "./repositories-screen";

/** What the GitHub App asks for and why (PRD §7.1: users review requested permissions). */
const PERMISSIONS = [
  { scope: "Metadata", access: "Read", why: "List repositories and default branches." },
  {
    scope: "Contents",
    access: "Read & write",
    why: "Snapshot code for indexing; push a branch only after you approve a PR.",
  },
  {
    scope: "Pull requests",
    access: "Read & write",
    why: "Open a pull request after explicit human approval.",
  },
  { scope: "Issues", access: "Read", why: "Import issues as engineering task context." },
];

function PermissionsList() {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {PERMISSIONS.map((p) => (
        <li key={p.scope} className="flex items-start gap-3 px-3.5 py-2.5 text-sm">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-fg">
              {p.scope} <span className="font-normal text-fg-muted">· {p.access}</span>
            </p>
            <p className="text-xs text-fg-muted">{p.why}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Fetch the server-issued install URL (GAP-14) and go to GitHub. */
function useStartInstall() {
  const { workspace } = useWorkspace();
  const router = useRouter();
  return useMutation({
    mutationFn: () => beginGitHubInstall({ id: workspace.id, slug: workspace.slug }),
    onSuccess: (url) => goToInstallUrl(url, router.push),
    onError: (e) => notifyError(e, "Couldn't start the GitHub installation"),
  });
}

function InstallCard() {
  const install = useStartInstall();
  return (
    <Card>
      <div className="grid gap-6 p-6 md:grid-cols-[1fr_1.1fr]">
        <div className="flex flex-col gap-4">
          <div className="flex size-11 items-center justify-center rounded-xl bg-fg text-fg-inverse">
            <GitHubMark className="size-6" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-fg">Install the Anvaya GitHub App</h2>
            <p className="mt-1 text-sm text-fg-muted">
              Choose an account or organization and the repositories Anvaya may access. Tokens are
              short-lived and minted per job; you can revoke access at any time.
            </p>
          </div>
          <Button
            variant="primary"
            size="lg"
            className="self-start"
            onClick={() => install.mutate()}
            loading={install.isPending}
          >
            <GitHubMark /> Install on GitHub <ExternalLink className="opacity-70" />
          </Button>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Requested permissions
          </h3>
          <PermissionsList />
        </div>
      </div>
    </Card>
  );
}

function RepositoryPicker({
  installation,
  onboarding,
}: {
  installation: GitInstallation;
  onboarding: boolean;
}) {
  const { base } = useWorkspace();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { workspaceId } = useWorkspace();
  const available = useAvailableRepositories(installation.id);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      (available.data ?? []).filter((r) =>
        r.full_name.toLowerCase().includes(filter.trim().toLowerCase()),
      ),
    [available.data, filter],
  );

  const connect = useMutation({
    mutationFn: async (repos: AvailableRepository[]) => {
      const connected = [];
      for (const [i, repo] of repos.entries()) {
        setProgress(`Connecting ${repo.full_name} (${i + 1}/${repos.length})…`);
        const registered = await api.repositories.register(
          {
            installation_id: installation.id,
            external_repository_id: repo.external_repository_id,
            index: true,
          },
          `register-${installation.id}-${repo.external_repository_id}`,
        );
        connected.push(registered);
      }
      return connected;
    },
    onSuccess: async (connected) => {
      await queryClient.invalidateQueries({ queryKey: qk.ws(workspaceId) });
      toast.success(
        `Indexing ${connected.length === 1 ? connected[0]!.full_name : `${connected.length} repositories`}`,
        {
          description: "Progress is shown on the repository page. You can keep working meanwhile.",
        },
      );
      router.push(
        connected.length === 1
          ? `${base}/repositories/${connected[0]!.id}`
          : `${base}/repositories`,
      );
    },
    onError: (error) => {
      setProgress(null);
      notifyError(error, "Couldn't connect repositories");
      void queryClient.invalidateQueries({ queryKey: qk.ws(workspaceId) });
    },
  });

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chosen = (available.data ?? []).filter((r) => selected.has(r.external_repository_id));

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <GitHubMark /> {installation.account_login}
            <Badge tone="success">Connected</Badge>
          </span>
        }
        description="Select the repositories to index. Only repositories granted to the GitHub App appear here."
      />
      <div className="border-b border-border p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <Input
            aria-label="Filter repositories"
            placeholder="Filter repositories…"
            className="pl-8"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>
      {available.isPending ? (
        <div className="p-4">
          <SkeletonRows rows={4} label="Loading repositories from GitHub" />
        </div>
      ) : available.isError ? (
        <ErrorState compact error={available.error} onRetry={() => available.refetch()} />
      ) : available.data.length === 0 ? (
        <EmptyState
          compact
          icon={<Check />}
          title="Every granted repository is connected"
          description="To add more, grant the GitHub App access to additional repositories on GitHub."
          action={
            <Button asChild size="sm">
              <Link href={`${base}/repositories`}>View repositories</Link>
            </Button>
          }
        />
      ) : (
        <fieldset>
          <legend className="sr-only">
            Repositories available from {installation.account_login}
          </legend>
          <ul className="max-h-[360px] scrollbar-thin divide-y divide-border overflow-y-auto">
            {filtered.map((repo) => {
              const checked = selected.has(repo.external_repository_id);
              return (
                <li key={repo.external_repository_id}>
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-surface-hover",
                      checked && "bg-surface-selected",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-(--primary)"
                      checked={checked}
                      onChange={() => toggle(repo.external_repository_id)}
                      disabled={connect.isPending}
                    />
                    <VisibilityIcon visibility={repo.visibility} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                      {repo.full_name}
                    </span>
                    <span className="text-xs text-fg-muted">{repo.default_branch}</span>
                  </label>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-fg-muted">
                No repositories match “{filter}”.
              </li>
            )}
          </ul>
        </fieldset>
      )}
      <div className="flex flex-col gap-3 border-t border-border bg-bg-subtle px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-fg-muted" aria-live="polite">
          {progress ??
            (chosen.length
              ? `${chosen.length} selected · indexing starts immediately`
              : "Nothing selected")}
        </p>
        <Button
          variant="primary"
          disabled={chosen.length === 0}
          loading={connect.isPending}
          onClick={() => connect.mutate(chosen)}
        >
          {onboarding
            ? "Connect and start indexing"
            : `Connect ${chosen.length || ""} ${chosen.length === 1 ? "repository" : "repositories"}`.replace(
                "  ",
                " ",
              )}
          <ArrowRight />
        </Button>
      </div>
    </Card>
  );
}

export function ConnectRepositoryScreen() {
  const install = useStartInstall();
  const { can, base } = useWorkspace();
  const params = useSearchParams();
  const onboarding = params.get("onboarding") === "1";
  const installations = useInstallations();
  const [selectedId, setSelectedId] = useState<string | null>(params.get("installation"));

  if (!can("repositories.manage")) {
    return (
      <PageContainer>
        <EmptyState
          icon={<Lock />}
          title="Admins connect repositories"
          description="Ask a workspace owner or admin to connect a repository."
        />
      </PageContainer>
    );
  }

  const list = installations.data ?? [];
  const active = list.find((i) => i.id === selectedId) ?? list[0] ?? null;
  const step = !list.length ? 1 : 2;

  return (
    <PageContainer className="max-w-3xl">
      {onboarding && <OnboardingSteps current={step} />}
      <PageHeader
        eyebrow={
          !onboarding && (
            <Link href={`${base}/repositories`} className="hover:text-fg">
              Repositories
            </Link>
          )
        }
        title="Connect a repository"
        description="Anvaya reads code at a specific commit, excludes secrets, dependencies, and generated files, and never runs your code outside an isolated sandbox."
      />
      {installations.isPending ? (
        <Card className="p-4">
          <SkeletonRows rows={3} />
        </Card>
      ) : installations.isError ? (
        <Card>
          <ErrorState error={installations.error} onRetry={() => installations.refetch()} />
        </Card>
      ) : !active ? (
        <InstallCard />
      ) : (
        <>
          {list.length > 1 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="GitHub installation">
              {list.map((i) => (
                <Button
                  key={i.id}
                  size="sm"
                  variant={i.id === active.id ? "primary" : "secondary"}
                  onClick={() => setSelectedId(i.id)}
                  aria-pressed={i.id === active.id}
                >
                  <GitHubMark /> {i.account_login}
                </Button>
              ))}
            </div>
          )}
          <RepositoryPicker key={active.id} installation={active} onboarding={onboarding} />
          <InlineAlert tone="info" icon={<GitHubMark />} title="Don't see a repository?">
            Grant the Anvaya GitHub App access to it on GitHub, then return here.{" "}
            <button
              type="button"
              className="font-medium text-link hover:underline"
              onClick={() => install.mutate()}
              disabled={install.isPending}
            >
              Add another account
            </button>
          </InlineAlert>
        </>
      )}
    </PageContainer>
  );
}
