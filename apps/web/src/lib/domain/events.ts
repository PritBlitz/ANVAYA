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
  const agent = str("agent");
  const tool = str("tool");
  const detail = (...parts: (string | false | null | undefined)[]) =>
    parts.filter(Boolean).join(" · ") || undefined;
  switch (event.type as RunEventType) {
    case "run.created":
      return { title: "Run created", tone: "neutral" };
    case "run.status.changed": {
      const meta = runStatusMeta(str("status") ?? "");
      return {
        title: meta.label,
        detail: str("reason") ?? undefined,
        tone: meta.awaiting ? "warning" : "neutral",
      };
    }
    case "run.stage.changed":
      return { title: `Stage: ${humanize(str("stage") ?? "")}`, tone: "neutral", quiet: true };
    case "retrieval.completed": {
      const count = num("count");
      const semantic = str("semantic");
      return {
        title: "Evidence retrieved",
        detail: detail(
          count !== null && `${count} chunks`,
          semantic && semantic !== "ok" && `semantic search ${semantic}`,
        ),
        tone: "info",
      };
    }
    case "agent.started":
      return {
        title: `${agentLabel(agent)} started`,
        tone: isDeterministicAgent(agent ?? "") ? "info" : "ai",
      };
    case "agent.completed": {
      const tokens = (num("input_tokens") ?? 0) + (num("output_tokens") ?? 0);
      return {
        title: `${agentLabel(agent)} completed`,
        detail: detail(str("model"), tokens > 0 && `${tokens} tokens`),
        tone: isDeterministicAgent(agent ?? "") ? "info" : "ai",
      };
    }
    case "agent.failed":
      return {
        title: `${agentLabel(agent)} failed`,
        detail: str("error_code") ?? undefined,
        tone: "danger",
      };
    case "tool.started":
      return { title: `Tool ${tool ?? ""} started`, tone: "neutral", quiet: true };
    case "tool.completed":
      return {
        title: `Tool ${tool ?? ""}`,
        detail: str("status") ?? undefined,
        tone: str("status") === "failed" ? "danger" : "neutral",
      };
    case "patch.proposed": {
      const files = num("changed_files");
      const hash = str("patch_hash");
      const attempt = num("attempt");
      return {
        title:
          attempt && attempt > 1 ? `Repair patch proposed (attempt ${attempt})` : "Patch proposed",
        detail: detail(files !== null && `${files} files`, hash && hash.slice(0, 19)),
        tone: "ai",
      };
    }
    case "sandbox.started":
      return {
        title: "Isolated workspace started",
        detail: detail(str("profile"), str("command")),
        tone: "info",
      };
    case "verification.completed": {
      const status = str("status");
      const failed = status !== null && status !== "passed" && status !== "skipped";
      return {
        title: `${str("profile") ?? "Verification"} ${status ?? "completed"}`,
        detail: num("exit_code") !== null ? `exit ${num("exit_code")}` : undefined,
        tone: failed ? "danger" : status === "skipped" ? "neutral" : "success",
      };
    }
    case "review.finding.created":
      return {
        title: `Finding: ${humanize(str("severity") ?? "")}`,
        detail: detail(humanize(str("source") ?? ""), str("file_path")),
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
      return {
        title: `Pull request #${num("pr_number") ?? ""} opened`,
        detail: str("head_branch") ?? undefined,
        tone: "success",
      };
    case "run.completed":
      return { title: "Run completed", tone: "success" };
    case "run.failed":
      return {
        title: "Run failed",
        detail: detail(str("error_code"), str("error_summary")),
        tone: "danger",
      };
    case "run.cancelled":
      return { title: "Run cancelled", tone: "neutral" };
    default:
      return { title: humanize(event.type), tone: "neutral" };
  }
}

/** Terminal events: the server closes the stream after these (do not reconnect). */
export function isTerminalEvent(type: string): boolean {
  return type === "run.completed" || type === "run.failed" || type === "run.cancelled";
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
    if (e.type === "run.status.changed" && typeof e.payload.status === "string")
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
