import type { Tone } from "@/components/ui/badge";
import {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type FindingSource,
  type IndexingStatus,
  type RunStatus,
  type Severity,
  type TaskStatus,
  type VerificationStatus,
} from "@/lib/api/types";

// ── Runs (ARCHITECTURE.md §6) ─────────────────────────────────────────────

export interface RunStatusMeta {
  label: string;
  tone: Tone;
  /** True while the run is progressing without a human. */
  working: boolean;
  /** True when a human decision is required. */
  awaiting: boolean;
}

const RUN_STATUS: Record<RunStatus, RunStatusMeta> = {
  queued: { label: "Queued", tone: "neutral", working: true, awaiting: false },
  retrieving_context: { label: "Retrieving context", tone: "info", working: true, awaiting: false },
  investigating: { label: "Investigating", tone: "info", working: true, awaiting: false },
  planning: { label: "Planning", tone: "info", working: true, awaiting: false },
  awaiting_plan_approval: {
    label: "Plan approval needed",
    tone: "warning",
    working: false,
    awaiting: true,
  },
  preparing_workspace: {
    label: "Preparing workspace",
    tone: "info",
    working: true,
    awaiting: false,
  },
  implementing: { label: "Implementing", tone: "info", working: true, awaiting: false },
  verifying: { label: "Verifying", tone: "info", working: true, awaiting: false },
  reviewing: { label: "Reviewing", tone: "info", working: true, awaiting: false },
  awaiting_pr_approval: {
    label: "PR approval needed",
    tone: "warning",
    working: false,
    awaiting: true,
  },
  creating_pr: { label: "Creating PR", tone: "info", working: true, awaiting: false },
  completed: { label: "Completed", tone: "success", working: false, awaiting: false },
  completed_without_pr: {
    label: "Completed · no PR",
    tone: "neutral",
    working: false,
    awaiting: false,
  },
  failed: { label: "Failed", tone: "danger", working: false, awaiting: false },
  cancelled: { label: "Cancelled", tone: "neutral", working: false, awaiting: false },
  timed_out: { label: "Timed out", tone: "danger", working: false, awaiting: false },
  rejected: { label: "Plan rejected", tone: "neutral", working: false, awaiting: false },
};

export function runStatusMeta(status: string): RunStatusMeta {
  return (
    RUN_STATUS[status as RunStatus] ?? {
      label: humanize(status),
      tone: "neutral",
      working: false,
      awaiting: false,
    }
  );
}

export function isTerminalRun(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function isActiveRun(status: string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

export function canCancelRun(status: string): boolean {
  return isActiveRun(status) && status !== "creating_pr";
}

export function canRetryRun(status: string): boolean {
  return status === "failed" || status === "cancelled" || status === "timed_out";
}

/** Lifecycle phases shown in the run stepper, in order. */
export const RUN_PHASES = [
  { key: "context", label: "Context", statuses: ["queued", "retrieving_context"] },
  { key: "investigate", label: "Investigate", statuses: ["investigating"] },
  { key: "plan", label: "Plan", statuses: ["planning", "awaiting_plan_approval"] },
  { key: "implement", label: "Implement", statuses: ["preparing_workspace", "implementing"] },
  { key: "verify", label: "Verify", statuses: ["verifying"] },
  { key: "review", label: "Review", statuses: ["reviewing", "awaiting_pr_approval"] },
  {
    key: "handoff",
    label: "Pull request",
    statuses: ["creating_pr", "completed", "completed_without_pr"],
  },
] as const;

export type PhaseState = "done" | "current" | "waiting" | "upcoming" | "failed" | "skipped";

/**
 * Derive per-phase state from the run status and the furthest phase reached
 * (needed for terminal states, which do not encode where the run stopped).
 */
export function phaseStates(status: string, reachedIndex: number): PhaseState[] {
  const currentIdx = RUN_PHASES.findIndex((p) =>
    (p.statuses as readonly string[]).includes(status),
  );
  const terminalFailure = ["failed", "timed_out", "cancelled", "rejected"].includes(status);
  return RUN_PHASES.map((phase, i) => {
    if (status === "completed") return "done";
    if (status === "completed_without_pr") return i === RUN_PHASES.length - 1 ? "skipped" : "done";
    if (terminalFailure) {
      if (i < reachedIndex) return "done";
      if (i === reachedIndex)
        return status === "cancelled" || status === "rejected" ? "skipped" : "failed";
      return "upcoming";
    }
    if (i < currentIdx) return "done";
    if (i === currentIdx) return runStatusMeta(status).awaiting ? "waiting" : "current";
    return "upcoming";
  });
}

/** Index of the furthest phase implied by a status (or the stage recorded in events). */
export function phaseIndexOf(status: string | null | undefined): number {
  if (!status) return 0;
  const i = RUN_PHASES.findIndex((p) => (p.statuses as readonly string[]).includes(status));
  return i < 0 ? 0 : i;
}

// ── Repositories ──────────────────────────────────────────────────────────

export function indexingMeta(status: IndexingStatus): {
  label: string;
  tone: Tone;
  working: boolean;
} {
  switch (status) {
    case "ready":
      return { label: "Indexed", tone: "success", working: false };
    case "partial":
      return { label: "Partially indexed", tone: "warning", working: false };
    case "indexing":
      return { label: "Indexing", tone: "info", working: true };
    case "queued":
      return { label: "Queued", tone: "info", working: true };
    case "pending":
      return { label: "Not indexed", tone: "neutral", working: false };
    case "failed":
      return { label: "Index failed", tone: "danger", working: false };
    case "disabled":
      return { label: "Disabled", tone: "neutral", working: false };
  }
}

export function isQueryable(status: IndexingStatus): boolean {
  return status === "ready" || status === "partial";
}

// ── Tasks ─────────────────────────────────────────────────────────────────

export function taskStatusMeta(status: TaskStatus): { label: string; tone: Tone } {
  const map: Record<TaskStatus, { label: string; tone: Tone }> = {
    open: { label: "Open", tone: "neutral" },
    active: { label: "In progress", tone: "info" },
    completed: { label: "Completed", tone: "success" },
    failed: { label: "Failed", tone: "danger" },
    cancelled: { label: "Cancelled", tone: "neutral" },
    archived: { label: "Archived", tone: "neutral" },
  };
  return map[status];
}

export const TASK_SOURCE_LABEL = {
  manual: "Manual",
  github_issue: "GitHub issue",
  pull_request: "Pull request",
  failing_check: "Failing check",
} as const;

// ── Verification & review (FR-VER-004 / FR-VER-005) ───────────────────────

export function verificationMeta(status: VerificationStatus): { label: string; tone: Tone } {
  const map: Record<VerificationStatus, { label: string; tone: Tone }> = {
    passed: { label: "Passed", tone: "success" },
    failed: { label: "Failed", tone: "danger" },
    timed_out: { label: "Timed out", tone: "danger" },
    error: { label: "Error", tone: "danger" },
    skipped: { label: "Skipped", tone: "neutral" },
  };
  return map[status];
}

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export function severityMeta(severity: Severity): { label: string; tone: Tone; blocking: boolean } {
  const map: Record<Severity, { label: string; tone: Tone; blocking: boolean }> = {
    critical: { label: "Critical", tone: "danger", blocking: true },
    high: { label: "High", tone: "danger", blocking: true },
    medium: { label: "Medium", tone: "warning", blocking: false },
    low: { label: "Low", tone: "info", blocking: false },
    info: { label: "Info", tone: "neutral", blocking: false },
  };
  return map[severity];
}

/** AI findings are never presented as deterministic results. */
export function findingSourceMeta(source: FindingSource): {
  label: string;
  deterministic: boolean;
} {
  switch (source) {
    case "ai_review":
      return { label: "AI review", deterministic: false };
    case "static_analysis":
      return { label: "Static analysis", deterministic: true };
    case "security_scanner":
      return { label: "Security scanner", deterministic: true };
    case "test":
      return { label: "Test", deterministic: true };
  }
}

export function humanize(value: string): string {
  const s = value.replace(/[._]/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
