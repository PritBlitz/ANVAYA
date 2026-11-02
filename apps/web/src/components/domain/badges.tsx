import { Bot, Cpu, Cloud, FlaskConical, ShieldCheck, Sparkles, TerminalSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type {
  FindingSource,
  IndexingStatus,
  InferenceMode,
  RunStatus,
  Severity,
  TaskStatus,
  VerificationStatus,
} from "@/lib/api/types";
import {
  findingSourceMeta,
  indexingMeta,
  runStatusMeta,
  severityMeta,
  taskStatusMeta,
  verificationMeta,
} from "@/lib/domain/status";

export function RunStatusBadge({
  status,
  size,
}: {
  status: RunStatus | string;
  size?: "sm" | "md";
}) {
  const m = runStatusMeta(status);
  return (
    <Badge tone={m.tone} dot pulse={m.working} size={size}>
      {m.label}
    </Badge>
  );
}

export function IndexingBadge({ status }: { status: IndexingStatus }) {
  const m = indexingMeta(status);
  return (
    <Badge tone={m.tone} dot pulse={m.working}>
      {m.label}
    </Badge>
  );
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const m = taskStatusMeta(status);
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function VerificationBadge({ status }: { status: VerificationStatus }) {
  const m = verificationMeta(status);
  return (
    <Badge tone={m.tone} dot>
      {m.label}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const m = severityMeta(severity);
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

/**
 * Provenance of a finding. AI output carries the sparkle + violet treatment;
 * deterministic tools use a neutral terminal treatment (FR-VER-004).
 */
export function SourceBadge({ source }: { source: FindingSource }) {
  const m = findingSourceMeta(source);
  const icon =
    source === "ai_review" ? (
      <Sparkles className="size-3" />
    ) : source === "security_scanner" ? (
      <ShieldCheck className="size-3" />
    ) : source === "test" ? (
      <FlaskConical className="size-3" />
    ) : (
      <TerminalSquare className="size-3" />
    );
  return (
    <Badge tone={m.deterministic ? "neutral" : "ai"} className="gap-1">
      {icon}
      {m.label}
    </Badge>
  );
}

/** AI-generated content label used on answers, plans, summaries. */
export function AiBadge({ label = "AI-generated" }: { label?: string }) {
  return (
    <Badge tone="ai" className="gap-1">
      <Sparkles className="size-3" />
      {label}
    </Badge>
  );
}

/** Inference mode disclosure (FR-AI-008). Cloud is always called out. */
export function ModeBadge({
  mode,
  provider,
  model,
}: {
  mode: InferenceMode;
  provider?: string | null;
  model?: string | null;
}) {
  const icon =
    mode === "cloud" ? (
      <Cloud className="size-3" />
    ) : mode === "mock" ? (
      <Bot className="size-3" />
    ) : (
      <Cpu className="size-3" />
    );
  const label = mode === "cloud" ? "Cloud" : mode === "mock" ? "Mock" : "Local";
  return (
    <Badge
      tone={mode === "cloud" ? "warning" : "neutral"}
      className="gap-1"
      title={[provider, model].filter(Boolean).join(" · ") || undefined}
    >
      {icon}
      {label}
      {model && <span className="font-mono font-normal">· {model}</span>}
    </Badge>
  );
}
