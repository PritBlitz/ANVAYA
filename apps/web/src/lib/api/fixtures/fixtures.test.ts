import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client";
import { createEndpoints } from "../endpoints";
import type { ApiError } from "../errors";
import { tick } from "./engine";
import { IDS } from "./state";
import { FixtureTransport } from "./transport";

/** The fixture adapter must behave like the documented API, or UI built on it lies. */
function setup(userId: string = IDS.user) {
  const transport = new FixtureTransport({ persist: false });
  transport.signIn(userId);
  const client = new ApiClient(transport);
  client.setWorkspace(IDS.workspace);
  return { transport, client, api: createEndpoints(client) };
}

const fail = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: ApiError) => e,
  );

describe("fixture adapter contract", () => {
  beforeEach(() => vi.useRealTimers());

  it("requires a session", async () => {
    const transport = new FixtureTransport({ persist: false });
    const api = createEndpoints(new ApiClient(transport));
    expect(await fail(api.me.get())).toMatchObject({ status: 401 });
  });

  it("requires workspace scope on collections and hides other tenants", async () => {
    const { api, client } = setup();
    client.setWorkspace(null);
    expect(await fail(api.repositories.list())).toMatchObject({
      status: 400,
      code: "WORKSPACE_REQUIRED",
    });
    client.setWorkspace("other-workspace");
    expect(await fail(api.repositories.list())).toMatchObject({ status: 404 });
  });

  it("enforces roles server-side", async () => {
    const { api } = setup(IDS.userViewer);
    const tasks = await api.tasks.list();
    expect(tasks.items.length).toBeGreaterThan(0);
    expect(
      await fail(
        api.tasks.startRun(tasks.items[0]!.id, { mode: "local", base_branch: "main" }, "k"),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await fail(api.workspaces.updateAiPolicy(IDS.workspace, { cloud_inference_enabled: true })),
    ).toMatchObject({ status: 403 });
  });

  it("replays idempotent requests and rejects key reuse with a different body", async () => {
    const { api } = setup();
    const body = {
      source_type: "manual" as const,
      title: "A new task",
      description: "Something to investigate.",
    };
    const a = await api.repositories.createTask(IDS.repoPayments, body, "same-key");
    const b = await api.repositories.createTask(IDS.repoPayments, body, "same-key");
    expect(b.id).toBe(a.id);
    expect(
      await fail(
        api.repositories.createTask(IDS.repoPayments, { ...body, title: "Different" }, "same-key"),
      ),
    ).toMatchObject({ status: 409 });
  });

  it("returns field-level validation errors", async () => {
    const { api } = setup();
    const err = await fail(
      api.repositories.createTask(
        IDS.repoPayments,
        { source_type: "manual", title: "x", description: "short" },
        "v",
      ),
    );
    expect(err).toMatchObject({ status: 422 });
    expect(err!.fieldErrors.title).toBeTruthy();
  });

  it("refuses cloud runs when policy disables them (no silent paid fallback)", async () => {
    const { api } = setup();
    const task = await api.repositories.createTask(
      IDS.repoPayments,
      { source_type: "manual", title: "Cloud try", description: "Should be refused." },
      "c1",
    );
    expect(
      await fail(api.tasks.startRun(task.id, { mode: "cloud", base_branch: "main" }, "c2")),
    ).toMatchObject({ status: 403, code: "PROVIDER_NOT_PERMITTED" });
  });

  it("clamps client budgets to policy", async () => {
    const { api } = setup();
    const task = await api.repositories.createTask(
      IDS.repoPayments,
      { source_type: "manual", title: "Budget test", description: "Clamp the budgets." },
      "b1",
    );
    const run = await api.tasks.startRun(
      task.id,
      { mode: "local", base_branch: "main", budgets: { max_steps: 999, max_changed_files: 2 } },
      "b2",
    );
    expect(run.budget.max_steps).toBe(8);
    expect(run.budget.max_changed_files).toBe(2);
  });

  it("runs the full lifecycle with approval gates", async () => {
    const { api, transport } = setup();
    const advance = () => tick(transport.state, Date.now() + 60 * 60_000);
    const task = await api.repositories.createTask(
      IDS.repoPayments,
      {
        source_type: "manual",
        title: "Fix token refresh race",
        description: "Concurrent refreshes sign users out.",
      },
      "t1",
    );
    const run = await api.tasks.startRun(task.id, { mode: "local", base_branch: "main" }, "t2");
    expect(run.status).toBe("queued");

    advance();
    expect((await api.runs.get(run.id)).status).toBe("awaiting_plan_approval");
    // No code before plan approval.
    expect(await fail(api.runs.diff(run.id))).toMatchObject({ status: 404 });
    // PR cannot be created yet.
    expect(
      await fail(
        api.runs.createPullRequest(
          run.id,
          { title: "Nope nope", body: "Not allowed yet.", base_branch: "main" },
          "p0",
        ),
      ),
    ).toMatchObject({ status: 409 });

    const plan = await api.runs.plan(run.id);
    expect(plan.plan.files_to_modify).toContain("src/auth/refresh.ts");
    expect(await fail(api.runs.decidePlan(run.id, { decision: "rejected" }, "d0"))).toMatchObject({
      status: 422,
    });
    await api.runs.decidePlan(run.id, { decision: "approved" }, "d1");

    advance();
    const reviewed = await api.runs.get(run.id);
    expect(reviewed.status).toBe("awaiting_pr_approval");
    const diff = await api.runs.diff(run.id);
    expect(diff.changed_files.map((f) => f.path)).toEqual([
      "src/auth/refresh.ts",
      "test/auth/refresh.concurrency.test.ts",
    ]);
    const verification = await api.runs.verification(run.id);
    expect(verification.results.find((r) => r.profile_id === "node.test")).toMatchObject({
      status: "passed",
      exit_code: 0,
    });

    // Creating a PR without approval is forbidden.
    expect(
      await fail(
        api.runs.createPullRequest(
          run.id,
          { title: "Fix refresh", body: "Evidence here.", base_branch: "main" },
          "p1",
        ),
      ),
    ).toMatchObject({ status: 403 });
    await api.runs.decidePullRequest(run.id, { decision: "approved" }, "a1");
    const pr = await api.runs.createPullRequest(
      run.id,
      { title: "Fix refresh", body: "Evidence here.", base_branch: "main" },
      "p2",
    );
    const again = await api.runs.createPullRequest(
      run.id,
      { title: "Fix refresh", body: "Evidence here.", base_branch: "main" },
      "p2",
    );
    expect(again.pr_number).toBe(pr.pr_number);

    advance();
    expect((await api.runs.get(run.id)).status).toBe("completed");
    const types = transport.state.runs.find((r) => r.id === run.id)!.events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "run.created",
        "approval.required",
        "patch.proposed",
        "verification.completed",
        "pull_request.created",
        "run.completed",
      ]),
    );
  });

  it("blocks PR approval while high-severity findings are open", async () => {
    const { api, transport } = setup();
    const chargeRun = transport.state.runs.find((r) => r.status === "awaiting_pr_approval")!;
    expect(
      await fail(api.runs.decidePullRequest(chargeRun.id, { decision: "approved" }, "x1")),
    ).toMatchObject({ status: 409, code: "BLOCKING_FINDINGS" });
    const high = (await api.runs.review(chargeRun.id)).findings.find((f) => f.severity === "high")!;
    expect(
      await fail(api.runs.disposeFinding(chargeRun.id, high.id, { disposition: "dismiss" })),
    ).toMatchObject({ status: 422 });
    await api.runs.disposeFinding(chargeRun.id, high.id, { disposition: "fix" });
    await expect(
      api.runs.decidePullRequest(chargeRun.id, { decision: "approved" }, "x2"),
    ).resolves.toMatchObject({ decision: "approved" });
  });

  it("cancels and retries runs as new runs", async () => {
    const { api, transport } = setup();
    const failed = transport.state.runs.find((r) => r.status === "failed")!;
    expect(await fail(api.runs.cancel(failed.id, "c"))).toMatchObject({ status: 409 });
    const retry = await api.runs.retry(failed.id, "r");
    expect(retry.run_number).toBe(failed.run_number + 1);
    const cancelled = await api.runs.cancel(retry.id, "c2");
    expect(cancelled.status).toBe("cancelled");
  });

  it("searches indexed code and refuses to invent citations", async () => {
    const { api } = setup();
    const res = await api.repositories.search(IDS.repoPayments, {
      query: "refresh token expiry",
      snapshot: "latest",
      top_k: 5,
    });
    expect(res.results[0]).toMatchObject({
      file_path: expect.stringMatching(/src\/auth/),
      commit_sha: expect.any(String),
      content_hash: expect.stringMatching(/^sha256:/),
    });
    const answer = await api.repositories.ask(IDS.repoPayments, {
      question: "What is the capital of France?",
    });
    expect(answer.citations).toEqual([]);
    expect(answer.limitations.length).toBeGreaterThan(0);
  });

  it("never serves excluded files", async () => {
    const { api } = setup();
    expect(
      await fail(api.repositories.fileContent(IDS.repoPayments, ".env.example")),
    ).toMatchObject({ status: 403, code: "FILE_EXCLUDED" });
    expect(
      await fail(api.repositories.fileContent(IDS.repoPayments, "../etc/passwd")),
    ).toMatchObject({ status: 400 });
  });

  it("streams run events", async () => {
    const { transport } = setup();
    const run = transport.state.runs[0]!;
    const received: string[] = [];
    const stop = transport.openEventStream(`/runs/${run.id}/events`, {
      onEvent: (e) => received.push(e.type),
    });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(received[0]).toBe("run.created");
    expect(received.length).toBe(run.events.length);
  });
});
