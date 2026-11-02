"use client";

import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  FileCode2,
  MessageSquareText,
  RotateCw,
} from "lucide-react";
import { useRef, useState } from "react";
import { AiBadge, ModeBadge } from "@/components/domain/badges";
import { RichText } from "@/components/domain/rich-text";
import { PageContainer } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Card, Mono, Skeleton } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/overlays";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { useFileContent } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type { Citation, QuestionAnswer, Repository } from "@/lib/api/types";
import { codeHref } from "@/lib/code";
import { useWorkspace } from "@/lib/workspace/context";
import { cn } from "@/lib/utils/cn";
import { formatDuration, formatNumber, lineRange, shortSha } from "@/lib/utils/format";
import { CodeView } from "@/features/code/code-view";
import { RequireIndexed } from "@/features/repositories/not-indexed";
import { useRepoId } from "@/features/repositories/repo-layout";

const EXAMPLES = [
  "Where is refresh token expiry handled?",
  "How are webhook signatures verified?",
  "What happens when a charge request fails?",
];

interface Exchange {
  id: number;
  question: string;
  status: "pending" | "done" | "error";
  answer?: QuestionAnswer;
  error?: unknown;
}

function CitationPreview({ repo, citation }: { repo: Repository; citation: Citation }) {
  const file = useFileContent(repo.id, citation.path, citation.commit_sha);
  if (file.isPending) return <Skeleton className="m-3 h-24" />;
  if (file.isError) return <p className="px-3 py-2 text-xs text-fg-muted">Preview unavailable.</p>;
  const lines = file.data.content.split("\n");
  const from = Math.max(1, citation.start_line - 2);
  const to = Math.min(lines.length, citation.end_line + 2);
  return (
    <CodeView
      content={lines.slice(from - 1, to).join("\n")}
      startLine={from}
      highlight={{ start: citation.start_line, end: citation.end_line }}
      maxHeight={260}
      label={`Cited lines from ${citation.path}`}
    />
  );
}

function CitationItem({
  repo,
  citation,
  index,
  open,
  onToggle,
}: {
  repo: Repository;
  citation: Citation;
  index: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { base } = useWorkspace();
  const stale = citation.commit_sha !== repo.latest_indexed_commit_sha;
  return (
    <li
      id={`citation-${index}`}
      className="overflow-hidden rounded-md border border-border bg-surface"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-xs bg-accent font-mono text-2xs font-semibold text-accent-fg">
          {index}
        </span>
        <Link
          href={codeHref(
            base,
            repo.id,
            citation.path,
            { start: citation.start_line, end: citation.end_line },
            citation.commit_sha,
          )}
          className="min-w-0 truncate font-mono text-xs text-fg hover:text-link hover:underline"
        >
          {citation.path}
        </Link>
        <Badge tone="accent">{lineRange(citation.start_line, citation.end_line)}</Badge>
        <Mono className="hidden text-2xs sm:inline" title={citation.content_hash}>
          @ {shortSha(citation.commit_sha)}
        </Mono>
        {stale && <Badge tone="warning">Older commit</Badge>}
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} lines for citation ${index}`}
          onClick={onToggle}
        >
          <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
        </Button>
      </div>
      {open && (
        <div className="border-t border-border">
          <CitationPreview repo={repo} citation={citation} />
        </div>
      )}
    </li>
  );
}

function AnswerCard({ repo, answer }: { repo: Repository; answer: QuestionAnswer }) {
  const [openCitations, setOpenCitations] = useState<Set<number>>(
    () => new Set(answer.citations.length ? [1] : []),
  );
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const toggle = (n: number) =>
    setOpenCitations((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  const grounded = answer.citations.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <AiBadge label="AI answer" />
        <ModeBadge mode={answer.mode} provider={answer.provider} model={answer.model} />
        {grounded ? (
          <Badge tone="success">{answer.citations.length} citations</Badge>
        ) : (
          <Badge tone="warning">No supporting evidence</Badge>
        )}
      </div>
      <RichText
        text={answer.answer}
        renderCitation={(n) =>
          n >= 1 && n <= answer.citations.length ? (
            <Tooltip
              content={`${answer.citations[n - 1]!.path} ${lineRange(answer.citations[n - 1]!.start_line, answer.citations[n - 1]!.end_line)}`}
            >
              <a
                href={`#citation-${n}`}
                onClick={() => setOpenCitations((prev) => new Set(prev).add(n))}
                className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-xs bg-accent px-1 align-text-top font-mono text-2xs font-semibold text-accent-fg no-underline hover:bg-highlight-border"
              >
                {n}
              </a>
            </Tooltip>
          ) : (
            <span className="text-fg-subtle">[{n}]</span>
          )
        }
      />
      {answer.limitations.length > 0 && (
        <InlineAlert tone="warning" icon={<AlertTriangle />} title="Evidence limitations">
          <ul className="list-disc pl-4">
            {answer.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </InlineAlert>
      )}
      {grounded && (
        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Sources
          </h3>
          <ol className="flex flex-col gap-2">
            {answer.citations.map((c, i) => (
              <CitationItem
                key={`${c.path}:${c.start_line}`}
                repo={repo}
                citation={c}
                index={i + 1}
                open={openCitations.has(i + 1)}
                onToggle={() => toggle(i + 1)}
              />
            ))}
          </ol>
        </div>
      )}
      <div>
        <button
          type="button"
          onClick={() => setShowDiagnostics((v) => !v)}
          aria-expanded={showDiagnostics}
          className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform", showDiagnostics && "rotate-180")}
          />{" "}
          Retrieval diagnostics
        </button>
        {showDiagnostics && (
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-surface-sunken px-3 py-2 font-mono text-2xs text-fg-muted sm:grid-cols-4">
            <div>
              <dt>chunks considered</dt>
              <dd className="text-fg">{formatNumber(answer.retrieval.chunks_considered)}</dd>
            </div>
            <div>
              <dt>chunks used</dt>
              <dd className="text-fg">{formatNumber(answer.retrieval.chunks_used)}</dd>
            </div>
            <div>
              <dt>evidence tokens</dt>
              <dd className="text-fg">{formatNumber(answer.retrieval.token_estimate)}</dd>
            </div>
            <div>
              <dt>latency</dt>
              <dd className="text-fg">{formatDuration(answer.retrieval.latency_ms)}</dd>
            </div>
          </dl>
        )}
      </div>
    </div>
  );
}

function AskPanel({ repo }: { repo: Repository }) {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Exchange[]>([]);
  const nextId = useRef(1);
  const ask = useMutation({
    mutationFn: ({ q }: { q: string; id: number }) =>
      api.repositories.ask(repo.id, { question: q, snapshot: "latest" }),
    onSuccess: (answer, { id }) =>
      setHistory((h) => h.map((x) => (x.id === id ? { ...x, status: "done", answer } : x))),
    onError: (error, { id }) =>
      setHistory((h) => h.map((x) => (x.id === id ? { ...x, status: "error", error } : x))),
  });

  const submit = (q: string) => {
    const text = q.trim();
    if (text.length < 3 || ask.isPending) return;
    const id = nextId.current++;
    setHistory((h) => [{ id, question: text, status: "pending" }, ...h]);
    setQuestion("");
    ask.mutate({ q: text, id });
  };

  return (
    <PageContainer className="max-w-4xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(question);
        }}
        className="relative"
      >
        <label htmlFor="question" className="sr-only">
          Ask a question about {repo.full_name}
        </label>
        <Textarea
          id="question"
          rows={3}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit(question);
            }
          }}
          placeholder={`Ask about ${repo.name}… Answers cite indexed code at ${shortSha(repo.latest_indexed_commit_sha)}.`}
          className="resize-none pr-14 pb-10 text-base"
        />
        <div className="pointer-events-none absolute right-3 bottom-3 left-3 flex items-center justify-between">
          <span className="text-2xs text-fg-subtle">⌘/Ctrl + Enter to ask</span>
          <Button
            type="submit"
            size="icon"
            variant="primary"
            aria-label="Ask question"
            className="pointer-events-auto"
            disabled={question.trim().length < 3}
            loading={ask.isPending}
          >
            {!ask.isPending && <ArrowUp />}
          </Button>
        </div>
      </form>

      {history.length === 0 ? (
        <Card>
          <EmptyState
            icon={<MessageSquareText />}
            title="Grounded repository Q&A"
            description="Answers are built only from retrieved code and cite exact lines. When evidence is missing, Anvaya says so instead of guessing."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {EXAMPLES.map((ex) => (
                  <Button key={ex} size="sm" onClick={() => submit(ex)}>
                    {ex}
                  </Button>
                ))}
              </div>
            }
          />
        </Card>
      ) : (
        <ol className="flex flex-col gap-5" aria-label="Questions and answers" aria-live="polite">
          {history.map((x) => (
            <li key={x.id}>
              <Card className="overflow-hidden">
                <div className="flex items-start gap-3 border-b border-border bg-bg-subtle px-4 py-3">
                  <FileCode2 className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
                  <p className="font-medium text-fg">{x.question}</p>
                </div>
                <div className="p-4">
                  {x.status === "pending" && (
                    <div
                      role="status"
                      aria-label="Retrieving evidence and generating answer"
                      className="flex flex-col gap-2"
                    >
                      <p className="text-xs text-fg-muted">Retrieving evidence…</p>
                      <Skeleton className="h-3.5 w-[85%]" />
                      <Skeleton className="h-3.5 w-[70%]" />
                      <Skeleton className="h-3.5 w-[50%]" />
                    </div>
                  )}
                  {x.status === "done" && x.answer && <AnswerCard repo={repo} answer={x.answer} />}
                  {x.status === "error" && (
                    <div>
                      <ErrorState compact error={x.error} />
                      <div className="flex justify-center">
                        <Button size="sm" onClick={() => submit(x.question)}>
                          <RotateCw /> Ask again
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </PageContainer>
  );
}

export function AskScreen() {
  const repoId = useRepoId();
  return <RequireIndexed repoId={repoId}>{(repo) => <AskPanel repo={repo} />}</RequireIndexed>;
}
