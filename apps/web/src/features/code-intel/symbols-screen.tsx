"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowDownLeft, ArrowUpRight, Braces, Search, SearchX } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, Mono, SkeletonRows } from "@/components/ui/misc";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { useFileContent, useSymbol, useSymbols } from "@/lib/api/queries";
import {
  SYMBOL_KINDS,
  type CodeSymbol,
  type Repository,
  type SymbolDetail,
  type SymbolKind,
} from "@/lib/api/types";
import { codeHref, splitLines } from "@/lib/code";
import { lineRange, pluralize, shortSha } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { useWorkspace } from "@/lib/workspace/context";
import { CodeView } from "@/features/code/code-view";
import { RequireIndexed } from "@/features/repositories/not-indexed";
import { useRepoId } from "@/features/repositories/repo-layout";
import { CallGraphPanel } from "./call-graph-panel";
import { INCOMING_LABEL, REFERENCE_LABEL, SymbolKindBadge } from "./symbol-kind";

const PREVIEW_MAX_LINES = 60;

function useSymbolsUrl() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const kinds = params
    .getAll("kind")
    .filter((k): k is SymbolKind => (SYMBOL_KINDS as readonly string[]).includes(k));
  const set = (patch: Record<string, string | string[] | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      q.delete(key);
      if (Array.isArray(value)) value.forEach((v) => q.append(key, v));
      else if (value) q.set(key, value);
    }
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };
  return {
    q: params.get("q") ?? "",
    path: params.get("path") ?? "",
    kinds,
    selected: params.get("symbol"),
    set,
  };
}

/** Group references by type, preserving the contract's order. */
function groupBy<X extends { type: string }>(items: X[]): [string, X[]][] {
  const map = new Map<string, X[]>();
  for (const item of items) map.set(item.type, [...(map.get(item.type) ?? []), item]);
  return [...map.entries()];
}

function SymbolPreview({ repo, symbol }: { repo: Repository; symbol: CodeSymbol }) {
  const file = useFileContent(repo.id, symbol.path, symbol.commit_sha);
  const snippet = useMemo(() => {
    if (!file.data) return null;
    const all = splitLines(file.data.content);
    const end = Math.min(symbol.end_line, symbol.start_line + PREVIEW_MAX_LINES - 1);
    return {
      content: all.slice(symbol.start_line - 1, end).join("\n"),
      clipped: symbol.end_line > end,
    };
  }, [file.data, symbol.start_line, symbol.end_line]);
  if (file.isPending) return <SkeletonRows rows={5} className="p-3" label="Loading source" />;
  if (file.isError) return <ErrorState compact error={file.error} onRetry={() => file.refetch()} />;
  return (
    <>
      <CodeView
        content={snippet?.content ?? ""}
        startLine={symbol.start_line}
        maxHeight={360}
        label={`Source of ${symbol.qualified_name}`}
        language={symbol.language}
      />
      {snippet?.clipped && (
        <p className="border-t border-border px-3.5 py-1.5 text-2xs text-fg-subtle">
          Showing the first {PREVIEW_MAX_LINES} of {symbol.end_line - symbol.start_line + 1} lines.
        </p>
      )}
    </>
  );
}

function ReferenceRow({
  repo,
  path,
  line,
  commitSha,
  label,
  symbol,
  name,
  onSelect,
}: {
  repo: Repository;
  path: string;
  line: number;
  commitSha: string;
  label: string;
  symbol: CodeSymbol | null;
  name: string;
  onSelect: (id: string) => void;
}) {
  const { base } = useWorkspace();
  return (
    <li className="flex min-w-0 items-center gap-2 px-3.5 py-2 text-sm">
      {symbol ? (
        <>
          <SymbolKindBadge kind={symbol.kind} compact />
          <button
            type="button"
            onClick={() => onSelect(symbol.id)}
            className="min-w-0 truncate text-left font-mono text-xs font-medium text-fg hover:text-link hover:underline"
            aria-label={`${label} ${symbol.qualified_name}`}
          >
            {symbol.qualified_name}
          </button>
        </>
      ) : (
        <>
          <span className="inline-flex w-9 justify-center text-2xs text-fg-subtle">ext</span>
          <span
            className="min-w-0 truncate font-mono text-xs text-fg-muted"
            title="External or unresolved"
          >
            {name}
          </span>
        </>
      )}
      <Link
        href={codeHref(base, repo.id, path, { start: line, end: line }, commitSha)}
        className="ml-auto shrink-0 font-mono text-2xs text-fg-subtle hover:text-link hover:underline"
      >
        {path.split("/").pop()}:{line}
      </Link>
    </li>
  );
}

function ReferenceSection({
  title,
  icon,
  empty,
  groups,
}: {
  title: string;
  icon: React.ReactNode;
  empty: string;
  groups: [string, React.ReactNode[]][];
}) {
  const total = groups.reduce((n, [, rows]) => n + rows.length, 0);
  return (
    <Card className="overflow-hidden">
      <h3 className="flex items-center gap-2 border-b border-border px-3.5 py-2 text-sm font-semibold text-fg [&_svg]:size-4 [&_svg]:text-fg-subtle">
        {icon} {title}
        <span className="font-normal text-fg-muted">· {total}</span>
      </h3>
      {total === 0 ? (
        <p className="px-3.5 py-3 text-sm text-fg-muted">{empty}</p>
      ) : (
        groups.map(([type, rows]) => (
          <div key={type}>
            <p className="bg-bg-subtle px-3.5 py-1 text-2xs font-semibold tracking-wide text-fg-muted uppercase">
              {type}
            </p>
            <ul className="divide-y divide-border">{rows}</ul>
          </div>
        ))
      )}
    </Card>
  );
}

function SymbolDetailPanel({
  repo,
  detail,
  onSelect,
}: {
  repo: Repository;
  detail: SymbolDetail;
  onSelect: (id: string) => void;
}) {
  const { base } = useWorkspace();
  const s = detail.symbol;
  const outgoing = groupBy(detail.outgoing).map(
    ([type, refs]) =>
      [
        REFERENCE_LABEL[type] ?? type,
        refs.map((r, i) => (
          <ReferenceRow
            key={`${r.line}-${r.target_name}-${i}`}
            repo={repo}
            path={s.path}
            line={r.line}
            commitSha={detail.commit_sha}
            label={REFERENCE_LABEL[type] ?? type}
            symbol={r.target}
            name={r.target_name}
            onSelect={onSelect}
          />
        )),
      ] as [string, React.ReactNode[]],
  );
  const incoming = groupBy(detail.incoming).map(
    ([type, refs]) =>
      [
        INCOMING_LABEL[type] ?? type,
        refs.map((r, i) => (
          <ReferenceRow
            key={`${r.source.id}-${r.line}-${i}`}
            repo={repo}
            path={r.source.path}
            line={r.line}
            commitSha={detail.commit_sha}
            label={INCOMING_LABEL[type] ?? type}
            symbol={r.source}
            name={r.source.name}
            onSelect={onSelect}
          />
        )),
      ] as [string, React.ReactNode[]],
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SymbolKindBadge kind={s.kind} />
          <h2 className="min-w-0 truncate font-mono text-base font-semibold text-fg">
            {s.qualified_name}
          </h2>
        </div>
        {s.signature && (
          <pre className="overflow-x-auto rounded-md bg-surface-sunken px-3 py-2 font-mono text-xs text-fg">
            {s.signature}
          </pre>
        )}
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
          <Link
            href={codeHref(
              base,
              repo.id,
              s.path,
              { start: s.start_line, end: s.end_line },
              s.commit_sha,
            )}
            className="font-mono text-link hover:underline"
          >
            {s.path} · {lineRange(s.start_line, s.end_line)}
          </Link>
          <span>
            · commit <Mono title={detail.commit_sha}>{shortSha(detail.commit_sha)}</Mono>
          </span>
          {s.language && <span>· {s.language}</span>}
        </p>
      </div>
      {detail.truncated && (
        <InlineAlert tone="info" title="References truncated">
          Only the first 200 references in each direction are shown.
        </InlineAlert>
      )}
      <Card className="overflow-hidden">
        <SymbolPreview repo={repo} symbol={s} />
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <ReferenceSection
          title="Uses"
          icon={<ArrowUpRight />}
          empty="This symbol doesn't reference other symbols."
          groups={outgoing}
        />
        <ReferenceSection
          title="Used by"
          icon={<ArrowDownLeft />}
          empty="Nothing in the indexed snapshot references this symbol."
          groups={incoming}
        />
      </div>
      <CallGraphPanel key={s.id} repo={repo} symbolId={s.id} onSelect={onSelect} />
    </div>
  );
}

function SymbolsPanel({ repo }: { repo: Repository }) {
  const url = useSymbolsUrl();
  const [draft, setDraft] = useState({ q: url.q, path: url.path });
  const params = useMemo(
    () => ({
      q: url.q || undefined,
      path: url.path || undefined,
      kind: url.kinds.length ? url.kinds : undefined,
    }),
    [url.q, url.path, url.kinds],
  );
  const symbols = useSymbols(repo.id, params);
  const detail = useSymbol(repo.id, url.selected);
  const items = useMemo(() => symbols.data?.pages.flatMap((p) => p.items) ?? [], [symbols.data]);

  const select = (id: string) => url.set({ symbol: id });
  const toggleKind = (kind: SymbolKind) =>
    url.set({
      kind: url.kinds.includes(kind) ? url.kinds.filter((k) => k !== kind) : [...url.kinds, kind],
      symbol: null,
    });

  return (
    <div className="mx-auto grid w-full max-w-[1600px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(280px,380px)_1fr] lg:px-8">
      <section aria-label="Symbols" className="flex min-w-0 flex-col gap-3">
        <form
          role="search"
          aria-label={`Search symbols in ${repo.full_name}`}
          onSubmit={(e) => {
            e.preventDefault();
            url.set({ q: draft.q.trim() || null, path: draft.path.trim() || null, symbol: null });
          }}
          className="flex flex-col gap-2"
        >
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input
              aria-label="Symbol name"
              value={draft.q}
              onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
              placeholder="Find a function, class, type…"
              className="pl-9"
            />
          </div>
          <div className="flex gap-2">
            <Input
              aria-label="Path or directory"
              value={draft.path}
              onChange={(e) => setDraft((d) => ({ ...d, path: e.target.value }))}
              placeholder="src/auth/"
              className="font-mono text-xs"
            />
            <Button type="submit" variant="secondary">
              Filter
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Symbol kinds">
            {SYMBOL_KINDS.map((k) => {
              const on = url.kinds.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleKind(k)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                    on
                      ? "border-primary bg-primary-soft text-primary-soft-fg"
                      : "border-border text-fg-muted hover:text-fg",
                  )}
                >
                  {k}
                </button>
              );
            })}
          </div>
        </form>

        <Card className="overflow-hidden" aria-busy={symbols.isFetching}>
          {symbols.isPending ? (
            <SkeletonRows rows={10} className="p-3" label="Loading symbols" />
          ) : symbols.isError ? (
            <ErrorState compact error={symbols.error} onRetry={() => symbols.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              compact
              icon={<SearchX />}
              title="No symbols match"
              description="Try a shorter name, another kind, or clear the path filter."
            />
          ) : (
            <>
              <ul
                className="max-h-[70vh] divide-y divide-border overflow-y-auto"
                aria-label="Symbol results"
              >
                {items.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => select(s.id)}
                      aria-current={s.id === url.selected ? "true" : undefined}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-bg-subtle",
                        s.id === url.selected && "bg-primary-soft hover:bg-primary-soft",
                      )}
                    >
                      <SymbolKindBadge kind={s.kind} compact />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs font-medium text-fg">
                          {s.qualified_name}
                        </span>
                        <span className="block truncate font-mono text-2xs text-fg-subtle">
                          {s.path}:{s.start_line}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-2xs text-fg-subtle">
                <span aria-live="polite">
                  {pluralize(items.length, "symbol")}
                  {symbols.hasNextPage ? " loaded" : ""} ·{" "}
                  {shortSha(repo.latest_indexed_commit_sha)}
                </span>
                {symbols.hasNextPage && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => symbols.fetchNextPage()}
                    loading={symbols.isFetchingNextPage}
                  >
                    Load more
                  </Button>
                )}
              </div>
            </>
          )}
        </Card>
      </section>

      <section aria-label="Symbol detail" className="min-w-0">
        {!url.selected ? (
          <EmptyState
            icon={<Braces />}
            title="Symbol explorer"
            description={`Pick a symbol to see its source, what it uses, and what uses it in ${repo.full_name} at ${shortSha(repo.latest_indexed_commit_sha)}.`}
          />
        ) : detail.isPending ? (
          <SkeletonRows rows={8} label="Loading symbol" />
        ) : detail.isError ? (
          <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
        ) : (
          <SymbolDetailPanel repo={repo} detail={detail.data} onSelect={select} />
        )}
      </section>
    </div>
  );
}

export function SymbolsScreen() {
  const repoId = useRepoId();
  return <RequireIndexed repoId={repoId}>{(repo) => <SymbolsPanel repo={repo} />}</RequireIndexed>;
}
