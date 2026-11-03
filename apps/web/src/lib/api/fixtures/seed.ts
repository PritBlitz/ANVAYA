/**
 * DEVELOPMENT FIXTURE — seeds a representative workspace with tasks and runs in
 * different lifecycle states so every screen has realistic data.
 */
import type * as T from "../types";
import { createRun, finish, nextId, PHASE_TWO, schedule, stageDurationMs, tick } from "./engine";
import { createSeedState, IDS, type FixtureRun, type FixtureState, type Scoped } from "./state";

function task(
  state: FixtureState,
  title: string,
  description: string,
  source_type: T.TaskSourceType,
  external_number: number | null,
  ageHours: number,
  labels: string[] = [],
): Scoped<T.EngineeringTask> {
  const iso = new Date(Date.now() - ageHours * 3_600_000).toISOString();
  const t: Scoped<T.EngineeringTask> = {
    id: nextId(state, "81000000"),
    workspace_id: IDS.workspace,
    repository_id: IDS.repoPayments,
    created_by: IDS.user,
    source_type,
    external_number,
    external_id: null,
    source_url: null,
    source_context: null,
    title,
    description,
    status: "open",
    labels,
    created_at: iso,
    updated_at: iso,
  };
  state.tasks.push(t);
  return t;
}

function approvePlan(state: FixtureState, run: FixtureRun, at: number) {
  const approval = {
    id: nextId(state, "61000000"),
    approval_type: "plan" as const,
    decision: "approved" as const,
    comment: "Scope looks right.",
    user_id: IDS.user,
    subject_hash: run.plan!.plan_hash,
    created_at: new Date(at).toISOString(),
  };
  run.approvals.push(approval);
  run.plan = { ...run.plan!, state: "approved", approval };
  schedule(run, PHASE_TWO, at);
}

export function createSeededState(): FixtureState {
  const state = createSeedState();
  const step = stageDurationMs();
  const now = Date.now();

  // 1. Awaiting plan approval
  const refresh = task(
    state,
    "Concurrent refresh requests sign users out",
    "Users are intermittently signed out when several API calls fire at once after the access token expires. Investigate the refresh flow and fix it without changing session storage.",
    "github_issue",
    214,
    5,
    ["auth", "bug"],
  );
  createRun(state, refresh, { mode: "local", base_branch: "main" }, now - 3_600_000);
  tick(state, now);

  // 2. Awaiting PR approval, with a blocking security finding
  const charge = task(
    state,
    "Send idempotency keys with charge retries",
    "createCharge retries on network failures without an idempotency key. Implement ADR-006 so retries can never double-charge a customer.",
    "manual",
    null,
    28,
    ["payments"],
  );
  const chargeStart = now - 26 * 3_600_000;
  const chargeRun = createRun(state, charge, { mode: "local", base_branch: "main" }, chargeStart);
  tick(state, chargeStart + step * 10);
  approvePlan(state, chargeRun, chargeStart + step * 12);
  tick(state, now);

  // 3. Completed with pull request
  const webhook = task(
    state,
    "Webhook handler accepts replayed events",
    "verifySignature only checks the timestamp tolerance. Reject events whose id was already processed (ADR-004 follow-up).",
    "github_issue",
    198,
    72,
    ["security"],
  );
  const whStart = now - 70 * 3_600_000;
  const whRun = createRun(state, webhook, { mode: "local", base_branch: "main" }, whStart);
  tick(state, whStart + step * 10);
  approvePlan(state, whRun, whStart + step * 12);
  tick(state, whStart + step * 40);
  whRun.pr_approved = true;
  whRun.approvals.push({
    id: nextId(state, "62000000"),
    approval_type: "pull_request",
    decision: "approved",
    comment: null,
    user_id: IDS.userMember,
    subject_hash: whRun.diff?.patch_hash ?? null,
    created_at: new Date(whStart + step * 45).toISOString(),
  });
  whRun.pull_request = {
    id: nextId(state, "63000000"),
    pr_number: 482,
    pr_url: "https://github.com/acme/payments-api/pull/482",
    head_branch: "anvaya/run-webhook-replay-protection",
    base_branch: "main",
    created_at: new Date(whStart + step * 46).toISOString(),
  };
  whRun.events.push({
    id: `evt_seed_pr_${whRun.id.slice(-6)}`,
    type: "pull_request.created",
    payload: {
      run_id: whRun.id,
      timestamp: new Date(whStart + step * 46).toISOString(),
      pr_number: 482,
      pr_url: "https://github.com/acme/payments-api/pull/482",
      head_branch: "anvaya/run-webhook-replay-protection",
    },
  });
  for (const f of whRun.review?.findings ?? []) f.status = "accepted";
  finish(state, whRun, "completed", whStart + step * 47);

  // 4. Failed verification
  const rounding = task(
    state,
    "Fix failing roundMinor test for USD amounts",
    "CI check `npm test` fails on main: roundMinor returns 1990 for 1999 minor units. Find the precision bug and fix it.",
    "github_issue",
    231,
    50,
    ["ci"],
  );
  const rStart = now - 48 * 3_600_000;
  const rRun = createRun(
    state,
    rounding,
    { mode: "local", base_branch: "main" },
    rStart,
    "verification_failed",
  );
  tick(state, rStart + step * 10);
  approvePlan(state, rRun, rStart + step * 12);
  tick(state, now);

  // 5. Open, never run
  task(
    state,
    "Document webhook retry semantics for partners",
    "Partners ask how often failed webhook deliveries are retried. Capture current behaviour from the code as an engineering note.",
    "manual",
    null,
    2,
    ["docs"],
  );

  // Historic usage across the last two weeks so Usage has a shape.
  for (let d = 13; d >= 1; d--) {
    const count = ((d * 7) % 5) + 1;
    for (let i = 0; i < count; i++) {
      state.usage.push({
        workspace_id: IDS.workspace,
        provider: "ollama",
        model: "qwen2.5-coder:7b",
        mode: "local",
        operation: i % 3 === 0 ? "question" : "planning",
        input_tokens: 1500 + ((d * 131 + i * 71) % 2200),
        output_tokens: 280 + ((d * 37 + i * 13) % 420),
        cost: 0,
        at: new Date(now - d * 86_400_000 + i * 3_600_000).toISOString(),
        run_id: null,
      });
    }
  }

  const auditSeed: [string, string, number, Record<string, unknown>][] = [
    ["git_installation.connected", "git_installation", 38 * 24, { account: "acme" }],
    ["repository.connected", "repository", 37 * 24, { full_name: "acme/payments-api" }],
    ["membership.invited", "invitation", 30 * 24, { role: "member" }],
    [
      "ai_policy.updated",
      "ai_policy",
      12 * 24,
      { fields: ["budgets"], data_handling: "local_only" },
    ],
    ["membership.role_changed", "membership", 9 * 24, { from: "member", to: "viewer" }],
  ];
  for (const [action, resource_type, hours, metadata] of auditSeed) {
    state.audit.push({
      id: nextId(state, "90000000"),
      workspace_id: IDS.workspace,
      actor_user_id: IDS.user,
      actor_display: "Ira Shah",
      actor_type: "user",
      action,
      resource_type,
      resource_id: IDS.repoPayments,
      request_id: `req_${(hours * 7919).toString(36)}`,
      metadata_redacted: metadata,
      created_at: new Date(now - hours * 3_600_000).toISOString(),
    });
  }
  state.audit.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return state;
}
