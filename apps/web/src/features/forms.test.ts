import { describe, expect, it } from "vitest";
import type {
  ReviewReport,
  RunDiff,
  RunPlan,
  VerificationReport,
  WorkflowRun,
} from "@/lib/api/types";
import { createWorkspaceSchema } from "./onboarding/create-workspace-form";
import { createTaskSchema, toCreateTaskRequest } from "./tasks/create-task-dialog";
import { clampBudgets } from "./tasks/start-run-form";
import { inviteSchema } from "./settings/members-settings";
import { formToPlan, planFormSchema, planToForm, undeclaredStepFiles } from "./runs/plan-schema";
import { buildPrBody, gateAllows, prGateChecks } from "./runs/pr-gate";
import { prSchema } from "./runs/pull-request-view";

const errorsOf = (r: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) => Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join("."), i.message]));

describe("form validation", () => {
  it("validates workspace slugs", () => {
    expect(createWorkspaceSchema.safeParse({ name: "Acme", slug: "acme-eng" }).success).toBe(true);
    for (const slug of ["Acme", "-acme", "acme-", "a", "ac me"]) {
      expect(createWorkspaceSchema.safeParse({ name: "Acme", slug }).success, slug).toBe(false);
    }
  });

  it("requires an external number for GitHub-sourced tasks", () => {
    const base = {
      repository_id: "r",
      title: "Fix the thing",
      description: "Long enough description.",
      start_now: false,
      template_key: "",
    };
    expect(createTaskSchema.safeParse({ ...base, source_type: "manual" }).success).toBe(true);
    const r = createTaskSchema.safeParse({
      ...base,
      source_type: "github_issue",
      external_number: "",
    });
    expect(errorsOf(r)).toHaveProperty("external_number");
    expect(
      createTaskSchema.safeParse({ ...base, source_type: "github_issue", external_number: "214" })
        .success,
    ).toBe(true);
    expect(
      errorsOf(
        createTaskSchema.safeParse({
          ...base,
          source_type: "manual",
          title: "x",
          repository_id: "",
        }),
      ),
    ).toMatchObject({
      title: expect.any(String),
      repository_id: "Choose a repository",
    });
  });

  it("validates pull-request and failing-check task sources and builds strict bodies", () => {
    const base = {
      repository_id: "r",
      title: "",
      description: "",
      start_now: false,
      template_key: "", // the dialog's default: no template
    };
    expect(
      errorsOf(
        createTaskSchema.safeParse({ ...base, source_type: "pull_request", external_number: "x" }),
      ),
    ).toHaveProperty("external_number");
    expect(
      errorsOf(
        createTaskSchema.safeParse({ ...base, source_type: "failing_check", check_run_id: "" }),
      ),
    ).toHaveProperty("check_run_id");
    const pr = createTaskSchema.parse({
      ...base,
      source_type: "pull_request",
      external_number: "87",
      include_review_comments: true,
    });
    expect(toCreateTaskRequest(pr)).toEqual({
      source_type: "pull_request",
      external_number: 87,
      include_review_comments: true,
    });
    const check = createTaskSchema.parse({
      ...base,
      source_type: "failing_check",
      check_run_id: "31000000001",
      external_number: "5",
    });
    // Only the check run id is sent: the server rejects external_number for failing checks.
    expect(toCreateTaskRequest(check)).toEqual({
      source_type: "failing_check",
      check_run_id: 31000000001,
    });
    const issue = createTaskSchema.parse({
      ...base,
      source_type: "github_issue",
      external_number: "9",
    });
    expect(toCreateTaskRequest(issue)).toEqual({ source_type: "github_issue", external_number: 9 });
  });

  it("validates invitations and pull requests", () => {
    expect(inviteSchema.safeParse({ email: "a@b.co", role: "member" }).success).toBe(true);
    expect(inviteSchema.safeParse({ email: "nope", role: "member" }).success).toBe(false);
    expect(inviteSchema.safeParse({ email: "a@b.co", role: "owner" }).success).toBe(false);
    expect(
      prSchema.safeParse({
        title: "Fix it now",
        body: "Long enough body",
        base_branch: "release/1.2",
      }).success,
    ).toBe(true);
    expect(
      prSchema.safeParse({
        title: "Fix it now",
        body: "Long enough body",
        base_branch: "main..evil",
      }).success,
    ).toBe(false);
  });

  it("clamps run budgets to policy maxima", () => {
    const max = {
      max_steps: 8,
      max_input_tokens: 12000,
      max_output_tokens: 4000,
      max_duration_seconds: 900,
      max_changed_files: 8,
      max_repair_attempts: 1,
    };
    expect(
      clampBudgets({ max_steps: 50, max_changed_files: 3, max_repair_attempts: -2 }, max),
    ).toMatchObject({ max_steps: 8, max_changed_files: 3, max_repair_attempts: 0 });
  });
});

const plan = {
  objective: "Serialize refreshes",
  assumptions: ["Rotation on"],
  steps: [
    {
      id: "step-1",
      description: "Add an in-flight promise",
      files: ["src/a.ts", "src/b.ts"],
      verification: ["tests pass"],
    },
  ],
  files_to_modify: ["src/a.ts"],
  tests: ["concurrency test"],
  risks: ["provider differences"],
  out_of_scope: [],
};

describe("plan editing", () => {
  it("round-trips through the form shape", () => {
    expect(formToPlan(planToForm(plan))).toEqual(plan);
  });

  it("rejects traversal paths and empty scope", () => {
    const values = { ...planToForm(plan), files_to_modify: "../secrets.env" };
    expect(errorsOf(planFormSchema.safeParse(values))).toHaveProperty("files_to_modify");
    expect(
      errorsOf(planFormSchema.safeParse({ ...planToForm(plan), files_to_modify: " \n " })),
    ).toHaveProperty("files_to_modify");
    expect(errorsOf(planFormSchema.safeParse({ ...planToForm(plan), steps: [] }))).toHaveProperty(
      "steps",
    );
  });

  it("reports step files missing from the declared scope", () => {
    expect(undeclaredStepFiles(plan)).toEqual(["src/b.ts"]);
  });
});

describe("pull-request gate", () => {
  const run = { id: "r", status: "awaiting_pr_approval" } as WorkflowRun;
  const runPlan = {
    plan: { ...plan, files_to_modify: ["src/a.ts"] },
    state: "approved",
    version: 2,
    plan_hash: "h",
  } as unknown as RunPlan;
  const diff = {
    unified_diff:
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    changed_files: [{ path: "src/a.ts" }],
    additions: 1,
    deletions: 1,
  } as RunDiff;
  const verification = {
    results: [
      { profile_id: "node.test", command_display: "npm test", status: "passed", exit_code: 0 },
    ],
    unavailable: [],
  } as unknown as VerificationReport;
  const review = {
    findings: [{ severity: "medium", status: "open", source: "ai_review", title: "Note" }],
  } as unknown as ReviewReport;

  it("passes with approved plan, in-scope diff, green checks, and no blocking findings", () => {
    const checks = prGateChecks({ run, plan: runPlan, diff, verification, review });
    expect(checks.map((c) => c.status)).toEqual(["pass", "pass", "pass", "warn"]);
    expect(gateAllows(checks)).toBe(true);
  });

  it("blocks on failing checks or open high-severity findings", () => {
    const failing = {
      ...verification,
      results: [{ ...verification.results[0]!, status: "failed", exit_code: 1 }],
    } as VerificationReport;
    expect(
      gateAllows(prGateChecks({ run, plan: runPlan, diff, verification: failing, review })),
    ).toBe(false);
    const blocking = {
      findings: [{ severity: "high", status: "open", source: "security_scanner" }],
    } as unknown as ReviewReport;
    expect(
      gateAllows(prGateChecks({ run, plan: runPlan, diff, verification, review: blocking })),
    ).toBe(false);
    expect(gateAllows(prGateChecks({ run }))).toBe(false);
  });

  it("judges only the patch awaiting approval, not superseded repair attempts", () => {
    const attempt = (n: number, patch: string, status: string) =>
      ["compile", "test"].map((p) => ({
        profile_id: p,
        command_display: p,
        status,
        exit_code: status === "passed" ? 0 : 1,
        attempt: n,
        patch_id: patch,
      }));
    const repaired = {
      results: [...attempt(1, "p1", "failed"), ...attempt(2, "p2", "passed")],
      current_patch_id: "p2",
      unavailable: [],
    } as unknown as VerificationReport;
    const checks = prGateChecks({ run, plan: runPlan, diff, verification: repaired, review });
    expect(checks.find((c) => c.id === "verification")).toMatchObject({
      status: "pass",
      detail: "2 passed",
    });
    expect(gateAllows(checks)).toBe(true);
    // Without a current patch id, the latest attempt decides.
    const noId = { ...repaired, current_patch_id: null } as VerificationReport;
    expect(gateAllows(prGateChecks({ run, plan: runPlan, diff, verification: noId, review }))).toBe(
      true,
    );
    // A failing current patch still blocks.
    const stillFailing = { ...repaired, current_patch_id: "p1" } as VerificationReport;
    expect(
      gateAllows(prGateChecks({ run, plan: runPlan, diff, verification: stillFailing, review })),
    ).toBe(false);
  });

  it("builds an evidence-backed description", () => {
    const body = buildPrBody({
      task: { title: "T", source_type: "github_issue", external_number: 214 },
      plan: runPlan,
      diff,
      verification,
      review,
    });
    expect(body).toContain("Closes #214");
    expect(body).toContain("| node.test | `npm test` | passed | 0 |");
    expect(body).toContain("(AI review)");
    expect(body).toMatch(/does not merge/);
  });
});
