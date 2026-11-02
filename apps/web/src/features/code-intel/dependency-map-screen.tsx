"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, FileCode2, Network, Package, SearchX } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Card, CardHeader, Mono, SkeletonRows } from "@/components/ui/misc";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { useDependencyMap } from "@/lib/api/queries";
import type { DependencyEdge, DependencyMap, DependencyNode, Repository } from "@/lib/api/types";
import { codeHref } from "@/lib/code";
import { formatNumber, pluralize, shortSha } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { useWorkspace } from "@/lib/workspace/context";
import { RequireIndexed } from "@/features/repositories/not-indexed";
import { useRepoId } from "@/features/repositories/repo-layout";

type SortKey = "imported_by" | "imports" | "path";

const SORTS: Record<SortKey, (a: DependencyNode, b: DependencyNode) => number> = {
  imported_by: (a, b) => b.imported_by - a.imported_by || a.path.localeCompare(b.path),
  imports: (a, b) => b.imports - a.imports || a.path.localeCompare(b.path),
  path: (a, b) => a.path.localeCompare(b.path),
};

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3.5 py-2.5">
      <p className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">{label}</p>
      <p className="text-lg font-semibold text-fg tabular">{formatNumber(value)}</p>
    </div>
  );
}

function EdgeList({
  repo,
  map,
  edges,
  direction,
  onSelect,
}: {
  repo: Repository;
  map: DependencyMap;
  edges: DependencyEdge[];
  direction: "in" | "out";
  onSelect: (path: string) => void;
}) {
  const { base } = useWorkspace();
  if (edges.length === 0) {
    return (
      <p className="px-3.5 py-3 text-sm text-fg-muted">
        {direction === "in"
          ? "No file in scope imports this file."
          : "Imports no other file in the repository."}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {edges.map((e) => {
        const other = direction === "in" ? e.source : e.target;
        const node = map.nodes.find((n) => n.path === other);
        return (
          <li
            key={`${e.source}→${e.target}`}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2"
          >
            <button
              type="button"
              onClick={() => onSelect(other)}
              className="min-w-0 truncate text-left font-mono text-xs font-medium text-fg hover:text-link hover:underline"
            >
              {other}
            </button>
            {node && !node.in_scope && <Badge tone="neutral">outside scope</Badge>}
            <span className="ml-auto flex flex-wrap gap-1">
              {e.lines.slice(0, 6).map((line) => (
                <Link
                  key={line}
                  href={codeHref(
                    base,
                    repo.id,
                    e.source,
                    { start: line, end: line },
                    map.commit_sha,
                  )}
                  className="font-mono text-2xs text-fg-subtle hover:text-link hover:underline"
                  aria-label={`L${line}: import in ${e.source}`}
                >
                  L{line}
                </Link>
              ))}
              {e.lines.length > 6 && (
                <span className="text-2xs text-fg-subtle">+{e.lines.length - 6}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function FileFocus({
  repo,
  map,
  node,
  onSelect,
}: {
  repo: Repository;
  map: DependencyMap;
  node: DependencyNode;
  onSelect: (path: string) => void;
}) {
  const { base } = useWorkspace();
  const incoming = map.edges.filter((e) => e.target === node.path);
  const outgoing = map.edges.filter((e) => e.source === node.path);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <FileCode2 className="size-5 text-fg-subtle" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-mono text-sm font-semibold text-fg">{node.path}</h2>
            <p className="text-xs text-fg-muted">
              {node.language ?? "unknown language"} · {pluralize(node.line_count, "line")} ·{" "}
              {pluralize(node.symbol_count, "symbol")}
            </p>
          </div>
          <Button asChild size="sm" variant="secondary">
            <Link href={codeHref(base, repo.id, node.path, null, map.commit_sha)}>Open file</Link>
          </Button>
        </div>
      </Card>
      {/* Neighbourhood: importers → file → imports. */}
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_auto_1fr]">
        <Card className="overflow-hidden">
          <CardHeader title={`Imported by · ${incoming.length}`} />
          <EdgeList repo={repo} map={map} edges={incoming} direction="in" onSelect={onSelect} />
        </Card>
        <ArrowRight
          aria-hidden
          className="mx-auto hidden size-5 self-center text-fg-subtle lg:block"
        />
        <Card className="overflow-hidden">
          <CardHeader title={`Imports · ${outgoing.length}`} />
          <EdgeList repo={repo} map={map} edges={outgoing} direction="out" onSelect={onSelect} />
        </Card>
      </div>
    </div>
  );
}

function DependencyPanel({ repo }: { repo: Repository }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const scope = params.get("path") ?? "";
  const selected = params.get("file");
  const [draft, setDraft] = useState(scope);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("imported_by");
  const map = useDependencyMap(repo.id, scope);

  const set = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  const nodes = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (map.data?.nodes ?? [])
      .filter((n) => !f || n.path.toLowerCase().includes(f))
      .sort(SORTS[sort]);
  }, [map.data, filter, sort]);
  const maxDegree = Math.max(1, ...nodes.map((n) => n.imported_by));
  const focus = map.data?.nodes.find((n) => n.path === selected) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          set({ path: draft.trim().replace(/^\/+/, "") || null, file: null });
        }}
      >
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs font-medium text-fg-muted">
          Directory scope
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Whole repository (e.g. src/auth)"
            className="font-mono text-xs"
          />
        </label>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        {scope && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft("");
              set({ path: null, file: null });
            }}
          >
            Clear
          </Button>
        )}
      </form>

      {map.isPending ? (
        <SkeletonRows rows={8} label="Building dependency map" />
      ) : map.isError ? (
        <ErrorState error={map.error} onRetry={() => map.refetch()} />
      ) : (
        <>
          <div
            className="grid grid-cols-2 gap-3 md:grid-cols-4"
            aria-label="Dependency map summary"
          >
            <Stat label="Files" value={map.data.nodes.filter((n) => n.in_scope).length} />
            <Stat label="Internal imports" value={map.data.edges.length} />
            <Stat label="External packages" value={map.data.external.length} />
            <Stat label="Unresolved imports" value={map.data.unresolved_imports} />
          </div>
          {(map.data.truncated || map.data.limitations.length > 0) && (
            <InlineAlert tone="info" title="How this map was built">
              <ul className="list-disc pl-4">
                {map.data.truncated && (
                  <li>The graph was capped at 2,000 files and 5,000 edges.</li>
                )}
                {map.data.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </InlineAlert>
          )}

          {map.data.nodes.length === 0 ? (
            <EmptyState
              icon={<SearchX />}
              title="No source files in this scope"
              description="Only parsed source files appear. Excluded files never do."
            />
          ) : (
            <div className="grid gap-5 lg:grid-cols-[minmax(300px,420px)_1fr]">
              <Card className="flex min-w-0 flex-col overflow-hidden">
                <div className="flex gap-2 border-b border-border p-2">
                  <Input
                    aria-label="Filter files"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter files"
                    className="h-8 text-xs"
                  />
                  <Select
                    aria-label="Sort files"
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                    className="h-8 w-40 text-xs"
                  >
                    <option value="imported_by">Most imported</option>
                    <option value="imports">Most imports</option>
                    <option value="path">Path</option>
                  </Select>
                </div>
                <ul
                  className="max-h-[65vh] divide-y divide-border overflow-y-auto"
                  aria-label="Files"
                >
                  {nodes.map((n) => (
                    <li key={n.path}>
                      <button
                        type="button"
                        onClick={() => set({ file: n.path })}
                        aria-current={n.path === selected ? "true" : undefined}
                        className={cn(
                          "flex w-full min-w-0 flex-col gap-1 px-3 py-2 text-left hover:bg-bg-subtle",
                          n.path === selected && "bg-primary-soft hover:bg-primary-soft",
                          !n.in_scope && "opacity-90",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-fg">
                            {n.path}
                          </span>
                          {!n.in_scope && <Badge tone="neutral">outside</Badge>}
                        </span>
                        <span className="flex items-center gap-2 text-2xs text-fg-muted">
                          <span
                            aria-hidden
                            className="h-1 w-16 overflow-hidden rounded-full bg-surface-sunken"
                          >
                            <span
                              className="block h-full rounded-full bg-primary"
                              style={{ width: `${Math.round((n.imported_by / maxDegree) * 100)}%` }}
                            />
                          </span>
                          {n.imported_by} in · {n.imports} out · {n.symbol_count} symbols
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="border-t border-border px-3 py-1.5 text-2xs text-fg-subtle">
                  {pluralize(nodes.length, "file")} · commit{" "}
                  <Mono className="text-2xs" title={map.data.commit_sha}>
                    {shortSha(map.data.commit_sha)}
                  </Mono>
                </p>
              </Card>

              <div className="flex min-w-0 flex-col gap-5">
                {focus ? (
                  <FileFocus
                    repo={repo}
                    map={map.data}
                    node={focus}
                    onSelect={(p) => set({ file: p })}
                  />
                ) : (
                  <Card>
                    <EmptyState
                      icon={<Network />}
                      title="Module map"
                      description="Pick a file to see what imports it and what it imports, with links to each import line."
                    />
                  </Card>
                )}
                <Card className="overflow-hidden">
                  <CardHeader title={`External packages · ${map.data.external.length}`} />
                  {map.data.external.length === 0 ? (
                    <p className="px-3.5 py-3 text-sm text-fg-muted">
                      No external imports in scope.
                    </p>
                  ) : (
                    <ul className="flex flex-wrap gap-2 p-3.5" aria-label="External packages">
                      {map.data.external.map((x) => (
                        <li
                          key={x.name}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
                          title={`${x.count} imports from ${x.importer_count} files`}
                        >
                          <Package className="size-3.5 text-fg-subtle" />
                          <span className="font-mono text-fg">{x.name}</span>
                          <span className="text-fg-subtle">{x.importer_count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function DependencyMapScreen() {
  const repoId = useRepoId();
  return (
    <RequireIndexed repoId={repoId}>{(repo) => <DependencyPanel repo={repo} />}</RequireIndexed>
  );
}
