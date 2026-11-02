"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, Search, SearchX } from "lucide-react";
import { useMemo, useState } from "react";
import { PageContainer } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Card, Mono, SkeletonRows } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/overlays";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useIndexStatus, useSearch } from "@/lib/api/queries";
import type { Repository, SearchRequest, SearchResult } from "@/lib/api/types";
import { codeHref, highlightTerms } from "@/lib/code";
import { useWorkspace } from "@/lib/workspace/context";
import { lineRange, shortSha } from "@/lib/utils/format";
import { CodeView } from "@/features/code/code-view";
import { RequireIndexed } from "@/features/repositories/not-indexed";
import { useRepoId } from "@/features/repositories/repo-layout";

function ScoreMeter({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  return (
    <Tooltip content={`${label} score: ${value.toFixed(2)}`}>
      <span
        className="inline-flex items-center gap-1.5 text-2xs text-fg-subtle"
        aria-label={`${label} score ${value.toFixed(2)}`}
      >
        {label}
        <span aria-hidden className="h-1 w-10 overflow-hidden rounded-full bg-surface-sunken">
          <span
            className="block h-full rounded-full bg-fg-subtle"
            style={{ width: `${Math.round(value * 100)}%` }}
          />
        </span>
      </span>
    </Tooltip>
  );
}

function ResultCard({
  result,
  repo,
  terms,
}: {
  result: SearchResult;
  repo: Repository;
  terms: string[];
}) {
  const { base } = useWorkspace();
  const href = codeHref(
    base,
    repo.id,
    result.file_path,
    { start: result.start_line, end: result.end_line },
    result.commit_sha,
  );
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3.5 py-2">
        <Link
          href={href}
          className="min-w-0 truncate font-mono text-sm font-medium text-fg hover:text-link hover:underline"
        >
          {result.file_path}
        </Link>
        <Badge tone="accent">{lineRange(result.start_line, result.end_line)}</Badge>
        {result.symbol_name && <Mono className="text-fg">{result.symbol_name}</Mono>}
        <span className="ml-auto flex items-center gap-3">
          <ScoreMeter label="Lexical" value={result.lexical_score} />
          <ScoreMeter label="Semantic" value={result.semantic_score} />
        </span>
      </div>
      <CodeView
        content={result.snippet}
        startLine={result.start_line}
        terms={terms}
        maxHeight={240}
        label={`Snippet from ${result.file_path}`}
        language={result.language}
      />
      <div className="flex items-center justify-between gap-3 border-t border-border px-3.5 py-1.5 text-2xs text-fg-subtle">
        <span className="truncate">
          commit <Mono className="text-2xs">{shortSha(result.commit_sha)}</Mono> ·{" "}
          <Mono className="text-2xs" title={result.content_hash}>
            {result.content_hash.slice(0, 19)}
          </Mono>
        </span>
        <Link
          href={href}
          className="inline-flex shrink-0 items-center gap-1 text-link hover:underline"
        >
          Open at commit <ArrowUpRight className="size-3" />
        </Link>
      </div>
    </Card>
  );
}

function SearchPanel({ repo }: { repo: Repository }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const status = useIndexStatus(repo.id);
  const q = params.get("q") ?? "";
  const language = params.get("lang") ?? "";
  const pathPrefix = params.get("path") ?? "";
  const [draft, setDraft] = useState({ q, language, pathPrefix });

  const request: SearchRequest | null = useMemo(
    () =>
      q.trim().length >= 2
        ? {
            query: q.trim(),
            snapshot: "latest",
            top_k: 8,
            filters: {
              ...(language ? { languages: [language] } : {}),
              ...(pathPrefix ? { paths: [pathPrefix] } : {}),
            },
          }
        : null,
    [q, language, pathPrefix],
  );
  const search = useSearch(repo.id, request);
  const terms = useMemo(() => highlightTerms(q), [q]);
  const latency = search.data?.latency_ms ?? null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    if (draft.q.trim()) next.set("q", draft.q.trim());
    if (draft.language) next.set("lang", draft.language);
    if (draft.pathPrefix.trim()) next.set("path", draft.pathPrefix.trim());
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  return (
    <PageContainer wide className="max-w-5xl">
      <form
        onSubmit={submit}
        role="search"
        aria-label={`Search ${repo.full_name}`}
        className="flex flex-col gap-3"
      >
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input
              aria-label="Search query"
              value={draft.q}
              onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
              placeholder="Where is refresh token expiry handled?"
              className="h-10 pl-9 text-base"
              autoFocus={!q}
            />
          </div>
          <Button type="submit" variant="primary" size="lg" disabled={draft.q.trim().length < 2}>
            Search
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
          <Field label="Language">
            <Select
              value={draft.language}
              onChange={(e) => setDraft((d) => ({ ...d, language: e.target.value }))}
            >
              <option value="">All languages</option>
              {status.data?.languages.map((l) => (
                <option key={l.language} value={l.language}>
                  {l.language}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Path prefix">
            <Input
              value={draft.pathPrefix}
              onChange={(e) => setDraft((d) => ({ ...d, pathPrefix: e.target.value }))}
              placeholder="src/auth/"
              className="font-mono text-xs"
            />
          </Field>
        </div>
      </form>

      <section
        aria-label="Search results"
        aria-busy={search.isFetching}
        className="flex flex-col gap-3"
      >
        {!request ? (
          <EmptyState
            icon={<Search />}
            title="Hybrid code search"
            description={`Combines full-text and semantic retrieval over ${repo.full_name} at ${shortSha(repo.latest_indexed_commit_sha)}. Every result cites path, lines, commit, and content hash.`}
          />
        ) : search.isPending ? (
          <SkeletonRows rows={6} label="Searching" />
        ) : search.isError ? (
          <ErrorState error={search.error} onRetry={() => search.refetch()} />
        ) : search.data.results.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title="No matching code"
            description="Try different terms, remove filters, or ask a question on the Ask tab."
          />
        ) : (
          <>
            <p className="text-xs text-fg-muted" aria-live="polite">
              {search.data.results.length} results
              {latency !== null ? ` · ${latency} ms retrieval` : ""} · snapshot{" "}
              {shortSha(repo.latest_indexed_commit_sha)}
            </p>
            {search.data.results.map((r) => (
              <ResultCard
                key={`${r.file_path}:${r.start_line}`}
                result={r}
                repo={repo}
                terms={terms}
              />
            ))}
          </>
        )}
      </section>
    </PageContainer>
  );
}

export function SearchScreen() {
  const repoId = useRepoId();
  const q = useSearchParams().get("q") ?? "";
  // Re-key on the URL query so the form reflects deep links (e.g. from ⌘K) even when
  // the page was preserved in the background by Activity.
  return (
    <RequireIndexed repoId={repoId}>{(repo) => <SearchPanel key={q} repo={repo} />}</RequireIndexed>
  );
}
