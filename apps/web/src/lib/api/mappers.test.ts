import { describe, expect, it } from "vitest";
import * as M from "./mappers";
import type * as W from "./wire";

/**
 * Samples follow the backend's documented responses (docs/backend/API_CONTRACT_NOTES.md),
 * not the fixture adapter, so these tests pin the integration boundary independently.
 */
describe("wire → UI mappers", () => {
  it("maps index status: coverage, active job progress, limitations", () => {
    const w: W.WIndexStatus = {
      repository_id: "r1",
      indexing_status: "indexing",
      latest_snapshot: {
        id: "s1",
        commit_sha: "abc1234",
        branch_name: "main",
        status: "processing",
        parser_version: "ts@1",
        chunker_version: "c@1",
        embedding_model: "nomic",
        limitations: "Embeddings unavailable; lexical only.",
        completed_at: null,
      },
      coverage: {
        total_files: 10,
        indexed_files: 4,
        excluded_files: 2,
        failed_files: 0,
        reused_files: 0,
        excluded_by_reason: { secret: 1, binary: 1, generated: 0 },
        parse_status: { parsed: 3 },
        languages: { python: { files: 3, parsed: 3 }, markdown: { files: 2, parsed: 0 } },
        chunks: 9,
        embedded_chunks: 0,
      },
      active_job: {
        id: "j1",
        status: "running",
        stage: "processing_files",
        trigger: "manual",
        commit_sha: "abc1234",
        progress: { files_total: 10, files_processed: 4 },
        attempts: 1,
        error_code: null,
        error_summary: null,
        created_at: "t",
        started_at: "t",
        ended_at: null,
      },
      last_job: null,
      supported_parsers: ["typescript", "javascript", "python"],
    };
    const s = M.toIndexStatus(w);
    expect(s.active).toBe(true);
    expect(s.progress).toEqual({
      phase: "Parsing and chunking files",
      processed_files: 4,
      total_files: 10,
    });
    expect(s.languages).toEqual([
      { language: "python", files: 3, indexed_files: 3, parser_supported: true },
      { language: "markdown", files: 2, indexed_files: 0, parser_supported: false },
    ]);
    expect(s.exclusions).toEqual([
      { reason: "secret", files: 1 },
      { reason: "binary", files: 1 },
    ]);
    expect(s.limitations).toEqual(["Embeddings unavailable; lexical only."]);
    expect(s.snapshot).toMatchObject({ commit_sha: "abc1234", total_files: 10, indexed_files: 4 });
  });

  it("maps a never-indexed repository", () => {
    const s = M.toIndexStatus({
      repository_id: "r",
      indexing_status: "pending",
      latest_snapshot: null,
      coverage: null,
      active_job: null,
      last_job: null,
      supported_parsers: [],
    });
    expect(s).toMatchObject({
      snapshot: null,
      progress: null,
      languages: [],
      exclusions: [],
      active: false,
    });
  });

  it("maps a run with R1/GAP-19 context and approvals", () => {
    const run = M.toRun({
      id: "run1",
      task_id: "t1",
      workspace_id: "w",
      repository_id: "r1",
      run_number: 2,
      status: "awaiting_pr_approval",
      current_stage: "review",
      mode: "local",
      provider: "ollama",
      model: "qwen",
      base_branch: "main",
      snapshot_id: "s",
      state_version: 7,
      budget: { max_steps: 8 },
      usage_summary: { input_tokens: 10, output_tokens: 5, model_calls: 3, agent_steps: 4 },
      retry_of_run_id: null,
      error_code: null,
      error_summary: null,
      cancel_requested_at: null,
      started_at: "a",
      ended_at: null,
      created_at: "a",
      updated_at: "b",
      plan_hash: "sha256:p",
      approvals: [
        {
          id: "ap1",
          approval_type: "plan",
          decision: "approved",
          subject_hash: "sha256:p",
          comment: null,
          user_id: "u1",
          created_at: "c",
        },
      ],
      task_title: "Fix refresh",
      repository_full_name: "acme/api",
      pull_request: null,
    });
    expect(run.task).toEqual({
      id: "t1",
      title: "Fix refresh",
      repository_id: "r1",
      repository_full_name: "acme/api",
    });
    expect(run.usage_summary.steps).toBe(4);
    expect(run.approvals?.[0]).toMatchObject({ approval_type: "plan", subject_hash: "sha256:p" });
    expect(run.pull_request).toBeNull();
  });

  it("degrades when R1 fields are absent", () => {
    const run = M.toRun({
      id: "x",
      task_id: "t",
      workspace_id: "w",
      repository_id: "r",
      run_number: 1,
      status: "queued",
      current_stage: null,
      mode: "mock",
      provider: null,
      model: null,
      base_branch: null,
      snapshot_id: null,
      state_version: 1,
      budget: {},
      usage_summary: {},
      retry_of_run_id: null,
      error_code: null,
      error_summary: null,
      cancel_requested_at: null,
      started_at: null,
      ended_at: null,
      created_at: "a",
      updated_at: "a",
    });
    expect(run.task).toEqual({
      id: "t",
      title: null,
      repository_id: "r",
      repository_full_name: null,
    });
    expect(run.approvals).toEqual([]);
  });

  it("maps diff actions and per-file line counts from the unified diff", () => {
    const d = M.toRunDiff({
      patch_id: "p1",
      patch_hash: "sha256:h",
      attempt: 2,
      base_commit_sha: "abc",
      summary: "Serialize refresh",
      additions: 3,
      deletions: 1,
      changed_files: [
        { path: "src/a.ts", action: "modify", explanation: "Add guard" },
        { path: "test/a.test.ts", action: "create" },
      ],
      diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-x\n+y\n+z\ndiff --git a/test/a.test.ts b/test/a.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/test/a.test.ts\n@@ -0,0 +1 @@\n+t\n",
      diff_truncated: true,
    });
    expect(d.changed_files).toEqual([
      {
        path: "src/a.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        explanation: "Add guard",
      },
      { path: "test/a.test.ts", status: "added", additions: 1, deletions: 0, explanation: null },
    ]);
    expect(d).toMatchObject({ attempt: 2, truncated: true, summary: "Serialize refresh" });
  });

  it("joins verification output and keeps unavailable profiles separate", () => {
    const v = M.toVerification({
      deterministic: true,
      current_patch_id: "p",
      summary: { passed: 0, failed: 1, timed_out: 0, skipped: 0, unavailable: 1 },
      results: [
        {
          profile_id: "node-test",
          command_display: "npm test",
          status: "failed",
          exit_code: 1,
          duration_ms: 900,
          stdout_excerpt: "1 failed",
          stderr_excerpt: "AssertionError",
          attempt: 1,
        },
      ],
      unavailable: [
        { profile_id: "python-unittest", reason: "No Python files", kind: "unsupported" },
      ],
    });
    expect(v.results[0]!.output_excerpt).toBe("1 failed\nAssertionError");
    expect(v.unavailable_count).toBe(1);
    expect(v.unavailable[0]!.kind).toBe("unsupported");
    expect(v.ai_summary).toBeNull();
  });

  it("merges deterministic and AI findings with AI-only confidence", () => {
    const base = {
      file_path: "a.ts",
      start_line: 1,
      end_line: 2,
      title: "T",
      description: "D",
      status: "open" as const,
    };
    const r = M.toReview({
      summary: "ok",
      deterministic_findings: [
        {
          ...base,
          id: "f1",
          source: "security_scanner",
          severity: "high",
          evidence: { rule_id: "x" },
          confidence: null,
          suggested_action: null,
        },
      ],
      ai_findings: [
        {
          ...base,
          id: "f2",
          source: "ai_review",
          severity: "medium",
          evidence: ["line 3"],
          confidence: "medium",
          suggested_action: "Add a test",
        },
      ],
    });
    expect(r.findings.map((f) => [f.id, f.confidence])).toEqual([
      ["f1", null],
      ["f2", "medium"],
    ]);
    expect(r.findings[0]!.evidence.rule_id).toBe("x");
    expect(r.findings[1]!.evidence).toEqual({ items: ["line 3"], suggested_action: "Add a test" });
  });

  it("maps answers, including insufficient evidence with no provider", () => {
    const a = M.toQuestionAnswer("Q?", {
      answer: "No evidence.",
      insufficient_evidence: true,
      citations: [],
      limitations: ["nothing matched"],
      provider: null,
      model: null,
      mode: "local",
      data_disclosure: null,
      retrieval: { result_count: 0 },
      usage: { duration_ms: 120 },
    });
    expect(a).toMatchObject({
      question: "Q?",
      insufficient_evidence: true,
      provider: null,
      retrieval: { chunks_considered: 0, chunks_used: 0, latency_ms: 120 },
    });
  });

  it("derives local share and provider modes from usage", () => {
    const agg = {
      requests: 2,
      input_tokens: 10,
      output_tokens: 5,
      estimated_cost_microunits: null,
      avg_duration_ms: 100,
    };
    const u = M.toUsage({
      workspace_id: "w",
      period: { from: "2026-10-01T00:00:00Z", to: null },
      totals: { ...agg, requests: 4 },
      local_vs_hosted: { local: 2, mock: 1, hosted: 1 },
      by_provider: [
        { ...agg, provider: "ollama", model: "qwen" },
        { ...agg, provider: "anthropic", model: "big" },
      ],
      by_operation: [{ ...agg, operation: "repository_qa" }],
    });
    expect(u.totals.local_share).toBe(0.75);
    expect(u.by_provider.map((p) => p.mode)).toEqual(["local", "cloud"]);
    expect(u.daily).toBeNull();
  });

  it("maps plan state from approval and source", () => {
    const base = {
      run_id: "r",
      version: 2,
      plan_hash: "h",
      created_by: null,
      created_at: "c",
      editable: true,
      plan: {
        objective: "o",
        assumptions: [],
        steps: [],
        files_to_modify: [],
        tests: [],
        risks: [],
        out_of_scope: [],
      },
      investigation: null,
    };
    expect(M.toRunPlan({ ...base, source: "user_edit", approval: null }).state).toBe("edited");
    expect(
      M.toRunPlan({
        ...base,
        source: "agent",
        approval: {
          decision: "rejected",
          user_id: "u",
          comment: "no",
          subject_hash: "h",
          created_at: "c",
        },
      }),
    ).toMatchObject({ state: "rejected", approval: { comment: "no" } });
  });

  it("flattens validation issues into field errors", () => {
    expect(
      M.fieldErrorsFromDetails({
        issues: [
          { path: ["plan", "objective"], message: "Too short" },
          { path: "slug", message: "Taken" },
        ],
      }),
    ).toMatchObject({ objective: "Too short", "plan.objective": "Too short", slug: "Taken" });
  });

  it("orders tree directories first and marks excluded files", () => {
    const t = M.toTree({
      snapshot_id: "s",
      commit_sha: "c",
      path: "",
      truncated: false,
      entries: [
        {
          type: "file",
          name: "README.md",
          path: "README.md",
          language: "markdown",
          excluded: false,
          exclusion_reason: null,
          byte_size: 10,
          line_count: 2,
        },
        {
          type: "file",
          name: ".env",
          path: ".env",
          language: null,
          excluded: true,
          exclusion_reason: "secret",
          byte_size: null,
          line_count: null,
        },
        { type: "directory", name: "src", path: "src", file_count: 4 },
      ],
    });
    expect(t.entries.map((e) => e.name)).toEqual(["src", ".env", "README.md"]);
    expect(t.entries.find((e) => e.name === ".env")).toMatchObject({
      is_excluded: true,
      exclusion_reason: "secret",
    });
  });
});
