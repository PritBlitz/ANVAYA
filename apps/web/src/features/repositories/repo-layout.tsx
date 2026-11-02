"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { BookOpen, Code2, Gauge, ListTodo, MessageSquareText, Search } from "lucide-react";
import type { ReactNode } from "react";
import { IndexingBadge } from "@/components/domain/badges";
import { Mono, Skeleton } from "@/components/ui/misc";
import { NavTabs } from "@/components/ui/tabs";
import { ErrorState } from "@/components/ui/states";
import { GitHubMark } from "@/components/brand";
import { useRepository } from "@/lib/api/queries";
import { useWorkspace } from "@/lib/workspace/context";
import { shortSha } from "@/lib/utils/format";
import { VisibilityIcon } from "./repositories-screen";

export function useRepoId(): string {
  return useParams<{ repoId: string }>().repoId;
}

export function RepoLayout({ children }: { children: ReactNode }) {
  const repoId = useRepoId();
  const { base } = useWorkspace();
  const repo = useRepository(repoId);
  const root = `${base}/repositories/${repoId}`;

  if (repo.isError) {
    return (
      <div className="py-16">
        <ErrorState error={repo.error} onRetry={() => repo.refetch()} />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-border bg-bg-subtle">
        <div className="mx-auto w-full max-w-[1600px] px-4 pt-5 sm:px-6 lg:px-8">
          <nav aria-label="Breadcrumb" className="mb-2 text-xs text-fg-muted">
            <Link href={`${base}/repositories`} className="hover:text-fg">
              Repositories
            </Link>
          </nav>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {repo.data ? (
              <>
                <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-fg">
                  <VisibilityIcon visibility={repo.data.visibility} />
                  <span>
                    <span className="font-normal text-fg-muted">{repo.data.owner}/</span>
                    {repo.data.name}
                  </span>
                </h1>
                <IndexingBadge status={repo.data.indexing_status} />
                {repo.data.latest_indexed_commit_sha && (
                  <Mono title={repo.data.latest_indexed_commit_sha}>
                    {repo.data.default_branch} @ {shortSha(repo.data.latest_indexed_commit_sha)}
                  </Mono>
                )}
                <a
                  href={`https://github.com/${repo.data.full_name}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ml-auto inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg"
                >
                  <GitHubMark className="size-3.5" /> View on GitHub
                </a>
              </>
            ) : (
              <Skeleton className="h-7 w-72" />
            )}
          </div>
          <NavTabs
            label="Repository sections"
            className="mt-4 border-b-0"
            tabs={[
              { href: root, label: "Overview", icon: <Gauge />, exact: true },
              { href: `${root}/code`, label: "Code", icon: <Code2 /> },
              { href: `${root}/search`, label: "Search", icon: <Search /> },
              { href: `${root}/ask`, label: "Ask", icon: <MessageSquareText /> },
              { href: `${root}/knowledge`, label: "Knowledge", icon: <BookOpen /> },
              { href: `${root}/tasks`, label: "Tasks", icon: <ListTodo /> },
            ]}
          />
        </div>
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}
