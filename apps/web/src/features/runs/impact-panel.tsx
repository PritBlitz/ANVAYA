"use client";

import { FlaskConical, GitFork, Info } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, Mono, SkeletonRows } from "@/components/ui/misc";
import { ErrorState } from "@/components/ui/states";
import { useRunImpact } from "@/lib/api/queries";
import type { ImpactEvidenceStep, RunImpact, SelectedTest } from "@/lib/api/types";
import { codeHref } from "@/lib/code";
import { useWorkspace } from "@/lib/workspace/context";
import { useRunContext } from "./run-context";

/** Human-readable one-liner for an evidence step. */
export function describeStep(step: ImpactEvidenceStep): string {
  switch (step.kind) {
    case "imports":
      return `${step.from} imports ${step.to}${step.line ? ` (line ${step.line})` : ""}`;
    case "calls":
      return `${step.caller} in ${step.from} calls ${step.callee}${step.line ? ` (line ${step.line})` : ""}`;
    case "changed":
      return `${step.path} is changed`;
    case "naming":
      return `${step.from} is named after ${step.to}`;
  }
}

/** Where an evidence step points in the code (the file and line that contain the import/call). */
function stepLocation(step: ImpactEvidenceStep): { path: string; line: number | null } {
  if (step.kind === "changed") return { path: step.path, line: null };
  if (step.kind === "naming") return { path: step.from, line: null };
  return { path: step.from, line: step.line };
}

const SOURCE_LABEL: Record<RunImpact["source"], string> = {
  patch: "the applied patch",
  plan: "the files in the plan (no patch yet)",
  none: "nothing yet",
};

export function scoreLabel(score: number): "strong" | "moderate" | "weak" {
  return score >= 0.85 ? "strong" : score >= 0.6 ? "moderate" : "weak";
}

function TestRow({
  test,
  repoId,
  sha,
}: {
  test: SelectedTest;
  repoId: string;
  sha: string | null;
}) {
  const { base } = useWorkspace();
  const strength = scoreLabel(test.score);
  return (
    <li className="px-4 py-2.5 text-sm" data-testid="selected-test">
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="size-4 text-fg-subtle" />
        <Link
          href={codeHref(base, repoId, test.path, null, sha)}
          className="font-mono text-fg hover:underline"
        >
          {test.path}
        </Link>
        <Badge
          tone={strength === "strong" ? "info" : "neutral"}
          title={`Heuristic ranking score ${test.score}`}
        >
          {strength} signal
        </Badge>
      </div>
      <ul className="mt-1 flex flex-col gap-1 pl-6 text-xs text-fg-muted">
        {test.reasons.map((r) => (
          <li key={r.kind}>
            <span className="text-fg">{r.description}</span>
            {r.evidence.length > 0 && (
              <ol className="mt-0.5 flex flex-col gap-0.5" aria-label="Evidence path">
                {r.evidence.map((step, i) => {
                  const loc = stepLocation(step);
                  return (
                    <li key={i}>
                      <Link
                        href={codeHref(
                          base,
                          repoId,
                          loc.path,
                          loc.line ? { start: loc.line, end: loc.line } : null,
                          sha,
                        )}
                        className="font-mono hover:underline"
                      >
                        {describeStep(step)}
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Predicted impact and test selection for a run. Heuristic and clearly labelled as such
 * (FR-VER-006): it orders attention and, where a repository opts in, narrows test runs,
 * but only deterministic verification decides pass or fail.
 */
export function ImpactPanel({ compact = false }: { compact?: boolean }) {
  const { run } = useRunContext();
  const impact = useRunImpact(run.id);
  if (impact.isPending) return <SkeletonRows rows={3} />;
  if (impact.isError) return <ErrorState error={impact.error} onRetry={() => impact.refetch()} />;
  const d = impact.data;
  const repoId = run.task.repository_id;
  return (
    <Card aria-label="Predicted impact" data-testid="impact-panel">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <GitFork className="size-4" /> Predicted impact and test selection
            <Badge tone="warning">Heuristic</Badge>
          </span>
        }
        description={`From static imports and calls of ${SOURCE_LABEL[d.source]}. Not a verification result.`}
      />
      <CardBody className="flex flex-col gap-3 p-0">
        <p className="flex items-start gap-2 px-4 text-xs text-fg-muted">
          <Info className="mt-0.5 size-3.5 shrink-0" /> {d.disclaimer}
        </p>
        {d.source === "none" ? (
          <p className="px-4 pb-4 text-sm text-fg-muted">
            Nothing to analyse until the run has a plan.
          </p>
        ) : (
          <>
            <p className="px-4 text-sm text-fg">
              {d.impacted_files.length} impacted file{d.impacted_files.length === 1 ? "" : "s"} ·{" "}
              {d.selected_tests.length} of {d.test_files_total} test file
              {d.test_files_total === 1 ? "" : "s"} selected
            </p>
            {d.selected_tests.length > 0 ? (
              <ul
                className="divide-y divide-border border-t border-border"
                aria-label="Selected tests"
              >
                {d.selected_tests.slice(0, compact ? 5 : undefined).map((t) => (
                  <TestRow key={t.path} test={t} repoId={repoId} sha={d.commit_sha} />
                ))}
              </ul>
            ) : (
              <p className="px-4 text-sm text-fg-muted">
                No test file is linked to these changes by imports, calls or naming. That does not
                mean nothing is affected.
              </p>
            )}
            {!compact && d.impacted_files.length > 0 && (
              <details className="border-t border-border px-4 py-2 text-sm">
                <summary className="cursor-pointer text-fg-muted">Impacted files</summary>
                <ul className="mt-2 flex flex-col gap-1">
                  {d.impacted_files.map((f) => (
                    <li key={f.path} className="text-xs text-fg-muted">
                      <Mono className="text-fg">{f.path}</Mono> · {f.reason} · {f.distance} hop
                      {f.distance === 1 ? "" : "s"}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {d.applied_selections.length > 0 && (
              <p className="border-t border-border px-4 py-2 text-xs text-fg-muted">
                This repository narrows supported test profiles to the selected tests. Unselected
                tests did not run; see each verification result for the exact files.
              </p>
            )}
            <details className="border-t border-border px-4 py-2 pb-3 text-xs text-fg-muted">
              <summary className="cursor-pointer">Limitations</summary>
              <ul className="mt-1 list-disc pl-5">
                {d.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </details>
          </>
        )}
      </CardBody>
    </Card>
  );
}
