"use client";

import { DatabaseZap } from "lucide-react";
import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { SkeletonRows } from "@/components/ui/misc";
import { useRepository } from "@/lib/api/queries";
import type { Repository } from "@/lib/api/types";
import { indexingMeta, isQueryable } from "@/lib/domain/status";

/**
 * Renders children only once the repository has an indexed snapshot. Search, Q&A, and
 * code browsing all depend on one (FR-REP-001).
 */
export function RequireIndexed({
  repoId,
  children,
}: {
  repoId: string;
  children: (repo: Repository) => ReactNode;
}) {
  const repo = useRepository(repoId);
  if (repo.isPending) return <SkeletonRows rows={6} className="p-8" />;
  if (repo.isError) return <ErrorState error={repo.error} onRetry={() => repo.refetch()} />;
  if (!isQueryable(repo.data.indexing_status) || !repo.data.latest_indexed_commit_sha) {
    const meta = indexingMeta(repo.data.indexing_status);
    return (
      <EmptyState
        icon={meta.working ? <Spinner /> : <DatabaseZap />}
        title={meta.working ? "Indexing in progress" : "This repository isn't indexed yet"}
        description={
          meta.working
            ? "Search, code browsing, and Q&A unlock as soon as the first snapshot is ready. Progress is on the Overview tab."
            : "Start indexing from the Overview tab. Answers are only generated from indexed evidence."
        }
      />
    );
  }
  return <>{children(repo.data)}</>;
}
