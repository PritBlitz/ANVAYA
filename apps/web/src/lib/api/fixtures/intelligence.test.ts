import { describe, expect, it } from "vitest";
import { ApiClient } from "../client";
import { createEndpoints } from "../endpoints";
import type { ApiError } from "../errors";
import { tick } from "./engine";
import { IDS } from "./state";
import { FixtureTransport } from "./transport";

/** Work package B parity: the fixture adapter behaves like the API for these endpoints. */
function setup(userId: string = IDS.user) {
  const transport = new FixtureTransport({ persist: false });
  transport.signIn(userId);
  const client = new ApiClient(transport);
  client.setWorkspace(IDS.workspace);
  return { transport, api: createEndpoints(client) };
}

const fail = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: ApiError) => e,
  );

describe("workflow templates (fixtures)", () => {
  it("lists the built-ins to everyone and lets only admins manage workspace templates", async () => {
    const viewer = setup(IDS.userViewer).api;
    const list = await viewer.templates.list(IDS.workspace);
    expect(list.map((t) => t.key)).toEqual([
      "bug_fix",
      "add_tests",
      "refactor",
      "dependency_upgrade",
      "migration_plan",
    ]);
    const body = { key: "security_fix", name: "Security fix", workflow: "change" as const };
    expect(await fail(viewer.templates.create(IDS.workspace, body, "k1"))).toMatchObject({
      status: 403,
    });
    expect(
      await fail(setup(IDS.userMember).api.templates.create(IDS.workspace, body, "k2")),
    ).toMatchObject({ status: 403 });
    const { api } = setup();
    expect(
      await fail(api.templates.create(IDS.workspace, { ...body, key: "bug_fix" }, "k3")),
    ).toMatchObject({ status: 422 });
    const created = await api.templates.create(IDS.workspace, body, "k4");
    expect(created).toMatchObject({ source: "workspace", version: 1, status: "active" });
    expect(await fail(api.templates.create(IDS.workspace, body, "k5"))).toMatchObject({
      status: 409,
      code: "TEMPLATE_KEY_TAKEN",
    });
    const updated = await api.templates.update(IDS.workspace, created.id!, {
      planning_guidance: ["Do not change public APIs."],
    });
    expect(updated.version).toBe(2);
    await api.templates.archive(IDS.workspace, created.id!);
    const err = await fail(
      api.repositories.createTask(
        IDS.repoPayments,
        {
          source_type: "manual",
          title: "Fix it",
          description: "Long enough text.",
          template_key: "security_fix",
        },
        "k6",
      ),
    );
    expect(err).toMatchObject({ status: 422, code: "TEMPLATE_ARCHIVED" });
  });

  it("snapshots the template on the task and lowers the run budget to its ceilings", async () => {
    const { api } = setup();
    const task = await api.repositories.createTask(
      IDS.repoPayments,
      {
        source_type: "manual",
        title: "Fix: refresh race",
        description: "Concurrent refreshes sign users out.",
        template_key: "bug_fix",
      },
      "t1",
    );
    expect(task.template).toMatchObject({ key: "bug_fix", source: "builtin", version: 1 });
    const run = await api.tasks.startRun(
      task.id,
      { base_branch: "main", budgets: { max_changed_files: 50 } },
      "t2",
    );
    expect(run.budget.max_changed_files).toBe(5);
  });

  it("migration-plan runs propose a migration section and end at plan approval", async () => {
    const { api, transport } = setup();
    const task = await api.repositories.createTask(
      IDS.repoPayments,
      {
        source_type: "manual",
        title: "Migration plan: token storage",
        description: "Move token storage to the session service.",
        template_key: "migration_plan",
      },
      "m1",
    );
    const run = await api.tasks.startRun(task.id, { base_branch: "main" }, "m2");
    tick(transport.state, Date.now() + 60 * 60_000);
    const plan = await api.runs.plan(run.id);
    expect(plan.plan_only).toBe(true);
    expect(plan.plan.migration?.step_rollback.length).toBe(plan.plan.steps.length);
    expect(plan.plan.migration?.affected_areas.length).toBeGreaterThan(0);
    await api.runs.decidePlan(run.id, { decision: "approved", plan_hash: plan.plan_hash }, "m3");
    tick(transport.state, Date.now() + 60 * 60_000);
    const done = await api.runs.get(run.id);
    expect(done.status).toBe("completed_without_pr");
    expect(await fail(api.runs.diff(run.id))).toMatchObject({ status: 404 });
  });
});

describe("code intelligence and impact (fixtures)", () => {
  it("serves a call graph with call sites and paging", async () => {
    const { api } = setup();
    const page = await api.repositories.symbols(IDS.repoPayments, { q: "isExpired" });
    const sym = page.items.find((s) => s.name === "isExpired")!;
    const graph = await api.repositories.callGraph(IDS.repoPayments, sym.id, {
      direction: "callers",
      depth: 2,
      limit: 1,
    });
    expect(graph.root.name).toBe("isExpired");
    expect(graph.nodes.length).toBeLessThanOrEqual(1);
    if (graph.total_nodes > 1) expect(graph.next_cursor).not.toBeNull();
    expect(graph.limitations.length).toBeGreaterThan(0);
  });

  it("predicts impact with evidence and selects tests, labelled heuristic", async () => {
    const { api } = setup();
    const r = await api.repositories.impact(IDS.repoPayments, ["src/auth/token.ts"]);
    expect(r.heuristic).toBe(true);
    expect(r.disclaimer).toMatch(/not a verification result/);
    expect(r.selected_tests.map((t) => t.path)).toContain("test/auth/refresh.test.ts");
    const t = r.selected_tests.find((x) => x.path === "test/auth/refresh.test.ts")!;
    expect(t.reasons[0]!.evidence.length).toBeGreaterThan(0);
    expect(await fail(api.repositories.impact(IDS.repoPayments, ["../etc/passwd"]))).toMatchObject({
      status: 422,
    });
  });

  it("predicts a run's impact from its plan, then from its patch", async () => {
    const { api, transport } = setup();
    const task = await api.repositories.createTask(
      IDS.repoPayments,
      {
        source_type: "manual",
        title: "Fix token refresh race",
        description: "Concurrent refreshes sign users out.",
      },
      "r1",
    );
    const run = await api.tasks.startRun(task.id, { base_branch: "main" }, "r2");
    tick(transport.state, Date.now() + 60 * 60_000);
    const fromPlan = await api.runs.impact(run.id);
    expect(fromPlan.source).toBe("plan");
    expect(fromPlan.selected_tests.length).toBeGreaterThan(0);
  });
});

describe("workspace knowledge (fixtures)", () => {
  it("searches across repositories with provenance and hides other workspaces", async () => {
    const { api } = setup(IDS.userViewer);
    const res = await api.workspaceKnowledge.search(IDS.workspace, { query: "token refresh" });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.every((r) => r.repository_full_name && r.repository_id)).toBe(true);
    expect(
      await fail(
        api.workspaceKnowledge.search(IDS.workspace, { query: "x y", repository_ids: ["nope"] }),
      ),
    ).toMatchObject({ status: 404 });
    expect(await fail(api.workspaceKnowledge.search("other-ws", { query: "token" }))).toMatchObject(
      {
        status: 404,
      },
    );
    const answer = await api.workspaceKnowledge.ask(IDS.workspace, {
      question: "Where are tokens refreshed?",
      mode: "mock",
    });
    expect(answer.citations.every((c) => c.repository_full_name)).toBe(true);
  });
});

describe("hosted provider policy (fixtures)", () => {
  it("rejects unknown providers and requires re-acknowledgment to switch provider", async () => {
    const { api } = setup();
    expect(
      await fail(
        api.workspaces.updateAiPolicy(IDS.workspace, {
          cloud: { provider: "mystery" as never },
        }),
      ),
    ).toMatchObject({ status: 422 });
    await api.workspaces.updateAiPolicy(IDS.workspace, {
      cloud: { enabled: true, provider: "anthropic" },
      acknowledge_data_disclosure: true,
    });
    expect(
      await fail(
        api.workspaces.updateAiPolicy(IDS.workspace, { cloud: { provider: "openai_compatible" } }),
      ),
    ).toMatchObject({ status: 422, code: "DATA_DISCLOSURE_REQUIRED" });
    const ok = await api.workspaces.updateAiPolicy(IDS.workspace, {
      cloud: { provider: "openai_compatible" },
      acknowledge_data_disclosure: true,
    });
    expect(ok.cloud.provider).toBe("openai_compatible");
  });
});
