"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { FileCode2, FileX2, History, PanelLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Mono, SkeletonRows } from "@/components/ui/misc";
import { Dialog, DrawerContent } from "@/components/ui/overlays";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { isApiError } from "@/lib/api/errors";
import { useFileContent, useTreeLevels } from "@/lib/api/queries";
import type { TreeEntry } from "@/lib/api/types";
import type { Repository } from "@/lib/api/types";
import { formatLineParam, parseLineRange } from "@/lib/code";
import { formatBytes, lineRange, shortSha } from "@/lib/utils/format";
import { RequireIndexed } from "@/features/repositories/not-indexed";
import { useRepoId } from "@/features/repositories/repo-layout";
import { CodeView, CopyButton } from "./code-view";
import { FileTree } from "./file-tree";

function ancestorsOf(path: string | null): string[] {
  if (!path) return [];
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

function Explorer({ repo }: { repo: Repository }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const path = params.get("path");
  const range = parseLineRange(params.get("lines"));
  const commit = params.get("commit") ?? repo.latest_indexed_commit_sha;
  const stale = !!commit && commit !== repo.latest_indexed_commit_sha;
  const file = useFileContent(repo.id, path, commit);
  const [treeOpen, setTreeOpen] = useState(false);
  // Directory levels to load: the root, the ancestors of a deep-linked file, and any
  // directory the user expands. The backend lists one level per request.
  const [expandedDirs, setExpandedDirs] = useState<string[]>(() => ["", ...ancestorsOf(path)]);
  const levels = useTreeLevels(repo.id, expandedDirs);
  const root = levels[0]!;
  const entries = useMemo(() => {
    const byPath = new Map<string, TreeEntry[]>();
    expandedDirs.forEach((dir, i) => {
      const data = levels[i]?.data;
      if (data) byPath.set(dir, data.entries);
    });
    const attach = (list: TreeEntry[]): TreeEntry[] =>
      list.map((e) =>
        e.type === "directory" && byPath.has(e.path)
          ? { ...e, children: attach(byPath.get(e.path)!) }
          : e,
      );
    return attach(byPath.get("") ?? []);
  }, [expandedDirs, levels]);

  const navigate = (next: { path?: string; lines?: string | null }) => {
    const q = new URLSearchParams(params.toString());
    if (next.path !== undefined) {
      q.set("path", next.path);
      q.delete("lines");
    }
    if (next.lines === null) q.delete("lines");
    else if (next.lines) q.set("lines", next.lines);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  const treePanel = root.isPending ? (
    <SkeletonRows rows={10} className="p-3" label="Loading file tree" />
  ) : root.isError ? (
    <ErrorState compact error={root.error} onRetry={() => root.refetch()} />
  ) : (
    <FileTree
      entries={entries}
      selectedPath={path}
      onExpand={(dir) => setExpandedDirs((prev) => (prev.includes(dir) ? prev : [...prev, dir]))}
      onSelect={(p) => {
        navigate({ path: p });
        setTreeOpen(false);
      }}
    />
  );

  const permalink = () =>
    path
      ? `${window.location.origin}${pathname}?${new URLSearchParams({ path, commit: commit ?? "", ...(range ? { lines: formatLineParam(range) } : {}) }).toString()}`
      : "";

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] min-h-[480px] lg:h-[calc(100dvh-7.75rem)]">
      <aside
        aria-label="File tree"
        className="hidden w-72 shrink-0 scrollbar-thin overflow-y-auto border-r border-border bg-bg-subtle px-1.5 md:block"
      >
        {treePanel}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col" aria-label="File viewer">
        <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-3 py-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="Show files"
            onClick={() => setTreeOpen(true)}
          >
            <PanelLeft />
          </Button>
          {path ? (
            <>
              <span className="min-w-0 truncate font-mono text-sm text-fg">{path}</span>
              {range && <Badge tone="accent">{lineRange(range.start, range.end)}</Badge>}
              <Mono title={commit ?? undefined}>@ {shortSha(commit)}</Mono>
              {file.data && (
                <span className="hidden text-xs text-fg-subtle lg:inline">
                  {file.data.line_count} lines · {formatBytes(file.data.content.length)} ·{" "}
                  {file.data.language ?? "plain text"}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1">
                {range && (
                  <Button size="xs" variant="ghost" onClick={() => navigate({ lines: null })}>
                    Clear selection
                  </Button>
                )}
                <CopyButton value={permalink} label="Copy permalink" />
              </span>
            </>
          ) : (
            <span className="text-sm text-fg-muted">Select a file</span>
          )}
        </div>
        {stale && (
          <InlineAlert
            tone="warning"
            icon={<History />}
            className="m-3 mb-0"
            title="Viewing an older commit"
          >
            This citation refers to {shortSha(commit)}; the latest index is{" "}
            {shortSha(repo.latest_indexed_commit_sha)}. Lines may have moved since.
          </InlineAlert>
        )}
        <div className="min-h-0 flex-1">
          {!path ? (
            <EmptyState
              icon={<FileCode2 />}
              title="Browse the indexed snapshot"
              description={`Every file here is exactly as indexed at ${shortSha(repo.latest_indexed_commit_sha)}. Click a line number to share a precise range.`}
            />
          ) : file.isPending ? (
            <SkeletonRows rows={14} className="p-4" label="Loading file" />
          ) : file.isError ? (
            isApiError(file.error) && file.error.code === "FILE_EXCLUDED" ? (
              <EmptyState
                icon={<FileX2 />}
                title="Excluded from indexing"
                description={
                  file.error.message + " Its contents are never stored or sent to a model."
                }
              />
            ) : (
              <ErrorState error={file.error} onRetry={() => file.refetch()} />
            )
          ) : (
            <CodeView
              className="h-full"
              content={file.data.content}
              highlight={range}
              label={`Source of ${path}`}
              onLineClick={(n) => {
                const nextRange =
                  range && range.start === range.end && n > range.start
                    ? `${range.start}-${n}`
                    : `${n}`;
                navigate({ lines: nextRange });
              }}
            />
          )}
        </div>
      </section>
      <Dialog open={treeOpen} onOpenChange={setTreeOpen}>
        <DrawerContent
          title="Files"
          description={repo.full_name}
          className="right-auto left-0 max-w-xs border-r border-l-0"
        >
          <div className="px-1.5">{treePanel}</div>
        </DrawerContent>
      </Dialog>
    </div>
  );
}

export function CodeExplorerScreen() {
  const repoId = useRepoId();
  return <RequireIndexed repoId={repoId}>{(repo) => <Explorer repo={repo} />}</RequireIndexed>;
}
