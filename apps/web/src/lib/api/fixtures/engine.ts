/**
 * DEVELOPMENT FIXTURE — deterministic behaviour behind the fixture adapter:
 * search, patch generation, and the workflow-run state machine (ARCHITECTURE §6).
 */
import type * as T from "../types";
import { filesForRepository, type FixtureFile } from "./repo-content";
import { DEFAULT_BUDGETS, LOCAL_MODEL, type FixtureRun, type FixtureState } from "./state";

// ── ids / hashing ────────────────────────────────────────────────────────

export function nextId(state: FixtureState, prefix = ""): string {
  state.seq += 1;
  const hex = state.seq.toString(16).padStart(12, "0");
  return `${prefix || "f0000000"}-0000-4000-8000-${hex}`.slice(0, 36);
}

export function shortHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")
  ).slice(0, 16);
}

export const contentHash = (s: string) => `sha256:${shortHash(s)}${shortHash(s + "#")}`;

// ── search ───────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  "the and for are with that this where what when how does from into which handled handle there their about have has why who is of to in on a an it be by or do we can".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .flatMap((t) => t.split("_"))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

const stem = (t: string) => t.slice(0, 5);

interface Chunk {
  file: FixtureFile;
  start: number;
  end: number;
  text: string;
}

function chunks(files: FixtureFile[]): Chunk[] {
  const out: Chunk[] = [];
  for (const file of files) {
    if (file.excluded || !file.content) continue;
    const lines = file.content.split("\n");
    const window = 14;
    for (let start = 0; start < lines.length; start += 7) {
      const end = Math.min(lines.length, start + window);
      const text = lines.slice(start, end).join("\n");
      if (text.trim()) out.push({ file, start: start + 1, end, text });
      if (end === lines.length) break;
    }
  }
  return out;
}

export function searchFiles(
  files: FixtureFile[],
  query: string,
  commitSha: string,
  topK: number,
  filters?: T.SearchFilters,
): T.SearchResult[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const scored = chunks(files)
    .filter(
      (c) =>
        !filters?.languages?.length ||
        (c.file.language && filters.languages.includes(c.file.language)),
    )
    .filter((c) => !filters?.paths?.length || filters.paths.some((p) => c.file.path.startsWith(p)))
    .map((c) => {
      const tokens = tokenize(c.text + " " + c.file.path);
      const stems = new Set(tokens.map(stem));
      let occurrences = 0;
      for (const t of tokens) if (terms.includes(t)) occurrences++;
      const matched = terms.filter((t) => stems.has(stem(t))).length;
      const lexical = Math.min(1, occurrences / (terms.length * 2.5));
      const semantic = matched / terms.length;
      return { c, lexical, semantic, score: 0.45 * lexical + 0.55 * semantic };
    })
    .filter((s) => s.semantic > 0)
    .sort((a, b) => b.score - a.score);

  const results: T.SearchResult[] = [];
  for (const s of scored) {
    const overlaps = results.some(
      (r) => r.file_path === s.c.file.path && !(s.c.end < r.start_line || s.c.start > r.end_line),
    );
    if (overlaps) continue;
    results.push({
      file_path: s.c.file.path,
      start_line: s.c.start,
      end_line: s.c.end,
      commit_sha: commitSha,
      content_hash: contentHash(s.c.file.content),
      snippet: s.c.text,
      lexical_score: round2(s.lexical),
      semantic_score: round2(0.35 + s.semantic * 0.6),
      language: s.c.file.language,
      symbol_name: symbolIn(s.c.text),
    });
    if (results.length >= topK) break;
  }
  return results;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function symbolIn(text: string): string | null {
  const m = text.match(/(?:function|class|interface|def|const)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return m?.[1] ?? null;
}

// ── line diff → unified diff ────────────────────────────────────────────

type Op = { kind: " " | "+" | "-"; text: string; a: number; b: number };

function lineOps(oldText: string, newText: string): Op[] {
  const split = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));
  const a = split(oldText);
  const b = split(newText);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i]!, a: i + 1, b: j + 1 });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ kind: "+", text: b[j]!, a: i, b: j + 1 });
      j++;
    } else {
      ops.push({ kind: "-", text: a[i]!, a: i + 1, b: j });
      i++;
    }
  }
  return ops;
}

export function unifiedDiff(
  path: string,
  oldText: string | null,
  newText: string | null,
  context = 3,
) {
  const header =
    oldText === null
      ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`
      : newText === null
        ? `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n`
        : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  const ops = lineOps(oldText ?? "", newText ?? "");
  const changed = ops.map((op, idx) => (op.kind !== " " ? idx : -1)).filter((i) => i >= 0);
  if (changed.length === 0) return { text: "", additions: 0, deletions: 0 };

  const hunks: [number, number][] = [];
  for (const idx of changed) {
    const lo = Math.max(0, idx - context);
    const hi = Math.min(ops.length - 1, idx + context);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else hunks.push([lo, hi]);
  }

  let body = "";
  let additions = 0;
  let deletions = 0;
  for (const [lo, hi] of hunks) {
    const slice = ops.slice(lo, hi + 1);
    const aLines = slice.filter((o) => o.kind !== "+").length;
    const bLines = slice.filter((o) => o.kind !== "-").length;
    const firstA = slice.find((o) => o.kind !== "+")?.a ?? slice[0]!.a;
    const firstB = slice.find((o) => o.kind !== "-")?.b ?? slice[0]!.b;
    body += `@@ -${aLines ? firstA : 0},${aLines} +${bLines ? firstB : 0},${bLines} @@\n`;
    for (const op of slice) {
      body += `${op.kind}${op.text}\n`;
      if (op.kind === "+") additions++;
      if (op.kind === "-") deletions++;
    }
  }
  return { text: header + body, additions, deletions };
}

// ── scenarios: investigation, plan, patch, review ───────────────────────

interface Edit {
  anchor: string;
  remove: number;
  insert: string[];
}

interface Scenario {
  match: RegExp;
  investigation: (sha: string) => T.Investigation;
  plan: T.EngineeringPlan;
  edits: Record<string, Edit[]>;
  newFiles: Record<string, string>;
  findings: Omit<T.ReviewFinding, "id" | "created_at" | "status">[];
}

const REFRESH: Scenario = {
  match: /refresh|session|token/i,
  investigation: (sha) => ({
    summary:
      "The refresh flow can fail when two refresh requests overlap: each caller sends the same single-use refresh token.",
    findings: [
      {
        claim:
          "Refresh requests are not serialized; every caller of refreshSession issues its own POST /oauth/token.",
        evidence: [{ path: "src/auth/refresh.ts", start_line: 16, end_line: 31, commit_sha: sha }],
        kind: "observed",
      },
      {
        claim:
          "Refresh tokens are rotated and single-use, so the second concurrent request is rejected with 400.",
        evidence: [
          { path: "docs/architecture.md", start_line: 5, end_line: 5, commit_sha: sha },
          { path: "README.md", start_line: 12, end_line: 13, commit_sha: sha },
        ],
        kind: "observed",
      },
      {
        claim:
          "A 400 from the provider clears the token store, signing out a user whose session was valid.",
        evidence: [{ path: "src/auth/refresh.ts", start_line: 32, end_line: 36, commit_sha: sha }],
        kind: "inferred",
      },
    ],
    hypotheses: [
      "Concurrent requests may invalidate a rotated token and clear an otherwise valid session.",
    ],
    unknowns: ["Production token-rotation grace period is not configured in this repository."],
    candidate_files: ["src/auth/refresh.ts", "test/auth/refresh.test.ts"],
  }),
  plan: {
    objective: "Prevent concurrent refresh attempts from invalidating a valid session.",
    assumptions: ["Token rotation is enabled in the current identity-provider configuration."],
    steps: [
      {
        id: "step-1",
        description:
          "Serialize refreshSession so concurrent callers share a single in-flight refresh promise.",
        files: ["src/auth/refresh.ts"],
        verification: ["Existing auth unit tests pass"],
      },
      {
        id: "step-2",
        description:
          "Add a regression test that fires two concurrent refreshes and asserts one provider call.",
        files: ["test/auth/refresh.concurrency.test.ts"],
        verification: ["New concurrency regression test passes"],
      },
    ],
    files_to_modify: ["src/auth/refresh.ts", "test/auth/refresh.concurrency.test.ts"],
    tests: ["refresh concurrency test", "existing auth tests"],
    risks: [
      "Behavior may differ across token providers",
      "A rejected in-flight refresh now fails all waiting callers",
    ],
    out_of_scope: ["Changing session storage architecture"],
  },
  edits: {
    "src/auth/refresh.ts": [
      {
        anchor: "export async function refreshSession(store: TokenStore): Promise<RefreshResult> {",
        remove: 1,
        insert: [
          "let inFlight: Promise<RefreshResult> | null = null;",
          "",
          "export async function refreshSession(store: TokenStore): Promise<RefreshResult> {",
          "  // Rotating refresh tokens are single-use: share one in-flight refresh.",
          "  inFlight ??= performRefresh(store).finally(() => {",
          "    inFlight = null;",
          "  });",
          "  return inFlight;",
          "}",
          "",
          "async function performRefresh(store: TokenStore): Promise<RefreshResult> {",
        ],
      },
      {
        anchor: "  // NOTE: concurrent callers each issue their own refresh request.",
        remove: 1,
        insert: [],
      },
    ],
  },
  newFiles: {
    "test/auth/refresh.concurrency.test.ts": `import { describe, expect, it, vi } from "vitest";
import { refreshSession } from "../../src/auth/refresh";
import { MemoryTokenStore } from "../../src/auth/token-store";
import { http } from "../../src/lib/http";

vi.mock("../../src/lib/http");

describe("refreshSession concurrency", () => {
  it("issues a single provider request for concurrent callers", async () => {
    const store = new MemoryTokenStore();
    await store.write({ accessToken: expired(), refreshToken: "r1", expiresAt: 0 });
    vi.mocked(http.post).mockResolvedValue({ status: 200, data: { accessToken: valid(), refreshToken: "r2", expiresAt: 0 } });

    await Promise.all([refreshSession(store), refreshSession(store)]);

    expect(http.post).toHaveBeenCalledTimes(1);
  });
});

const jwt = (exp: number) => ["h", Buffer.from(JSON.stringify({ sub: "u", exp, iat: 0 })).toString("base64url"), "s"].join(".");
const valid = () => jwt(Math.floor(Date.now() / 1000) + 3600);
const expired = () => jwt(Math.floor(Date.now() / 1000) - 10);
`,
  },
  findings: [
    {
      source: "ai_review",
      severity: "medium",
      file_path: "src/auth/refresh.ts",
      start_line: 16,
      end_line: 23,
      title: "Module-level in-flight promise is shared across token stores",
      description:
        "inFlight is a module singleton. Two different TokenStore instances (e.g. two tenants in one process) would share one refresh.",
      evidence: {
        items: [
          "src/auth/refresh.ts:16 declares `let inFlight` at module scope",
          "refreshSession accepts any TokenStore",
        ],
        rationale:
          "The plan assumed one session per process; the function signature does not enforce that.",
        suggested_action: "Key the in-flight map by store instance (WeakMap<TokenStore, Promise>).",
      },
      confidence: "medium",
    },
    {
      source: "static_analysis",
      severity: "low",
      file_path: "src/auth/refresh.ts",
      start_line: 41,
      end_line: 41,
      title: "Unused import: logger is only used on the error path",
      description:
        "eslint(no-restricted-syntax): prefer structured error codes over free-text warnings.",
      evidence: { rule_id: "anvaya/structured-logging" },
      confidence: null,
    },
  ],
};

const CHARGE: Scenario = {
  match: /charge|idempot|double/i,
  investigation: (sha) => ({
    summary:
      "createCharge retries on network failure without an idempotency key, so a retry after a timeout can double-charge.",
    findings: [
      {
        claim: "createCharge recursively retries up to two times on any error.",
        evidence: [
          { path: "src/payments/charge.ts", start_line: 21, end_line: 36, commit_sha: sha },
        ],
        kind: "observed",
      },
      {
        claim: "ADR-006 requires idempotent charges at the processor boundary.",
        evidence: [{ path: "docs/architecture.md", start_line: 14, end_line: 14, commit_sha: sha }],
        kind: "observed",
      },
    ],
    hypotheses: [
      "A processor timeout after a successful charge leads to a duplicate charge on retry.",
    ],
    unknowns: ["Whether the processor scopes idempotency keys per API key or per account."],
    candidate_files: ["src/payments/charge.ts"],
  }),
  plan: {
    objective: "Send a stable idempotency key with every charge attempt.",
    assumptions: ["The caller can derive a stable key from the order id."],
    steps: [
      {
        id: "step-1",
        description: "Add idempotencyKey to ChargeRequest and send it on every attempt.",
        files: ["src/payments/charge.ts"],
        verification: ["Type check passes", "Unit tests pass"],
      },
      {
        id: "step-2",
        description: "Add a test that asserts retries reuse the same key.",
        files: ["test/payments/charge.test.ts"],
        verification: ["New retry test passes"],
      },
    ],
    files_to_modify: ["src/payments/charge.ts", "test/payments/charge.test.ts"],
    tests: ["charge retry idempotency test"],
    risks: ["Callers must be updated to provide a key"],
    out_of_scope: ["Changing retry backoff policy"],
  },
  edits: {
    "src/payments/charge.ts": [
      {
        anchor: "  description?: string;",
        remove: 1,
        insert: [
          "  description?: string;",
          "  /** Stable per order (ADR-006). Reused across retries. */",
          "  idempotencyKey: string;",
        ],
      },
      {
        anchor: " * but this client does not send one yet.",
        remove: 1,
        insert: [" * Every attempt reuses the caller's idempotency key (ADR-006)."],
      },
      {
        anchor: "      description: request.description,",
        remove: 1,
        insert: [
          "      description: request.description,",
          "      idempotency_key: request.idempotencyKey,",
        ],
      },
    ],
  },
  newFiles: {
    "test/payments/charge.test.ts": `import { expect, it, vi } from "vitest";
import { createCharge } from "../../src/payments/charge";
import { http } from "../../src/lib/http";

vi.mock("../../src/lib/http");

it("reuses the idempotency key across retries", async () => {
  vi.mocked(http.post).mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ status: 200, data: { id: "ch_1", status: "succeeded", amount: { currency: "USD", minor: 100 } } });
  await createCharge({ customerId: "c1", amount: { currency: "USD", minor: 100 }, idempotencyKey: "order-1" });
  const keys = vi.mocked(http.post).mock.calls.map(([, body]) => (body as { idempotency_key: string }).idempotency_key);
  expect(new Set(keys)).toEqual(new Set(["order-1"]));
});
`,
  },
  findings: [
    {
      source: "security_scanner",
      severity: "high",
      file_path: "src/payments/charge.ts",
      start_line: 31,
      end_line: 31,
      title: "Idempotency key forwarded without format validation",
      description:
        "semgrep: user-controlled value forwarded to a third-party API without validation.",
      evidence: { rule_id: "typescript.express.untrusted-forward" },
      confidence: null,
    },
    {
      source: "ai_review",
      severity: "low",
      file_path: "src/payments/charge.ts",
      start_line: 8,
      end_line: 9,
      title: "Breaking change for existing callers",
      description:
        "idempotencyKey is required; callers outside this repository will fail to compile.",
      evidence: {
        items: ["ChargeRequest.idempotencyKey is non-optional in the diff"],
        suggested_action: "Mention the breaking change in the PR description.",
      },
      confidence: "high",
    },
  ],
};

function genericScenario(task: T.EngineeringTask, files: FixtureFile[], sha: string): Scenario {
  const hits = searchFiles(files, `${task.title} ${task.description}`, sha, 4);
  const sources = [...new Set(hits.map((h) => h.file_path))].filter(
    (p) => !p.startsWith("test/") && !p.endsWith(".md"),
  );
  const target =
    sources[0] ??
    files.find((f) => !f.excluded && f.path.startsWith("src/"))?.path ??
    files[0]!.path;
  const targetFile = files.find((f) => f.path === target);
  const firstExport = targetFile?.content
    .split("\n")
    .find((l) => /^export (async )?function|^def /.test(l));
  const testPath = target
    .replace(/^src\//, "test/")
    .replace(/\.(ts|py)$/, (ext) => `.anvaya.test${ext}`);
  return {
    match: /.*/,
    investigation: () => ({
      summary: `Retrieved ${hits.length} evidence chunks related to "${task.title}".`,
      findings: hits.slice(0, 2).map((h) => ({
        claim: `Relevant logic for this task lives in ${h.file_path}${h.symbol_name ? ` (${h.symbol_name})` : ""}.`,
        evidence: [
          { path: h.file_path, start_line: h.start_line, end_line: h.end_line, commit_sha: sha },
        ],
        kind: "observed" as const,
      })),
      hypotheses: ["The requested behaviour can be implemented within the identified module."],
      unknowns: hits.length
        ? []
        : ["No indexed code matched the task description; the plan is low-confidence."],
      candidate_files: [target],
    }),
    plan: {
      objective: task.title,
      assumptions: ["The task description reflects the intended behaviour."],
      steps: [
        {
          id: "step-1",
          description: `Implement the change in ${target}.`,
          files: [target],
          verification: ["Existing tests pass"],
        },
        {
          id: "step-2",
          description: "Add a focused regression test.",
          files: [testPath],
          verification: ["New test passes"],
        },
      ],
      files_to_modify: [target, testPath],
      tests: ["new regression test", "existing unit tests"],
      risks: ["Fixture plan generated without a model; review carefully."],
      out_of_scope: ["Unrelated refactoring"],
    },
    edits: firstExport
      ? {
          [target]: [{ anchor: firstExport, remove: 1, insert: [`// ${task.title}`, firstExport] }],
        }
      : {},
    newFiles: { [testPath]: `// Regression test for: ${task.title}\n` },
    findings: [
      {
        source: "ai_review",
        severity: "info",
        file_path: target,
        start_line: 1,
        end_line: 1,
        title: "Change is minimal; confirm it addresses the task",
        description:
          "The patch only annotates the target function. Verify that behaviour actually changes.",
        evidence: {
          items: ["Diff contains a single comment line"],
          suggested_action: "Request a plan revision if needed.",
        },
        confidence: "low",
      },
    ],
  };
}

function scenarioFor(task: T.EngineeringTask, files: FixtureFile[], sha: string): Scenario {
  if (CHARGE.match.test(task.title)) return CHARGE;
  if (REFRESH.match.test(task.title) && files.some((f) => f.path === "src/auth/refresh.ts"))
    return REFRESH;
  return genericScenario(task, files, sha);
}

function applyEdits(content: string, edits: Edit[]): string {
  const lines = content.split("\n");
  for (const edit of edits) {
    const idx = lines.indexOf(edit.anchor);
    if (idx >= 0) lines.splice(idx, edit.remove, ...edit.insert);
  }
  return lines.join("\n");
}

// ── run state machine ───────────────────────────────────────────────────

export const PHASE_ONE: T.RunStatus[] = [
  "queued",
  "retrieving_context",
  "investigating",
  "planning",
  "awaiting_plan_approval",
];
export const PHASE_TWO: T.RunStatus[] = [
  "preparing_workspace",
  "implementing",
  "verifying",
  "reviewing",
  "awaiting_pr_approval",
];

export function stageDurationMs(): number {
  const configured = Number(process.env.NEXT_PUBLIC_FIXTURE_STAGE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 1400;
}

export function schedule(run: FixtureRun, statuses: T.RunStatus[], from: number) {
  const step = stageDurationMs();
  run.schedule = statuses.map((status, i) => ({ status, at: from + step * (i + 1) }));
}

function emit(
  run: FixtureRun,
  type: T.RunEventType,
  at: number,
  extra: Partial<T.RunEventPayload> = {},
) {
  const id = `evt_${run.run_number}_${run.events.length + 1}_${run.id.slice(-6)}`;
  run.events.push({
    id,
    type,
    payload: { run_id: run.id, timestamp: new Date(at).toISOString(), ...extra },
  });
}

function addStep(
  run: FixtureRun,
  state: FixtureState,
  agentType: string,
  at: number,
  tools: string[] = [],
  failed = false,
) {
  const startedAt = new Date(at - stageDurationMs() * 0.8).toISOString();
  const llm = !["context_retriever", "verification_engine"].includes(agentType);
  run.steps.push({
    id: nextId(state, "50000000"),
    sequence_number: run.steps.length + 1,
    agent_type: agentType,
    status: failed ? "failed" : "succeeded",
    prompt_version: llm ? `${agentType}@2026-10-14` : null,
    provider: llm ? run.provider : null,
    model: llm ? run.model : null,
    input_tokens: llm ? 1800 + run.steps.length * 420 : null,
    output_tokens: llm ? 360 + run.steps.length * 55 : null,
    duration_ms: Math.round(stageDurationMs() * 0.8) + 120,
    started_at: startedAt,
    ended_at: new Date(at).toISOString(),
    error_code: failed ? "CHECKS_FAILED" : null,
    tools: tools.map((tool_name, i) => ({
      id: nextId(state, "51000000"),
      tool_name,
      status: "succeeded",
      input_redacted: toolInput(tool_name),
      output_redacted: { ok: true },
      duration_ms: 80 + i * 35,
      created_at: startedAt,
    })),
  });
}

function toolInput(tool: string): unknown {
  switch (tool) {
    case "search_repository":
      return { query: "[task intent]", filters: { snapshot: "latest" } };
    case "read_file":
      return { path: "src/…", start_line: 1, end_line: 60 };
    case "run_profile":
      return { profile_id: "node.test" };
    default:
      return {};
  }
}

function recordUsage(state: FixtureState, run: FixtureRun, operation: string, at: number) {
  state.usage.push({
    workspace_id: run.workspace_id,
    provider: run.provider ?? "mock",
    model: run.model ?? "mock",
    mode: run.mode,
    operation,
    input_tokens: 2100,
    output_tokens: 420,
    cost: run.mode === "cloud" ? 9_400 : 0,
    at: new Date(at).toISOString(),
    run_id: run.id,
  });
  run.usage_summary = {
    ...run.usage_summary,
    input_tokens: (run.usage_summary.input_tokens ?? 0) + 2100,
    output_tokens: (run.usage_summary.output_tokens ?? 0) + 420,
    steps: run.steps.length,
    estimated_cost_microunits:
      (run.usage_summary.estimated_cost_microunits ?? 0) + (run.mode === "cloud" ? 9_400 : 0),
  };
}

function enter(state: FixtureState, run: FixtureRun, status: T.RunStatus, at: number) {
  const task = state.tasks.find((t) => t.id === run.task_id)!;
  const repo = state.repositories.find((r) => r.id === task.repository_id)!;
  const sha = repo.latest_indexed_commit_sha ?? "0000000";
  const files = filesForRepository(repo.full_name);
  const scenario = scenarioFor(task, files, sha);
  const iso = new Date(at).toISOString();

  run.status = status;
  run.updated_at = iso;
  run.state_version += 1;
  run.current_stage = status;
  emit(run, "run.status.changed", at, { status });
  emit(run, "run.stage.changed", at, { stage: status });

  switch (status) {
    case "retrieving_context":
      run.started_at ??= iso;
      addStep(run, state, "context_retriever", at, ["search_repository", "get_related_tests"]);
      emit(run, "retrieval.completed", at, { count: 9, commit_sha: sha, semantic: "ok" });
      break;
    case "investigating":
      emit(run, "agent.started", at, { agent: "investigator" });
      addStep(run, state, "investigator", at, [
        "search_repository",
        "read_file",
        "get_architecture_context",
      ]);
      recordUsage(state, run, "investigation", at);
      emit(run, "agent.completed", at, { agent: "investigator" });
      break;
    case "planning": {
      emit(run, "agent.started", at, { agent: "planner" });
      addStep(run, state, "planner", at);
      recordUsage(state, run, "planning", at);
      const plan = structuredClone(scenario.plan);
      run.plan = {
        run_id: run.id,
        plan,
        investigation: scenario.investigation(sha),
        plan_hash: contentHash(JSON.stringify(plan)),
        version: 1,
        state: "proposed",
        source: "agent",
        editable: true,
        updated_at: iso,
        approval: null,
      };
      emit(run, "agent.completed", at, { agent: "planner" });
      break;
    }
    case "awaiting_plan_approval":
      emit(run, "approval.required", at, {
        approval_type: "plan",
        plan_hash: run.plan?.plan_hash,
        plan_version: run.plan?.version,
      });
      break;
    case "preparing_workspace":
      emit(run, "sandbox.started", at, {
        message: "Disposable workspace created from base commit.",
      });
      break;
    case "implementing": {
      emit(run, "agent.started", at, { agent: "developer" });
      emit(run, "tool.started", at, { tool: "propose_patch" });
      addStep(run, state, "developer", at, ["read_file", "propose_patch", "inspect_diff"]);
      recordUsage(state, run, "implementation", at);
      run.diff = buildDiff(files, scenario, sha);
      emit(run, "tool.completed", at, { tool: "propose_patch" });
      emit(run, "patch.proposed", at, {
        patch_id: run.diff.patch_id,
        patch_hash: run.diff.patch_hash,
        attempt: run.diff.attempt,
        changed_files: run.diff.changed_files.length,
        additions: run.diff.additions,
        deletions: run.diff.deletions,
      });
      emit(run, "agent.completed", at, { agent: "developer" });
      break;
    }
    case "verifying": {
      emit(run, "tool.started", at, { tool: "run_profile" });
      const failed = run.outcome === "verification_failed";
      addStep(
        run,
        state,
        "verification_engine",
        at,
        ["run_profile", "run_profile", "run_profile"],
        failed,
      );
      run.verification = buildVerification(state, failed, at);
      emit(run, "verification.completed", at, {
        profile: "node-test",
        status: failed ? "failed" : "passed",
        exit_code: failed ? 1 : 0,
        attempt: 1,
      });
      if (failed) {
        run.usage_summary.repair_attempts = 1;
        run.schedule = [];
        finish(
          state,
          run,
          "failed",
          at,
          "VERIFICATION_FAILED",
          "Unit tests failed after 1 repair attempt; repair budget exhausted.",
        );
      }
      break;
    }
    case "reviewing": {
      emit(run, "agent.started", at, { agent: "reviewer" });
      addStep(run, state, "reviewer", at, [
        "inspect_diff",
        "read_file",
        "get_verification_results",
      ]);
      recordUsage(state, run, "review", at);
      run.review = {
        summary: "The change stays within the approved plan. One design concern and one lint note.",
        findings: scenario.findings.map((f) => ({
          ...f,
          id: nextId(state, "60000000"),
          status: "open",
          created_at: iso,
        })),
      };
      for (const f of run.review.findings)
        emit(run, "review.finding.created", at, {
          finding_id: f.id,
          severity: f.severity,
          source: f.source,
        });
      emit(run, "agent.completed", at, { agent: "reviewer" });
      break;
    }
    case "awaiting_pr_approval":
      emit(run, "approval.required", at, { approval_type: "pull_request" });
      break;
    case "creating_pr":
      break;
    default:
      break;
  }
  void task;
}

function buildDiff(files: FixtureFile[], scenario: Scenario, sha: string): T.RunDiff {
  let text = "";
  let additions = 0;
  let deletions = 0;
  const changed: T.ChangedFile[] = [];
  for (const [path, edits] of Object.entries(scenario.edits)) {
    const file = files.find((f) => f.path === path);
    if (!file) continue;
    const d = unifiedDiff(path, file.content, applyEdits(file.content, edits));
    if (!d.text) continue;
    text += d.text;
    additions += d.additions;
    deletions += d.deletions;
    changed.push({ path, status: "modified", additions: d.additions, deletions: d.deletions });
  }
  for (const [path, content] of Object.entries(scenario.newFiles)) {
    const d = unifiedDiff(path, null, content);
    text += d.text;
    additions += d.additions;
    changed.push({ path, status: "added", additions: d.additions, deletions: 0 });
  }
  return {
    patch_id: `patch-${contentHash(text).slice(7, 19)}`,
    patch_hash: contentHash(text),
    attempt: 1,
    base_commit_sha: sha,
    summary: scenario.plan.objective,
    truncated: false,
    changed_files: changed,
    additions,
    deletions,
    unified_diff: text,
  };
}

function buildVerification(state: FixtureState, failed: boolean, at: number): T.VerificationReport {
  const iso = new Date(at).toISOString();
  const mk = (
    profile_id: string,
    command_display: string,
    status: T.VerificationStatus,
    exit_code: number | null,
    duration_ms: number,
    output_excerpt: string | null,
  ): T.VerificationResult => ({
    id: nextId(state, "70000000"),
    profile_id,
    command_display,
    status,
    exit_code,
    duration_ms,
    output_excerpt,
    created_at: iso,
  });
  return {
    results: [
      mk("node.typecheck", "npm run typecheck", "passed", 0, 6120, "tsc --noEmit\n✓ no errors"),
      failed
        ? mk(
            "node.test",
            "npm test",
            "failed",
            1,
            9340,
            " FAIL  test/payments/money.test.ts > roundMinor > keeps integer minor units unchanged\nAssertionError: expected 1990 to be 1999\n  ❯ test/payments/money.test.ts:6:52\n\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 5 passed (6)",
          )
        : mk(
            "node.test",
            "npm test",
            "passed",
            0,
            8410,
            " ✓ test/auth/refresh.test.ts (2)\n ✓ test/auth/refresh.concurrency.test.ts (1)\n ✓ test/payments/money.test.ts (2)\n\n Test Files  3 passed (3)\n      Tests  5 passed (5)",
          ),
      mk("node.lint", "npm run lint", "passed", 0, 3980, "eslint src test\n✓ 0 problems"),
      mk(
        "security.secrets",
        "gitleaks detect --no-git",
        "skipped",
        null,
        0,
        "Skipped: no files outside src/ and test/ changed.",
      ),
    ],
    unavailable: [
      { profile_id: "node.build", reason: "No build profile is configured for this repository." },
    ],
    unavailable_count: 1,
    ai_summary: failed
      ? "The failing assertion is in roundMinor: dividing then multiplying by the factor loses precision for integer minor units. The repair attempt did not change money.ts because it was outside the approved file scope."
      : null,
  };
}

export function finish(
  state: FixtureState,
  run: FixtureRun,
  status: T.TerminalRunStatus,
  at: number,
  errorCode?: string,
  errorSummary?: string,
) {
  const iso = new Date(at).toISOString();
  run.status = status;
  run.current_stage = null;
  run.ended_at = iso;
  run.updated_at = iso;
  run.state_version += 1;
  run.schedule = [];
  run.error_code = errorCode ?? null;
  run.error_summary = errorSummary ?? null;
  emit(run, "run.status.changed", at, { status });
  const type: T.RunEventType =
    status === "failed" || status === "timed_out"
      ? "run.failed"
      : status === "cancelled"
        ? "run.cancelled"
        : "run.completed";
  emit(run, type, at, {
    status,
    error_code: errorCode ?? null,
    error_summary: errorSummary ?? null,
  });
  const task = state.tasks.find((t) => t.id === run.task_id);
  if (task) {
    task.status =
      status === "completed" || status === "completed_without_pr"
        ? "completed"
        : status === "cancelled" || status === "rejected"
          ? "open"
          : "failed";
    task.updated_at = iso;
  }
}

/** Advance every run whose scheduled transitions are due. Called before each request. */
export function tick(state: FixtureState, now = Date.now()) {
  for (const run of state.runs) {
    while (run.schedule.length && run.schedule[0]!.at <= now) {
      const next = run.schedule.shift()!;
      if (next.status === "completed") {
        finish(state, run, "completed", next.at);
        break;
      }
      enter(state, run, next.status, next.at);
    }
  }
}

export function createRun(
  state: FixtureState,
  task: T.EngineeringTask & { workspace_id: string },
  body: T.StartRunRequest,
  at: number,
  outcome: FixtureRun["outcome"] = "success",
): FixtureRun {
  const policy = state.policies[task.workspace_id];
  const mode: T.InferenceMode = body.mode ?? policy?.default_mode ?? "local";
  const workspace = state.workspaces.find((w) => w.id === task.workspace_id);
  const repo = state.repositories.find((r) => r.id === task.repository_id);
  const runNumber = state.runs.filter((r) => r.task_id === task.id).length + 1;
  const iso = new Date(at).toISOString();
  const budget: T.RunBudgets = { ...DEFAULT_BUDGETS };
  const max: T.RunBudgets = {
    ...DEFAULT_BUDGETS,
    ...(workspace?.settings.run_budget_limits ?? {}),
  };
  for (const key of Object.keys(budget) as (keyof T.RunBudgets)[]) {
    budget[key] = Math.min(body.budgets?.[key] ?? max[key], max[key]); // server clamps (API_SPEC §5)
  }
  const run: FixtureRun = {
    id: nextId(state, "80000000"),
    workspace_id: task.workspace_id,
    task_id: task.id,
    run_number: runNumber,
    status: "queued",
    current_stage: "queued",
    mode: mode,
    provider:
      mode === "mock" ? "mock" : mode === "cloud" ? (policy?.cloud.provider ?? "hosted") : "ollama",
    model:
      mode === "mock"
        ? "mock-deterministic"
        : mode === "cloud"
          ? (policy?.cloud.model ?? "hosted-model")
          : LOCAL_MODEL,
    state_version: 1,
    budget,
    usage_summary: {},
    started_at: null,
    ended_at: null,
    error_code: null,
    error_summary: null,
    created_at: iso,
    updated_at: iso,
    base_branch: body.base_branch,
    pull_request: null,
    task: {
      id: task.id,
      title: task.title,
      repository_id: task.repository_id,
      repository_full_name: repo?.full_name ?? null,
    },
    outcome,
    schedule: [],
    events: [],
    steps: [],
    plan: null,
    diff: null,
    verification: null,
    review: null,
    approvals: [],
    pr_approved: false,
    artifacts: [],
  };
  emit(run, "run.created", at, { status: "queued" });
  schedule(run, PHASE_ONE.slice(1), at);
  state.runs.push(run);
  task.status = "active";
  task.updated_at = iso;
  return run;
}
