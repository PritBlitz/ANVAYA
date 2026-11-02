import { describe, expect, it } from "vitest";
import type { RunEvent } from "@/lib/api/types";
import { describeEvent, partsInvalidatedBy, reachedPhase } from "./events";
import { can } from "./permissions";
import {
  canCancelRun,
  canRetryRun,
  findingSourceMeta,
  isTerminalRun,
  phaseStates,
  runStatusMeta,
} from "./status";

const ev = (type: RunEvent["type"], payload: Partial<RunEvent["payload"]> = {}): RunEvent => ({
  id: Math.random().toString(),
  type,
  payload: { run_id: "r", timestamp: "2026-11-02T10:00:00Z", ...payload },
});

describe("run status", () => {
  it("marks approval waits as awaiting, not working", () => {
    expect(runStatusMeta("awaiting_plan_approval")).toMatchObject({
      awaiting: true,
      working: false,
      tone: "warning",
    });
    expect(runStatusMeta("implementing")).toMatchObject({ working: true });
    expect(runStatusMeta("something_new").label).toBe("Something new");
  });

  it("knows which actions apply", () => {
    expect(canCancelRun("verifying")).toBe(true);
    expect(canCancelRun("creating_pr")).toBe(false);
    expect(canCancelRun("completed")).toBe(false);
    expect(canRetryRun("failed")).toBe(true);
    expect(canRetryRun("rejected")).toBe(false);
    expect(isTerminalRun("completed_without_pr")).toBe(true);
  });

  it("derives stepper states", () => {
    expect(phaseStates("awaiting_plan_approval", 2)).toEqual([
      "done",
      "done",
      "waiting",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
    expect(phaseStates("completed", 6).every((s) => s === "done")).toBe(true);
    expect(phaseStates("completed_without_pr", 5).at(-1)).toBe("skipped");
    expect(phaseStates("failed", 4)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "failed",
      "upcoming",
      "upcoming",
    ]);
    expect(phaseStates("rejected", 2)[2]).toBe("skipped");
  });
});

describe("findings provenance", () => {
  it("separates AI review from deterministic tools (FR-VER-004)", () => {
    expect(findingSourceMeta("ai_review").deterministic).toBe(false);
    expect(findingSourceMeta("security_scanner").deterministic).toBe(true);
    expect(findingSourceMeta("static_analysis").deterministic).toBe(true);
  });
});

describe("events", () => {
  it("describes events for the activity log", () => {
    expect(describeEvent(ev("approval.required", { approval_type: "pull_request" })).title).toBe(
      "Pull-request approval required",
    );
    expect(describeEvent(ev("verification.completed", { passed: false })).tone).toBe("danger");
    expect(describeEvent(ev("agent.started", { agent_type: "planner" })).tone).toBe("ai");
    expect(describeEvent(ev("agent.started", { agent_type: "context_retriever" })).tone).toBe(
      "info",
    );
    expect(describeEvent(ev("run.stage.changed", { stage: "planning" })).quiet).toBe(true);
  });

  it("computes the furthest phase from steps and events", () => {
    expect(reachedPhase([{ agent_type: "planner" }], [])).toBe(2);
    expect(
      reachedPhase(
        [{ agent_type: "investigator" }],
        [ev("run.status.changed", { status: "verifying" })],
      ),
    ).toBe(4);
  });

  it("invalidates the right cached sections", () => {
    expect(partsInvalidatedBy("patch.proposed")).toContain("diff");
    expect(partsInvalidatedBy("review.finding.created")).toEqual(["review"]);
    expect(partsInvalidatedBy("tool.started")).toEqual([]);
  });
});

describe("permissions", () => {
  it("ranks roles", () => {
    expect(can("viewer", "tasks.create")).toBe(false);
    expect(can("member", "approvals.decide")).toBe(true);
    expect(can("member", "ai_policy.manage")).toBe(false);
    expect(can("admin", "members.manage")).toBe(true);
    expect(can(null, "audit.view")).toBe(false);
  });
});
