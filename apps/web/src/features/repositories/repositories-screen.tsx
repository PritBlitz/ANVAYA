"use client";

import Link from "next/link";
import { FolderGit2, Globe, Lock, PlugZap, Building2 } from "lucide-react";
import { IndexingBadge } from "@/components/domain/badges";
import { PageContainer, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, Mono, SkeletonRows } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Tooltip } from "@/components/ui/overlays";
import { useRepositories } from "@/lib/api/queries";
import type { RepositoryVisibility } from "@/lib/api/types";
import { useWorkspace } from "@/lib/workspace/context";
import { formatRelative, shortSha } from "@/lib/utils/format";

export function VisibilityIcon({ visibility }: { visibility: RepositoryVisibility | null }) {
  const icon =
    visibility === "public" ? <Globe /> : visibility === "internal" ? <Building2 /> : <Lock />;
  return (
    <Tooltip
      content={
        visibility
          ? `${visibility[0]!.toUpperCase()}${visibility.slice(1)} repository`
          : "Unknown visibility"
      }
    >
      <span
        role="img"
        className="inline-flex text-fg-subtle [&_svg]:size-3.5"
        aria-label={`${visibility ?? "unknown"} repository`}
      >
        {icon}
      </span>
    </Tooltip>
  );
}

export function RepositoriesScreen() {
  const { base, can } = useWorkspace();
  const repos = useRepositories();

  const connect = can("repositories.manage") && (
    <Button asChild variant="primary">
      <Link href={`${base}/repositories/connect`}>
        <PlugZap /> Connect repository
      </Link>
    </Button>
  );

  return (
    <PageContainer>
      <PageHeader
        title="Repositories"
        description="Repositories are indexed by commit so every citation points at exact, reproducible lines."
        actions={connect}
      />
      <Card className="overflow-hidden">
        {repos.isPending ? (
          <div className="p-4">
            <SkeletonRows rows={3} label="Loading repositories" />
          </div>
        ) : repos.isError ? (
          <ErrorState error={repos.error} onRetry={() => repos.refetch()} />
        ) : repos.data.length === 0 ? (
          <EmptyState
            icon={<FolderGit2 />}
            title="No repositories connected"
            description="Install the Anvaya GitHub App on an account or organization, then choose which repositories to index."
            action={
              connect || (
                <p className="text-sm text-fg-muted">
                  Ask a workspace admin to connect a repository.
                </p>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Connected repositories</caption>
              <thead className="border-b border-border bg-bg-subtle text-left text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Repository
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Index
                  </th>
                  <th scope="col" className="hidden px-4 py-2 font-medium md:table-cell">
                    Indexed commit
                  </th>
                  <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">
                    Last indexed
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {repos.data.map((r) => (
                  <tr key={r.id} className="group relative hover:bg-surface-hover">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <VisibilityIcon visibility={r.visibility} />
                        <Link
                          href={`${base}/repositories/${r.id}`}
                          className="font-medium text-fg group-focus-within:underline after:absolute after:inset-0 focus-visible:outline-none"
                        >
                          {r.full_name}
                        </Link>
                      </div>
                      <p className="mt-0.5 pl-5.5 text-xs text-fg-muted">
                        {r.default_branch ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <IndexingBadge status={r.indexing_status} />
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <Mono title={r.latest_indexed_commit_sha ?? undefined}>
                        {shortSha(r.latest_indexed_commit_sha)}
                      </Mono>
                    </td>
                    <td className="hidden px-4 py-3 text-fg-muted sm:table-cell">
                      {formatRelative(r.indexed_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </PageContainer>
  );
}
