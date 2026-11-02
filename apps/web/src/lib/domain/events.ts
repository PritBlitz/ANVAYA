import type { AgentStep, RunEvent, RunEventType } from "@/lib/api/types";
import { humanize, phaseIndexOf, runStatusMeta } from "./status";

const AGENT_LABEL: Record<string, string> = {
  context_retriever: "Context retriever",
  investigator: "Repository investigator",
  planner: "Engineering planner",
  developer: "Patch developer",
  verification_engine: "Verification engine",
  repair: "Repair assistant",
  reviewer: "Code reviewer",
};

export function agentLabel(agentType: string | null | undefined): string {
  if (!agentType) return "Agent";
  return AGENT_LABEL[agentType] ?? humanize(agentType);
}

/** True for stages performed by deterministic software rather than a model. */
export function isDeterministicAgent(agentType: string): boolean {
  return agentType === "context_retriever" || agentType === "verification_engine";
}

export type EventTone = "neutral" | "info" | "success" | "warning" | "danger" | "ai";

export interface EventDescription {
  title: string;
  detail?: string;
  tone: EventTone;
  /** Hidden from the activity log (duplicates of another event). */
  quiet?: boolean;
}

export function describeEvent(event: RunEvent): EventDescription {
  const p = event.payload;
  const num = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : null);
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);
  switch (event.type as RunEventType) {
    case "run.created":
      return { title: "Run created", tone: "neutral" };
    case "run.status.changed":
      return {
        title: runStatusMeta(p.status ?? "").label,
        tone: runStatusMeta(p.status ?? "").awaiting ? "warning" : "neutral",
      };
    case "run.stage.changed":
      return { title: `Stage: ${humanize(p.stage ?? "")}`, tone: "neutral", quiet: true };
    case "retrieval.completed": {
      const chunks = num("chunks");
      const tokens = num("token_estimate");
      return {
        title: "Evidence retrieved",
        detail:
          [chunks !== null && `${chunks} chunks`, tokens !== null && `~${tokens} tokens`]
            .filter(Boolean)
            .join(" · ") || undefined,
        tone: "info",
      };
    }
    case "agent.started":
      return {
        title: `${agentLabel(p.agent_type)} started`,
        tone: isDeterministicAgent(p.agent_type ?? "") ? "info" : "ai",
      };
    case "agent.completed":
      return {
        title: `${agentLabel(p.agent_type)} completed`,
        tone: isDeterministicAgent(p.agent_type ?? "") ? "info" : "ai",
      };
    case "agent.failed":
      return {
        title: `${agentLabel(p.agent_type)} failed`,
        detail: p.message ?? p.error_code,
        tone: "danger",
      };
    case "tool.started":
      return { title: `Tool ${p.tool_name ?? ""} started`, tone: "neutral", quiet: true };
    case "tool.completed":
      return { title: `Tool ${p.tool_name ?? ""}`, tone: "neutral" };
    case "patch.proposed": {
      const files = num("changed_files");
      const hash = str("patch_hash");
      return {
        title: "Patch proposed",
        detail:
          [files !== null && `${files} files`, hash && hash.slice(0, 19)]
            .filter(Boolean)
            .join(" · ") || undefined,
        tone: "ai",
      };
    }
    case "sandbox.started":
      return { title: "Isolated workspace started", detail: p.message, tone: "info" };
    case "verification.completed":
      return {
        title: p.passed === false ? "Verification failed" : "Verification completed",
        tone: p.passed === false ? "danger" : "success",
      };
    case "review.finding.created":
      return {
        title: `Finding: ${humanize(str("severity") ?? "")}`,
        detail: humanize(str("source") ?? ""),
        tone: str("source") === "ai_review" ? "ai" : "warning",
      };
    case "approval.required":
      return {
        title:
          p.approval_type === "pull_request"
            ? "Pull-request approval required"
            : "Plan approval required",
        tone: "warning",
      };
    case "pull_request.created":
      return { title: `Pull request #${num("pr_number") ?? ""} opened`, tone: "success" };
    case "run.completed":
      return { title: "Run completed", tone: "success" };
    case "run.failed":
      return { title: "Run failed", detail: p.message ?? p.error_code, tone: "danger" };
    case "run.cancelled":
      return { title: "Run cancelled", tone: "neutral" };
    default:
      return { title: humanize(event.type), tone: "neutral" };
  }
}

const AGENT_PHASE: Record<string, number> = {
  context_retriever: 0,
  investigator: 1,
  planner: 2,
  developer: 3,
  verification_engine: 4,
  repair: 4,
  reviewer: 5,
};

/** Furthest lifecycle phase a run reached, from durable steps and streamed events. */
export function reachedPhase(steps: Pick<AgentStep, "agent_type">[], events: RunEvent[]): number {
  let max = 0;
  for (const s of steps) max = Math.max(max, AGENT_PHASE[s.agent_type] ?? 0);
  for (const e of events)
    if (e.type === "run.status.changed" && e.payload.status)
      max = Math.max(max, phaseIndexOf(e.payload.status));
  return max;
}

/** Which cached run sections an event makes stale. */
export function partsInvalidatedBy(
  type: RunEventType,
): ("run" | "steps" | "plan" | "diff" | "verification" | "review" | "artifacts")[] {
  switch (type) {
    case "agent.completed":
    case "agent.failed":
    case "tool.completed":
    case "retrieval.completed":
      return ["run", "steps"];
    case "approval.required":
      return ["run", "plan", "steps"];
    case "patch.proposed":
      return ["run", "diff", "steps", "artifacts"];
    case "verification.completed":
      return ["run", "verification", "diff", "steps", "artifacts"];
    case "review.finding.created":
      return ["review"];
    case "pull_request.created":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
    case "run.status.changed":
      return ["run", "steps"];
    default:
      return [];
  }
}
