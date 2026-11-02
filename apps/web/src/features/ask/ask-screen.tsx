"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUp,
  BookOpen,
  ChevronDown,
  FileCode2,
  History,
  MessageSquareText,
  RotateCw,
  Trash2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AiBadge, ModeBadge } from "@/components/domain/badges";
import { RichText } from "@/components/domain/rich-text";
import { PageContainer } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Card, Mono, Skeleton, SkeletonRows } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/overlays";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { qk, useFileContent, useKnowledgeDocument, useQuestionHistory } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type {
  Citation,
  CodeCitation,
  KnowledgeCitation,
  QuestionAnswer,
  Repository,
} from "@/lib/api/types";
import { codeHref, splitLines } from "@/lib/code";
import { notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { cn } from "@/lib/utils/cn";
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
  lineRange,
  shortSha,
} from "@/lib/utils/format";
import { CodeView } from "@/features/code/code-view";
import { RequireIndexed } from "@/features/repositories/not-indexed";
import { useRepoId } from "@/features/repositories/repo-layout";

const EXAMPLES = [
  "Where is refresh token expiry handled?",
  "How are webhook signatures verified?",
  "What happens when a charge request fails?",
];

/** A question asked in this browser session (history entries come from the server). */
interface Exchange {
  key: number;
  question: string;
  status: "pending" | "done" | "error";
  answer?: QuestionAnswer;
  error?: unknown;
}

function citationLabel(c: Citation): string {
  return c.source === "code"
    ? `${c.path} ${lineRange(c.start_line, c.end_line)}`
    : `Note “${c.title}” ${lineRange(c.start_line, c.end_line)}`;
}

function CodeCitationPreview({ repo, citation }: { repo: Repository; citation: CodeCitation }) {
  const file = useFileContent(repo.id, citation.path, citation.commit_sha);
  if (file.isPending) return <Skeleton className="m-3 h-24" />;
  if (file.isError) return <p className="px-3 py-2 text-xs text-fg-muted">Preview unavailable.</p>;
  const lines = splitLines(file.data.content);
  const from = Math.max(1, citation.start_line - 2);
  const to = Math.min(lines.length, citation.end_line + 2);
  return (
    <CodeView
      content={lines.slice(from - 1, to).join("\n")}
      startLine={from}
      highlight={{ start: citation.start_line, end: citation.end_line }}
      maxHeight={260}
      label={`Cited lines from ${citation.path}`}
      language={file.data.language}
    />
  );
}

function KnowledgeCitationPreview({ citation }: { citation: KnowledgeCitation }) {
  const doc = useKnowledgeDocument(citation.knowledge_document_id);
  if (doc.isPending) return <Skeleton className="m-3 h-16" />;
  if (doc.isError || !doc.data.content) {
    return <p className="px-3 py-2 text-xs text-fg-muted">Preview unavailable.</p>;
  }
  const lines = splitLines(doc.data.content);
  const from = Math.max(1, Math.min(citation.start_line, lines.length));
  const to = Math.min(lines.length, Math.max(citation.end_line, from));
  return (
    <CodeView
      content={lines.slice(from - 1, to).join("\n")}
      startLine={from}
      maxHeight={220}
      label={`Cited lines from note ${citation.title}`}
      language="markdown"
    />
  );
}

function CitationItem({
  repo,
  citation,
  index,
  anchorId,
  open,
  onToggle,
}: {
  repo: Repository;
  citation: Citation;
  index: number;
  anchorId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { base } = useWorkspace();
  const stale =
    citation.source === "code" && citation.commit_sha !== repo.latest_indexed_commit_sha;
  return (
    <li
      id={`citation-${anchorId}`}
      className="overflow-hidden rounded-md border border-border bg-surface"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-xs bg-accent font-mono text-2xs font-semibold text-accent-fg">
          {index}
        </span>
        {citation.source === "code" ? (
          <>
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
            {citation.symbol && (
              <Mono className="hidden text-2xs text-fg md:inline">{citation.symbol}</Mono>
            )}
            <Mono className="hidden text-2xs sm:inline" title={citation.content_hash}>
              @ {shortSha(citation.commit_sha)}
            </Mono>
            {stale && <Badge tone="warning">Older commit</Badge>}
          </>
        ) : (
          <>
            <BookOpen className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
            <Link
              href={`${base}/repositories/${repo.id}/knowledge?doc=${encodeURIComponent(citation.knowledge_document_id)}`}
              className="min-w-0 truncate text-xs font-medium text-fg hover:text-link hover:underline"
            >
              {citation.title}
            </Link>
            <Badge tone="info">
              Knowledge · {lineRange(citation.start_line, citation.end_line)}
            </Badge>
          </>
        )}
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
      {citation.supports && (
        <p className="border-t border-border px-3 py-1.5 text-xs text-fg-muted">
          Supports: {citation.supports}
        </p>
      )}
      {open && (
        <div className="border-t border-border">
          {citation.source === "code" ? (
            <CodeCitationPreview repo={repo} citation={citation} />
          ) : (
            <KnowledgeCitationPreview citation={citation} />
          )}
        </div>
      )}
    </li>
  );
}

function AnswerCard({
  repo,
  answer,
  fresh,
}: {
  repo: Repository;
  answer: QuestionAnswer;
  /** Fresh answers expand the first source; history entries start collapsed. */
  fresh: boolean;
}) {
  const [openCitations, setOpenCitations] = useState<Set<number>>(
    () => new Set(fresh && answer.citations.length ? [1] : []),
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
  const knowledgeCount = answer.citations.filter((c) => c.source === "knowledge").length;
  const hasDiagnostics =
    answer.retrieval.chunks_considered !== null || answer.retrieval.latency_ms !== null;
  const anchor = (n: number) => `${answer.id ?? "local"}-${n}`;

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
        {knowledgeCount > 0 && <Badge tone="info">{knowledgeCount} from knowledge notes</Badge>}
        {answer.commit_sha && (
          <Mono className="text-2xs" title={answer.commit_sha}>
            @ {shortSha(answer.commit_sha)}
          </Mono>
        )}
      </div>
      <RichText
        text={answer.answer}
        renderCitation={(n) =>
          n >= 1 && n <= answer.citations.length ? (
            <Tooltip content={citationLabel(answer.citations[n - 1]!)}>
              <a
                href={`#citation-${anchor(n)}`}
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
                key={`${i}-${c.source === "code" ? c.path : c.knowledge_document_id}:${c.start_line}`}
                repo={repo}
                citation={c}
                index={i + 1}
                anchorId={anchor(i + 1)}
                open={openCitations.has(i + 1)}
                onToggle={() => toggle(i + 1)}
              />
            ))}
          </ol>
        </div>
      )}
      {hasDiagnostics && (
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
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-surface-sunken px-3 py-2 font-mono text-2xs text-fg-muted sm:grid-cols-5">
              <div>
                <dt>chunks considered</dt>
                <dd className="text-fg">{formatNumber(answer.retrieval.chunks_considered)}</dd>
              </div>
              <div>
                <dt>chunks used</dt>
                <dd className="text-fg">{formatNumber(answer.retrieval.chunks_used)}</dd>
              </div>
              <div>
                <dt>knowledge hits</dt>
                <dd className="text-fg">{formatNumber(answer.retrieval.knowledge_results)}</dd>
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
      )}
    </div>
  );
}

function QuestionCard({
  question,
  createdAt,
  onRemove,
  removing,
  children,
}: {
  question: string;
  createdAt?: string | null;
  onRemove?: () => void;
  removing?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 border-b border-border bg-bg-subtle px-4 py-3">
        <FileCode2 className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
        <p className="min-w-0 flex-1 font-medium text-fg">{question}</p>
        {createdAt && (
          <time
            dateTime={createdAt}
            title={formatDateTime(createdAt)}
            className="shrink-0 pt-0.5 text-2xs text-fg-subtle"
          >
            {formatRelative(createdAt)}
          </time>
        )}
        {onRemove && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove “${question}” from history`}
            onClick={onRemove}
            loading={removing}
            className="-my-1"
          >
            {!removing && <Trash2 />}
          </Button>
        )}
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}

function AskPanel({ repo }: { repo: Repository }) {
  const queryClient = useQueryClient();
  const { workspaceId } = useWorkspace();
  const [question, setQuestion] = useState("");
  const [includeKnowledge, setIncludeKnowledge] = useState(true);
  const [session, setSession] = useState<Exchange[]>([]);
  const nextKey = useRef(1);
  const history = useQuestionHistory(repo.id);
  const historyKey = qk.questions(workspaceId, repo.id);

  const ask = useMutation({
    mutationFn: ({ q }: { q: string; key: number }) =>
      api.repositories.ask(repo.id, {
        question: q,
        snapshot: "latest",
        include_knowledge: includeKnowledge,
      }),
    onSuccess: (answer, { key }) => {
      setSession((h) => h.map((x) => (x.key === key ? { ...x, status: "done", answer } : x)));
      void queryClient.invalidateQueries({ queryKey: historyKey });
    },
    onError: (error, { key }) =>
      setSession((h) => h.map((x) => (x.key === key ? { ...x, status: "error", error } : x))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.questions.remove(id),
    onSuccess: (_, id) => {
      setSession((h) => h.filter((x) => x.answer?.id !== id));
      void queryClient.invalidateQueries({ queryKey: historyKey });
      toast.success("Removed from your history");
    },
    onError: (e) => notifyError(e, "Couldn't remove the question"),
  });

  // Answers from this session render with their retrieval diagnostics, so hide their
  // saved copies from the server list.
  const sessionIds = useMemo(
    () => new Set(session.map((x) => x.answer?.id).filter(Boolean) as string[]),
    [session],
  );
  const saved = useMemo(
    () =>
      (history.data?.pages.flatMap((p) => p.items) ?? []).filter(
        (a) => !a.id || !sessionIds.has(a.id),
      ),
    [history.data, sessionIds],
  );

  const submit = (q: string) => {
    const text = q.trim();
    if (text.length < 3 || ask.isPending) return;
    const key = nextKey.current++;
    setSession((h) => [{ key, question: text, status: "pending" }, ...h]);
    setQuestion("");
    ask.mutate({ q: text, key });
  };

  const empty = session.length === 0 && saved.length === 0;

  return (
    <PageContainer className="max-w-4xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(question);
        }}
        className="flex flex-col gap-2"
      >
        <div className="relative">
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
        </div>
        <label className="inline-flex items-center gap-2 self-start text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={includeKnowledge}
            onChange={(e) => setIncludeKnowledge(e.target.checked)}
            className="size-3.5 accent-[var(--color-primary)]"
          />
          Also search knowledge notes (architecture docs, ADRs, engineering notes)
        </label>
      </form>

      {history.isPending && session.length === 0 ? (
        <SkeletonRows rows={4} label="Loading your questions" />
      ) : empty ? (
        <Card>
          <EmptyState
            icon={<MessageSquareText />}
            title="Grounded repository Q&A"
            description="Answers are built only from retrieved code and knowledge notes, and cite exact lines. When evidence is missing, Anvaya says so instead of guessing. Your questions are saved here for you only."
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
        <>
          {session.length > 0 && (
            <ol
              className="flex flex-col gap-5"
              aria-label="Questions and answers"
              aria-live="polite"
            >
              {session.map((x) => (
                <li key={x.key}>
                  <QuestionCard
                    question={x.question}
                    createdAt={x.answer?.created_at}
                    onRemove={x.answer?.id ? () => remove.mutate(x.answer!.id!) : undefined}
                    removing={remove.isPending && remove.variables === x.answer?.id}
                  >
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
                    {x.status === "done" && x.answer && (
                      <AnswerCard repo={repo} answer={x.answer} fresh />
                    )}
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
                  </QuestionCard>
                </li>
              ))}
            </ol>
          )}

          {history.isError ? (
            <ErrorState compact error={history.error} onRetry={() => history.refetch()} />
          ) : (
            saved.length > 0 && (
              <section aria-labelledby="qa-history" className="flex flex-col gap-3">
                <h2
                  id="qa-history"
                  className="flex items-center gap-2 text-xs font-semibold tracking-wide text-fg-muted uppercase"
                >
                  <History className="size-3.5" /> Your earlier questions
                </h2>
                <ol className="flex flex-col gap-5" aria-label="Earlier questions">
                  {saved.map((a) => (
                    <li key={a.id ?? a.question}>
                      <QuestionCard
                        question={a.question}
                        createdAt={a.created_at}
                        onRemove={a.id ? () => remove.mutate(a.id!) : undefined}
                        removing={remove.isPending && remove.variables === a.id}
                      >
                        <AnswerCard repo={repo} answer={a} fresh={false} />
                      </QuestionCard>
                    </li>
                  ))}
                </ol>
                {history.hasNextPage && (
                  <Button
                    variant="secondary"
                    className="self-center"
                    onClick={() => history.fetchNextPage()}
                    loading={history.isFetchingNextPage}
                  >
                    Load older questions
                  </Button>
                )}
              </section>
            )
          )}
        </>
      )}
    </PageContainer>
  );
}

export function AskScreen() {
  const repoId = useRepoId();
  return <RequireIndexed repoId={repoId}>{(repo) => <AskPanel repo={repo} />}</RequireIndexed>;
}
