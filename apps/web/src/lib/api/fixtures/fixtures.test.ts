import { describe, expect, it } from "vitest";
import { ApiClient } from "../client";
import { createEndpoints } from "../endpoints";
import type { ApiError } from "../errors";
import { tick } from "./engine";
import { IDS } from "./state";
import { FixtureTransport } from "./transport";

/**
 * The fixture adapter must behave like the backend contract (docs/backend/
 * API_CONTRACT_NOTES.md), or UI built on it lies. These tests go through the real
 * client, endpoints and mappers, so they also exercise the wire → UI mapping.
 */
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

const raw = (
  transport: FixtureTransport,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  transport.request({
    method,
    path,
    body,
    headers: { "X-Workspace-Id": IDS.workspace, ...headers },
  });

describe("fixture adapter contract", () => {
  it("requires a session", async () => {
    const transport = new FixtureTransport({ persist: false });
    const api = createEndpoints(new ApiClient(transport));
    expect(await fail(api.me.get())).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("requires workspace scope, detects mismatches, and hides other tenants", async () => {
    const { api, client, transport } = setup();
    client.setWorkspace(null);
    expect(await fail(api.tasks.get("nope"))).toMatchObject({ status: 404 });
    const missing = await raw(transport, "GET", "/repositories", undefined, {
      "X-Workspace-Id": "",
    });
    expect(missing.status).toBe(422);
    const mismatch = await raw(transport, "GET", "/repositories?workspace_id=other");
    expect(mismatch.status).toBe(400);
    client.setWorkspace("other-workspace");
    expect(await fail(api.repositories.list())).toMatchObject({ status: 404 });
  });

  it("paginates with meta.page cursors", async () => {
    const { transport } = setup();
    const first = (await raw(transport, "GET", "/tasks?limit=2")).body as {
      data: unknown[];
      meta: { page: { next_cursor: string; has_more: boolean } };
    };
    expect(first.data).toHaveLength(2);
    expect(first.meta.page.has_more).toBe(true);
    const second = (
      await raw(transport, "GET", `/tasks?limit=2&cursor=${first.meta.page.next_cursor}`)
    ).body as { data: { id: string }[] };
    expect(second.data[0]).not.toEqual(first.data[0]);
  });

  it("rejects unknown body fields (strict validation) with details.issues", async () => {
    const { api } = setup();
    const err = await fail(
      api.repositories.createTask(
        IDS.repoPayments,
        {
          source_type: "manual",
          title: "Fine title",
          description: "Fine description.",
          ...({ extra: 1 } as object),
        } as never,
        "s1",
      ),
    );
    expect(err).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(err!.fieldErrors.extra).toMatch(/Unrecognized/);
  });

  it("enforces roles server-side", async () => {
    const { api } = setup(IDS.userViewer);
    const tasks = await api.tasks.list();
    expect(tasks.items.length).toBeGreaterThan(0);
    expect(
      await fail(api.tasks.startRun(tasks.items[0]!.id, { base_branch: "main" }, "k")),
    ).toMatchObject({ status: 403 });
    expect(
      await fail(api.workspaces.updateAiPolicy(IDS.workspace, { default_mode: "mock" })),
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

  it("imports GitHub issue tasks from the number only", async () => {
    const { api } = setup();
    const task = await api.repositories.createTask(
      IDS.repoPayments,
      { source_type: "github_issue", external_number: 77 },
      "gi",
    );
    expect(task).toMatchObject({ source_type: "github_issue", external_number: 77 });
    expect(task.title).toMatch(/#77/);
  });

  it("refuses modes the policy doesn't allow (no silent paid fallback)", async () => {
    const { api } = setup();
    const task = await api.repositories.createTask(
      IDS.repoPayments,
      { source_type: "manual", title: "Cloud try", description: "Should be refused." },
      "c1",
    );
    expect(
      await fail(api.tasks.startRun(task.id, { mode: "cloud", base_branch: "main" }, "c2")),
    ).toMatchObject({ status: 403, code: "MODE_NOT_ALLOWED" });
  });

  it("requires acknowledging the data disclosure to enable cloud inference", async () => {
    const { api } = setup();
    const err = await fail(
      api.workspaces.updateAiPolicy(IDS.workspace, { cloud: { enabled: true } }),
    );
    expect(err).toMatchObject({ status: 422, code: "DATA_DISCLOSURE_REQUIRED" });
    expect(err!.details.data_categories).toEqual(expect.arrayContaining(["source_code"]));
    const policy = await api.workspaces.updateAiPolicy(IDS.workspace, {
      cloud: { enabled: true },
      acknowledge_data_disclosure: true,
    });
    expect(policy.cloud.enabled).toBe(true);
    expect(policy.allowed_modes).toContain("cloud");
  });

  it("clamps client budgets to workspace limits", async () => {
    const { api } = setup();
    const task = await api.repositories.createTask(
      IDS.repoPayments,
      { source_type: "manual", title: "Budget test", description: "Clamp the budgets." },
      "b1",
    );
    const run = await api.tasks.startRun(
      task.id,
      { base_branch: "main", budgets: { max_steps: 999, max_changed_files: 2 } },
      "b2",
    );
    expect(run.budget.max_steps).toBe(8);
    expect(run.budget.max_changed_files).toBe(2);
  });

  it("runs the full lifecycle with hash-bound approval gates", async () => {
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
    const run = await api.tasks.startRun(task.id, { base_branch: "main" }, "t2");
    expect(run.status).toBe("queued");

    advance();
    const waiting = await api.runs.get(run.id);
    expect(waiting.status).toBe("awaiting_plan_approval");
    expect(waiting.task.title).toBe("Fix token refresh race");
    // No code before plan approval.
    expect(await fail(api.runs.diff(run.id))).toMatchObject({ status: 404 });

    const plan = await api.runs.plan(run.id);
    expect(plan).toMatchObject({ state: "proposed", editable: true, source: "agent" });
    expect(plan.plan.files_to_modify).toContain("src/auth/refresh.ts");

    // Edits are concurrency-checked against the plan hash.
    expect(await fail(api.runs.updatePlan(run.id, plan.plan, "sha256:stale"))).toMatchObject({
      status: 409,
      code: "PLAN_CHANGED",
    });
    const edited = await api.runs.updatePlan(
      run.id,
      { ...plan.plan, risks: [...plan.plan.risks, "Reviewed by a human"] },
      plan.plan_hash,
    );
    expect(edited).toMatchObject({ version: 2, state: "edited", source: "user_edit" });
    // Approving the old hash is refused; the current hash is accepted.
    expect(
      await fail(
        api.runs.decidePlan(run.id, { decision: "approved", plan_hash: plan.plan_hash }, "d0"),
      ),
    ).toMatchObject({ status: 409, code: "PLAN_CHANGED" });
    await api.runs.decidePlan(run.id, { decision: "approved", plan_hash: edited.plan_hash }, "d1");

    advance();
    const reviewed = await api.runs.get(run.id);
    expect(reviewed.status).toBe("awaiting_pr_approval");
    expect(reviewed.approvals?.[0]).toMatchObject({
      approval_type: "plan",
      decision: "approved",
      subject_hash: edited.plan_hash,
    });
    const diff = await api.runs.diff(run.id);
    expect(diff.changed_files.map((f) => [f.path, f.status])).toEqual([
      ["src/auth/refresh.ts", "modified"],
      ["test/auth/refresh.concurrency.test.ts", "added"],
    ]);
    expect(diff.changed_files[0]!.additions).toBeGreaterThan(0);
    const verification = await api.runs.verification(run.id);
    expect(verification.results.find((r) => r.profile_id === "node.test")).toMatchObject({
      status: "passed",
      exit_code: 0,
    });
    expect(verification.unavailable).toEqual([
      { profile_id: "node.build", reason: expect.any(String), kind: "unsupported" },
    ]);

    expect(
      await fail(api.runs.createPullRequest(run.id, { title: "Fix refresh" }, "p1")),
    ).toMatchObject({ status: 403 });
    expect(
      await fail(
        api.runs.decidePullRequest(
          run.id,
          { decision: "approved", patch_hash: "sha256:stale" },
          "a0",
        ),
      ),
    ).toMatchObject({ code: "PATCH_CHANGED" });
    await api.runs.decidePullRequest(
      run.id,
      { decision: "approved", patch_hash: diff.patch_hash },
      "a1",
    );
    const pr = await api.runs.createPullRequest(
      run.id,
      { title: "Fix refresh", body: "Summary." },
      "p2",
    );
    const again = await api.runs.createPullRequest(
      run.id,
      { title: "Fix refresh", body: "Summary." },
      "p2",
    );
    expect(again.pr_number).toBe(pr.pr_number);

    advance();
    const done = await api.runs.get(run.id);
    expect(done.status).toBe("completed");
    expect(done.pull_request).toMatchObject({ pr_number: pr.pr_number });
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
    const patch = (await api.runs.diff(chargeRun.id)).patch_hash;
    expect(
      await fail(
        api.runs.decidePullRequest(chargeRun.id, { decision: "approved", patch_hash: patch }, "x1"),
      ),
    ).toMatchObject({ status: 409, code: "BLOCKING_FINDINGS" });
    const review = await api.runs.review(chargeRun.id);
    const ai = review.findings.find((f) => f.source === "ai_review")!;
    expect(ai.confidence).toBe("high");
    const high = review.findings.find((f) => f.severity === "high")!;
    expect(
      await fail(api.runs.disposeFinding(chargeRun.id, high.id, { status: "dismissed" })),
    ).toMatchObject({ status: 422 });
    await api.runs.disposeFinding(chargeRun.id, high.id, { status: "fixed" });
    await expect(
      api.runs.decidePullRequest(chargeRun.id, { decision: "approved", patch_hash: patch }, "x2"),
    ).resolves.toBeDefined();
  });

  it("cancels and retries runs as new runs", async () => {
    const { api, transport } = setup();
    const failed = transport.state.runs.find((r) => r.status === "failed")!;
    expect(await fail(api.runs.cancel(failed.id, "c"))).toMatchObject({ status: 409 });
    const retry = await api.runs.retry(failed.id, "r");
    expect(retry.run_number).toBe(failed.run_number + 1);
    expect(retry.retry_of_run_id).toBe(failed.id);
    const cancelled = await api.runs.cancel(retry.id, "c2");
    expect(cancelled.status).toBe("cancelled");
  });

  it("issues single-use, server-held GitHub install state", async () => {
    const { api } = setup();
    const { url, state } = await api.github.installUrl(IDS.workspace);
    expect(url).toContain(`state=${state}`);
    expect(
      await fail(api.github.complete({ installation_id: 99001, state: "forged", code: "x" }, "g0")),
    ).toMatchObject({ status: 409 });
    const inst = await api.github.complete(
      { installation_id: 99001, state, code: "fixture-oauth-code", setup_action: "install" },
      "g1",
    );
    expect(inst.account_login).toBe("acme-labs");
    expect(
      await fail(
        api.github.complete({ installation_id: 99001, state, code: "fixture-oauth-code" }, "g2"),
      ),
    ).toMatchObject({ status: 409 });
    const repos = await api.github.availableRepositories(inst.id);
    expect(repos.map((r) => r.full_name)).toContain("acme-labs/checkout-service");
  });

  it("lists the tree one directory level at a time", async () => {
    const { api } = setup();
    const root = await api.repositories.tree(IDS.repoPayments);
    expect(root.entries.find((e) => e.name === "src")).toMatchObject({ type: "directory" });
    expect(root.entries.find((e) => e.name === "src")?.children).toBeUndefined();
    const auth = await api.repositories.tree(IDS.repoPayments, "src/auth");
    expect(auth.entries.map((e) => e.path)).toContain("src/auth/refresh.ts");
  });

  it("maps index status from the backend's coverage and jobs", async () => {
    const { api } = setup();
    const status = await api.repositories.indexStatus(IDS.repoMl);
    expect(status).toMatchObject({ indexing_status: "partial", active: false });
    expect(status.languages.find((l) => l.language === "jupyter")).toMatchObject({
      parser_supported: false,
    });
    expect(status.exclusions.map((e) => e.reason)).toContain("binary");
    expect(status.limitations.length).toBeGreaterThan(1);
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
    expect(answer).toMatchObject({ insufficient_evidence: true, citations: [], provider: null });
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

  it("streams run events and ends the stream after a terminal event", async () => {
    const { transport } = setup();
    const completed = transport.state.runs.find((r) => r.status === "completed")!;
    const received: string[] = [];
    const stop = transport.openEventStream(`/runs/${completed.id}/events`, {
      onEvent: (e) => received.push(e.type),
    });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(received[0]).toBe("run.created");
    expect(received.at(-1)).toBe("run.completed");
  });
});
