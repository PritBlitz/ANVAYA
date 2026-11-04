"use client";

import {
  ChevronDown,
  FileDiff,
  FileMinus2,
  FilePlus2,
  FileText,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import { AiBadge } from "@/components/domain/badges";
import { Badge } from "@/components/ui/badge";
import { Card, Mono, SkeletonRows } from "@/components/ui/misc";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { isApiError } from "@/lib/api/errors";
import { useRunDiff, useRunPlan } from "@/lib/api/queries";
import { outOfScopeFiles, parseUnifiedDiff, type DiffFile } from "@/lib/diff";
import { cn } from "@/lib/utils/cn";
import { shortSha } from "@/lib/utils/format";
import { CopyButton } from "@/features/code/code-view";
import { ImpactPanel } from "./impact-panel";
import { useRunContext } from "./run-context";

function fileAnchor(path: string) {
  return `diff-${path.replace(/[^a-zA-Z0-9]+/g, "-")}`;
}

function StatusIcon({ status }: { status: DiffFile["status"] }) {
  if (status === "added") return <FilePlus2 className="size-3.5 text-success" aria-label="added" />;
  if (status === "deleted")
    return <FileMinus2 className="size-3.5 text-danger" aria-label="deleted" />;
  return <FileText className="size-3.5 text-fg-subtle" aria-label={status} />;
}

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span
      className="font-mono text-2xs tabular"
      aria-label={`${additions} additions, ${deletions} deletions`}
    >
      <span className="text-diff-add-fg">+{additions}</span>{" "}
      <span className="text-diff-del-fg">−{deletions}</span>
    </span>
  );
}

function FileDiffCard({
  file,
  outOfScope,
  explanation,
}: {
  file: DiffFile;
  outOfScope: boolean;
  explanation?: string | null;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Card id={fileAnchor(file.path)} className="scroll-mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-bg-subtle px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${file.path}`}
          className="rounded-sm p-0.5 text-fg-muted hover:text-fg"
        >
          <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
        </button>
        <StatusIcon status={file.status} />
        <span className="min-w-0 truncate font-mono text-sm text-fg">{file.path}</span>
        {file.status !== "modified" && (
          <Badge
            tone={
              file.status === "added" ? "success" : file.status === "deleted" ? "danger" : "info"
            }
          >
            {file.status}
          </Badge>
        )}
        {outOfScope && <Badge tone="danger">Outside approved scope</Badge>}
        <span className="ml-auto">
          <DiffStat additions={file.additions} deletions={file.deletions} />
        </span>
      </div>
      {explanation && (
        <p className="flex items-start gap-2 border-b border-border bg-ai-soft/40 px-3 py-2 text-xs text-fg">
          <Sparkles className="mt-0.5 size-3 shrink-0 text-ai" aria-label="AI-written" />
          {explanation}
        </p>
      )}
      {open && (
        <div
          role="region"
          aria-label={`Scrollable diff of ${file.path}`}
          tabIndex={0}
          className="scrollbar-thin overflow-x-auto font-mono text-[12.5px] leading-6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          {file.binary ? (
            <p className="px-4 py-3 text-xs text-fg-muted">Binary file — not displayed.</p>
          ) : (
            <table className="w-full border-collapse" aria-label={`Diff of ${file.path}`}>
              {file.hunks.map((h, hi) => (
                <tbody key={hi}>
                  <tr className="bg-info-soft/60">
                    <td colSpan={3} className="px-3 py-0.5 text-2xs text-info">
                      {h.header}
                    </td>
                  </tr>
                  {h.lines.map((l, li) => (
                    <tr
                      key={li}
                      className={cn(
                        l.kind === "add" && "bg-diff-add-bg",
                        l.kind === "del" && "bg-diff-del-bg",
                      )}
                    >
                      <td
                        className={cn(
                          "w-px border-r border-border px-2 text-right text-fg-subtle select-none",
                          l.kind === "add" && "bg-diff-add-gutter",
                          l.kind === "del" && "bg-diff-del-gutter",
                        )}
                      >
                        {l.oldNumber ?? ""}
                      </td>
                      <td
                        className={cn(
                          "w-px border-r border-border px-2 text-right text-fg-subtle select-none",
                          l.kind === "add" && "bg-diff-add-gutter",
                          l.kind === "del" && "bg-diff-del-gutter",
                        )}
                      >
                        {l.newNumber ?? ""}
                      </td>
                      <td className="pr-4 pl-2 whitespace-pre text-fg">
                        <span
                          aria-hidden
                          className={cn(
                            "inline-block w-4 select-none",
                            l.kind === "add" && "text-diff-add-fg",
                            l.kind === "del" && "text-diff-del-fg",
                          )}
                        >
                          {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                        </span>
                        <span className="sr-only">
                          {l.kind === "add" ? "added: " : l.kind === "del" ? "removed: " : ""}
                        </span>
                        {l.text}
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          )}
        </div>
      )}
    </Card>
  );
}

export function ChangesView() {
  const { run } = useRunContext();
  const diff = useRunDiff(run.id);
  const plan = useRunPlan(run.id);
  const files = useMemo(
    () => (diff.data ? parseUnifiedDiff(diff.data.unified_diff) : []),
    [diff.data],
  );
  const outOfScope = useMemo(
    () =>
      plan.data
        ? new Set(
            outOfScopeFiles(
              files.map((f) => f.path),
              plan.data.plan.files_to_modify,
            ),
          )
        : new Set<string>(),
    [files, plan.data],
  );

  if (diff.isPending) return <SkeletonRows rows={10} />;
  if (diff.isError) {
    if (isApiError(diff.error) && diff.error.isNotFound) {
      return (
        <div className="flex flex-col gap-4">
          <Card>
            <EmptyState
              icon={<FileDiff />}
              title="No changes yet"
              description="The patch developer runs only after the plan is approved. Proposed changes appear here, validated before they're applied."
            />
          </Card>
          {plan.data && <ImpactPanel />}
        </div>
      );
    }
    return <ErrorState error={diff.error} onRetry={() => diff.refetch()} />;
  }
  const d = diff.data;

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      <aside className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
        <Card className="p-3">
          <p className="text-xs text-fg-muted">
            {d.changed_files.length} files ·{" "}
            <DiffStat additions={d.additions} deletions={d.deletions} />
          </p>
          <nav aria-label="Changed files" className="mt-2">
            <ul className="flex flex-col">
              {files.map((f) => (
                <li key={f.path}>
                  <a
                    href={`#${fileAnchor(f.path)}`}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-surface-hover"
                  >
                    <StatusIcon status={f.status} />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate font-mono",
                        outOfScope.has(f.path) ? "text-danger" : "text-fg",
                      )}
                      title={f.path}
                    >
                      {f.path.split("/").pop()}
                    </span>
                    <DiffStat additions={f.additions} deletions={f.deletions} />
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </Card>
        <Card className="flex flex-col gap-1.5 p-3 text-xs">
          <span className="text-fg-muted">
            Patch{" "}
            <Badge tone={d.attempt > 1 ? "warning" : "info"}>
              {d.attempt > 1 ? `repair attempt ${d.attempt}` : "first attempt"}
            </Badge>
          </span>
          <span className="flex items-center justify-between gap-2 text-fg-muted">
            <Mono title={d.patch_hash}>{d.patch_hash.slice(0, 23)}</Mono>
            <CopyButton value={d.patch_hash} label="Copy" />
          </span>
          <span className="text-fg-muted">
            Base commit <Mono>{shortSha(d.base_commit_sha)}</Mono>
          </span>
        </Card>
      </aside>
      <div className="flex min-w-0 flex-col gap-4">
        {d.summary && (
          <InlineAlert
            tone="ai"
            icon={<Sparkles />}
            title={
              <span className="flex items-center gap-2">
                Patch summary <AiBadge />
              </span>
            }
          >
            {d.summary}
          </InlineAlert>
        )}
        {d.truncated && (
          <InlineAlert tone="warning" icon={<ShieldAlert />} title="Diff truncated">
            This patch is larger than the display limit. Download the patch artifact from the
            Timeline to review every line before approving.
          </InlineAlert>
        )}
        {plan.data &&
          (outOfScope.size === 0 ? (
            <InlineAlert tone="success" icon={<ShieldCheck />} title="Within approved scope">
              Every changed file is listed in the approved plan.
            </InlineAlert>
          ) : (
            <InlineAlert
              tone="danger"
              icon={<ShieldAlert />}
              title={`${outOfScope.size} file(s) outside the approved plan`}
            >
              {[...outOfScope].join(", ")} — review carefully before approving a pull request.
            </InlineAlert>
          ))}
        <ImpactPanel compact />
        {files.map((f) => (
          <FileDiffCard
            key={f.path}
            file={f}
            outOfScope={outOfScope.has(f.path)}
            explanation={d.changed_files.find((c) => c.path === f.path)?.explanation}
          />
        ))}
      </div>
    </div>
  );
}
