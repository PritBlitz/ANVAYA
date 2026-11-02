import type {
  EngineeringTask,
  ReviewReport,
  RunDiff,
  RunPlan,
  VerificationReport,
  WorkflowRun,
} from "@/lib/api/types";
import { outOfScopeFiles, parseUnifiedDiff } from "@/lib/diff";
import { findingSourceMeta, severityMeta } from "@/lib/domain/status";

export type GateStatus = "pass" | "fail" | "warn" | "pending";

export interface GateCheck {
  id: string;
  label: string;
  status: GateStatus;
  detail: string;
}

/**
 * Evidence shown before PR approval. Advisory only — the server re-validates every
 * condition (API_SPEC §6). "fail" blocks the approve button in the UI.
 */
export function prGateChecks(input: {
  run: WorkflowRun;
  plan?: RunPlan | null;
  diff?: RunDiff | null;
  verification?: VerificationReport | null;
  review?: ReviewReport | null;
}): GateCheck[] {
  const { plan, diff, verification, review } = input;
  const checks: GateCheck[] = [];

  checks.push(
    plan?.state === "approved"
      ? {
          id: "plan",
          label: "Plan approved by a human",
          status: "pass",
          detail: `Version ${plan.version}`,
        }
      : {
          id: "plan",
          label: "Plan approved by a human",
          status: plan ? "fail" : "pending",
          detail: plan ? `Plan is ${plan.state}` : "Loading plan",
        },
  );

  if (!diff) {
    checks.push({
      id: "scope",
      label: "Changes within approved scope",
      status: "pending",
      detail: "Loading patch",
    });
  } else {
    const changed = parseUnifiedDiff(diff.unified_diff).map((f) => f.path);
    const outside = plan ? outOfScopeFiles(changed, plan.plan.files_to_modify) : [];
    checks.push(
      outside.length === 0
        ? {
            id: "scope",
            label: "Changes within approved scope",
            status: "pass",
            detail: `${changed.length} files, all in plan`,
          }
        : {
            id: "scope",
            label: "Changes within approved scope",
            status: "warn",
            detail: `${outside.length} file(s) outside plan: ${outside.join(", ")}`,
          },
    );
  }

  if (!verification) {
    checks.push({
      id: "verification",
      label: "Deterministic checks passed",
      status: "pending",
      detail: "Loading results",
    });
  } else {
    const failed = verification.results.filter((r) =>
      ["failed", "timed_out", "error"].includes(r.status),
    );
    const passed = verification.results.filter((r) => r.status === "passed");
    checks.push(
      failed.length
        ? {
            id: "verification",
            label: "Deterministic checks passed",
            status: "fail",
            detail: `${failed.length} failed: ${failed.map((f) => f.profile_id).join(", ")}`,
          }
        : passed.length
          ? {
              id: "verification",
              label: "Deterministic checks passed",
              status: verification.unavailable.length ? "warn" : "pass",
              detail: `${passed.length} passed${verification.unavailable.length ? `, ${verification.unavailable.length} unavailable` : ""}`,
            }
          : {
              id: "verification",
              label: "Deterministic checks passed",
              status: "warn",
              detail: "No checks ran",
            },
    );
  }

  if (!review) {
    checks.push({
      id: "review",
      label: "No open blocking findings",
      status: "pending",
      detail: "Loading review",
    });
  } else {
    const blocking = review.findings.filter(
      (f) => f.status === "open" && severityMeta(f.severity).blocking,
    );
    const open = review.findings.filter((f) => f.status === "open");
    checks.push(
      blocking.length
        ? {
            id: "review",
            label: "No open blocking findings",
            status: "fail",
            detail: `${blocking.length} high/critical finding(s) unresolved`,
          }
        : {
            id: "review",
            label: "No open blocking findings",
            status: open.length ? "warn" : "pass",
            detail: open.length
              ? `${open.length} non-blocking finding(s) open`
              : "All findings resolved",
          },
    );
  }
  return checks;
}

export function gateAllows(checks: GateCheck[]): boolean {
  return checks.every((c) => c.status === "pass" || c.status === "warn");
}

/** Evidence-backed PR description (PRD §7.8). Plain markdown, no HTML. */
export function buildPrBody(input: {
  task:
    | Pick<EngineeringTask, "title" | "source_type" | "external_number">
    | { title: string; source_type?: string; external_number?: number | null };
  plan?: RunPlan | null;
  diff?: RunDiff | null;
  verification?: VerificationReport | null;
  review?: ReviewReport | null;
  runUrl?: string;
}): string {
  const { task, plan, diff, verification, review } = input;
  const lines: string[] = [];
  lines.push("## Summary", "", plan?.plan.objective ?? task.title, "");
  if (task.source_type === "github_issue" && task.external_number)
    lines.push(`Closes #${task.external_number}`, "");
  if (plan) {
    lines.push("## Changes", "");
    for (const s of plan.plan.steps) lines.push(`- ${s.description}`);
    lines.push("");
  }
  if (diff) {
    lines.push(
      `**Files:** ${diff.changed_files.map((f) => `\`${f.path}\``).join(", ")} (+${diff.additions} −${diff.deletions})`,
      "",
    );
  }
  if (verification) {
    lines.push("## Verification", "", "| Check | Command | Result | Exit |", "|---|---|---|---|");
    for (const r of verification.results)
      lines.push(
        `| ${r.profile_id} | \`${r.command_display}\` | ${r.status} | ${r.exit_code ?? "—"} |`,
      );
    for (const u of verification.unavailable)
      lines.push(`| ${u.profile_id} | — | unavailable | — |`);
    lines.push("");
  }
  if (review && review.findings.length) {
    lines.push("## Review findings", "");
    for (const f of review.findings) {
      const src = findingSourceMeta(f.source).label;
      lines.push(`- **${f.severity}** (${src}) ${f.title} — ${f.status}`);
    }
    lines.push("");
  }
  if (plan?.plan.risks.length) {
    lines.push("## Risks", "", ...plan.plan.risks.map((r) => `- ${r}`), "");
  }
  lines.push(
    "---",
    `Prepared by Anvaya${input.runUrl ? ` · [run details](${input.runUrl})` : ""}. Plan and pull request approved by a human; Anvaya does not merge.`,
  );
  return lines.join("\n");
}
