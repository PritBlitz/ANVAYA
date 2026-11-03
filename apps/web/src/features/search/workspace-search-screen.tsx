"use client";

import { useMutation } from "@tanstack/react-query";
import { BookOpen, FileCode2, MessageSquareText, Search, SearchX } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PageContainer, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Card, CardBody, Mono } from "@/components/ui/misc";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { useAiPolicy, useRepositories } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type {
  InferenceMode,
  WorkspaceAnswer,
  WorkspaceSearchResponse,
  WorkspaceSearchResult,
} from "@/lib/api/types";
import { codeHref } from "@/lib/code";
import { lineRange, shortSha } from "@/lib/utils/format";
import { useWorkspace } from "@/lib/workspace/context";

/** Groups results per repository, keeping the global ranking order inside each group. */
export function groupByRepository(results: WorkspaceSearchResult[]) {
  const groups = new Map<string, { name: string; items: WorkspaceSearchResult[] }>();
  for (const r of results) {
    const g = groups.get(r.repository_id) ?? { name: r.repository_full_name, items: [] };
    g.items.push(r);
    groups.set(r.repository_id, g);
  }
  return [...groups.entries()].map(([id, g]) => ({ id, ...g }));
}

function ResultItem({ r }: { r: WorkspaceSearchResult }) {
  const { base } = useWorkspace();
  const href =
    r.source === "code" && r.path
      ? codeHref(
          base,
          r.repository_id,
          r.path,
          { start: r.start_line, end: r.end_line },
          r.commit_sha,
        )
      : `${base}/repositories/${r.repository_id}/knowledge`;
  return (
    <li className="px-4 py-3" data-testid="workspace-result">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {r.source === "code" ? (
          <FileCode2 className="size-4 text-fg-subtle" />
        ) : (
          <BookOpen className="size-4 text-fg-subtle" />
        )}
        <Badge tone="neutral" title="Repository this result comes from">
          {r.repository_full_name}
        </Badge>
        <Link href={href} className="font-mono text-link hover:underline">
          {r.source === "code" ? `${r.path} · ${lineRange(r.start_line, r.end_line)}` : r.title}
        </Link>
        {r.symbol && <Mono className="text-xs text-fg-muted">{r.symbol}</Mono>}
        {r.commit_sha && (
          <span className="text-xs text-fg-subtle">
            @ <Mono title={r.commit_sha}>{shortSha(r.commit_sha)}</Mono>
          </span>
        )}
      </div>
      <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap text-fg">
        {r.snippet}
      </pre>
    </li>
  );
}

function SearchResults({ data }: { data: WorkspaceSearchResponse }) {
  if (data.results.length === 0)
    return (
      <EmptyState
        icon={<SearchX />}
        title="No matches in any indexed repository"
        description="Try a function, file or concept name that appears in the code."
      />
    );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-fg-muted">
        {data.results.length} results from {data.retrieval.repositories_searched} repositories ·{" "}
        {data.retrieval.mode} retrieval
      </p>
      {data.limitations.map((l) => (
        <InlineAlert key={l} tone="info" title="Limitation">
          {l}
        </InlineAlert>
      ))}
      {groupByRepository(data.results).map((g) => (
        <Card key={g.id} className="overflow-hidden">
          <div className="border-b border-border px-4 py-2 text-sm font-semibold">{g.name}</div>
          <ul className="divide-y divide-border">
            {g.items.map((r, i) => (
              <ResultItem key={`${r.path ?? r.knowledge_document_id}-${r.start_line}-${i}`} r={r} />
            ))}
          </ul>
        </Card>
      ))}
      {data.skipped_repositories.length > 0 && (
        <p className="text-xs text-fg-muted">
          Not searched:{" "}
          {data.skipped_repositories.map((s) => `${s.full_name} (${s.reason})`).join(", ")}
        </p>
      )}
    </div>
  );
}

function AnswerView({ data }: { data: WorkspaceAnswer }) {
  return (
    <div className="flex flex-col gap-4" data-testid="workspace-answer">
      <Card>
        <CardBody className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="ai">AI answer</Badge>
            {data.insufficient_evidence && <Badge tone="warning">Insufficient evidence</Badge>}
            <span className="text-xs text-fg-muted">
              {data.mode} · {data.provider ?? "no model call"} {data.model ? `· ${data.model}` : ""}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-fg">{data.answer}</p>
          {data.data_disclosure && (
            <p className="text-xs text-warning">
              Sent to hosted provider {data.data_disclosure.provider}:{" "}
              {data.data_disclosure.data_categories.join(", ")}
            </p>
          )}
          {data.limitations.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-fg-muted">
              {data.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      {data.citations.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-2 text-sm font-semibold">
            Citations · {data.citations.length}
          </div>
          <ul className="divide-y divide-border">
            {data.citations.map((c) => (
              <ResultItem key={c.evidence_id} r={c} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Workspace-wide search and grounded Q&A across every repository the caller can access. */
export function WorkspaceSearchScreen() {
  const { workspaceId } = useWorkspace();
  const repos = useRepositories();
  const policy = useAiPolicy();
  const [tab, setTab] = useState<"search" | "ask">("search");
  const [query, setQuery] = useState("");
  const [question, setQuestion] = useState("");
  const [repoFilter, setRepoFilter] = useState("");
  const [mode, setMode] = useState<InferenceMode | "">("");
  const search = useMutation({
    mutationFn: (q: string) =>
      api.workspaceKnowledge.search(workspaceId, {
        query: q,
        ...(repoFilter ? { repository_ids: [repoFilter] } : {}),
      }),
  });
  const ask = useMutation({
    mutationFn: (q: string) =>
      api.workspaceKnowledge.ask(workspaceId, {
        question: q,
        ...(mode ? { mode } : {}),
        ...(repoFilter ? { repository_ids: [repoFilter] } : {}),
      }),
  });
  const connected = (repos.data ?? []).filter((r) => r.status === "connected");
  return (
    <PageContainer>
      <PageHeader
        title="Workspace search"
        description="Search and ask across every indexed repository in this workspace. Each result shows the repository and commit it comes from."
      />
      <div role="tablist" aria-label="Search mode" className="mb-4 flex gap-2">
        <Button
          role="tab"
          aria-selected={tab === "search"}
          variant={tab === "search" ? "primary" : "ghost"}
          size="sm"
          onClick={() => setTab("search")}
        >
          <Search /> Search
        </Button>
        <Button
          role="tab"
          aria-selected={tab === "ask"}
          variant={tab === "ask" ? "primary" : "ghost"}
          size="sm"
          onClick={() => setTab("ask")}
        >
          <MessageSquareText /> Ask
        </Button>
      </div>
      <Card className="mb-6">
        <CardBody>
          <form
            className="grid gap-4 sm:grid-cols-[1fr_220px_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (tab === "search" && query.trim().length >= 2) search.mutate(query.trim());
              if (tab === "ask" && question.trim().length >= 3) ask.mutate(question.trim());
            }}
          >
            {tab === "search" ? (
              <Field label="Search all repositories">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="refresh token"
                />
              </Field>
            ) : (
              <Field label="Question" hint="Answered only from indexed evidence, with citations.">
                <Textarea
                  rows={2}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Where are expired tokens refreshed?"
                />
              </Field>
            )}
            <Field label="Repositories">
              <Select value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)}>
                <option value="">All ({connected.length})</option>
                {connected.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.full_name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex gap-2">
              {tab === "ask" && policy.data && (
                <Select
                  aria-label="Inference mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as InferenceMode | "")}
                  className="w-32"
                >
                  <option value="">Default ({policy.data.default_mode})</option>
                  {policy.data.allowed_modes.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              )}
              <Button
                type="submit"
                variant="primary"
                loading={tab === "search" ? search.isPending : ask.isPending}
              >
                {tab === "search" ? "Search" : "Ask"}
              </Button>
            </div>
          </form>
          {tab === "ask" && mode === "cloud" && policy.data?.cloud.enabled && (
            <p className="mt-2 text-xs text-warning">
              Cloud mode sends retrieved {policy.data.cloud.data_categories.join(", ")} to{" "}
              {policy.data.cloud.provider}.
            </p>
          )}
        </CardBody>
      </Card>
      {tab === "search" ? (
        search.isError ? (
          <ErrorState error={search.error} onRetry={() => search.mutate(query.trim())} />
        ) : search.data ? (
          <SearchResults data={search.data} />
        ) : null
      ) : ask.isError ? (
        <ErrorState error={ask.error} onRetry={() => ask.mutate(question.trim())} />
      ) : ask.data ? (
        <AnswerView data={ask.data} />
      ) : null}
    </PageContainer>
  );
}
