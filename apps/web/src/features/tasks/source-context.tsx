"use client";

import { MetaList } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, Mono } from "@/components/ui/misc";
import type { TaskSourceContext } from "@/lib/api/types";

/**
 * Metadata imported from GitHub for pull-request and failing-check tasks. It is
 * untrusted repository content: rendered as plain text only (never as HTML or links).
 */
export function SourceContextCard({ context }: { context: TaskSourceContext }) {
  return context.kind === "pull_request" ? (
    <Card>
      <CardHeader
        title="Pull request"
        description="Imported from GitHub — treated as untrusted context."
      />
      <CardBody className="flex flex-col gap-4">
        <MetaList
          items={[
            {
              label: "State",
              value: (
                <>
                  {context.merged ? "merged" : context.state}
                  {context.draft ? " (draft)" : ""}
                </>
              ),
            },
            {
              label: "Head",
              value: (
                <Mono>
                  {context.head_branch} @ {context.head_sha.slice(0, 7)}
                </Mono>
              ),
            },
            {
              label: "Base",
              value: (
                <Mono>
                  {context.base_branch} @ {context.base_sha.slice(0, 7)}
                </Mono>
              ),
            },
          ]}
        />
        <section aria-label="Changed files">
          <h3 className="mb-1.5 text-xs font-medium text-fg-muted">
            Changed files ({context.changed_files_total}
            {context.changed_files_truncated ? ", list truncated" : ""})
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {context.changed_files.map((f) => (
              <li key={f.path} className="flex items-center gap-2">
                <Badge tone="neutral">{f.status}</Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
                <span className="font-mono text-xs text-fg-subtle tabular">
                  +{f.additions} −{f.deletions}
                </span>
              </li>
            ))}
          </ul>
        </section>
        {context.review_comments.length > 0 && (
          <section aria-label="Review comments">
            <h3 className="mb-1.5 text-xs font-medium text-fg-muted">
              Review comments{context.review_comments_truncated ? " (truncated)" : ""}
            </h3>
            <ul className="flex flex-col gap-2 text-sm">
              {context.review_comments.map((c, i) => (
                <li key={i} className="rounded-md border border-border p-2">
                  <p className="mb-1 text-xs text-fg-muted">
                    {c.author ?? "unknown"} on{" "}
                    <span className="font-mono">
                      {c.path ?? "the pull request"}
                      {c.line ? `:${c.line}` : ""}
                    </span>
                  </p>
                  <p className="break-words whitespace-pre-wrap text-fg">{c.body}</p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardBody>
    </Card>
  ) : (
    <Card>
      <CardHeader
        title="Failing check"
        description="Imported from GitHub — redacted and treated as untrusted evidence."
      />
      <CardBody className="flex flex-col gap-4">
        <MetaList
          items={[
            { label: "Check", value: context.check_name },
            {
              label: "Conclusion",
              value: <Badge tone="danger">{context.conclusion.replace(/_/g, " ")}</Badge>,
            },
            { label: "Commit", value: <Mono>{context.head_sha.slice(0, 12)}</Mono> },
            ...(context.app ? [{ label: "Reported by", value: context.app }] : []),
          ]}
        />
        {context.annotations.length > 0 && (
          <section aria-label="Annotations">
            <h3 className="mb-1.5 text-xs font-medium text-fg-muted">
              Annotations ({context.annotations_total}
              {context.annotations_truncated ? ", truncated" : ""})
            </h3>
            <ul className="flex flex-col gap-2 text-sm">
              {context.annotations.map((a, i) => (
                <li key={i} className="rounded-md border border-border p-2">
                  <p className="mb-1 font-mono text-xs text-fg-muted">
                    {a.path}
                    {a.start_line ? `:${a.start_line}` : ""}
                    {a.level ? ` · ${a.level}` : ""}
                  </p>
                  {a.title && <p className="text-xs font-medium text-fg">{a.title}</p>}
                  <p className="font-mono text-xs break-words whitespace-pre-wrap text-fg">
                    {a.message}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardBody>
    </Card>
  );
}
