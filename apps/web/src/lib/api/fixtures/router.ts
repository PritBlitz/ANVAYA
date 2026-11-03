/**
 * DEVELOPMENT FIXTURE — route handlers emulating the Anvaya control plane.
 *
 * Requests and responses follow the backend's wire contract exactly (see ../wire.ts and
 * the backend's docs/backend/API_CONTRACT_NOTES.md): strict request bodies, envelopes,
 * `meta.page` pagination, `details.issues` validation errors, server-held GitHub
 * install state, hash-bound approvals, and lazy tree listing. Internal state is kept in
 * UI-model form and encoded at this boundary, so the real mappers run in fixtures mode.
 */
import type * as T from "../types";
import { ACTIVE_RUN_STATUSES, CREATABLE_TASK_SOURCES, TERMINAL_RUN_STATUSES } from "../types";
import type * as W from "../wire";
import {
  contentHash,
  createRun,
  finish,
  nextId,
  PHASE_TWO,
  schedule,
  searchFiles,
  stageDurationMs,
  tick,
} from "./engine";
import { dependencyMap, parseSymbols, symbolDetail, toWire } from "./code-intel";
import { filesForRepository } from "./repo-content";
import {
  DEFAULT_BUDGETS,
  defaultPolicy,
  EMBEDDING_MODEL,
  LOCAL_MODEL,
  type FixtureRun,
  type FixtureState,
  type FixtureWorkspace,
  type Scoped,
} from "./state";

export class FixtureHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface FixtureRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  state: FixtureState;
  now: number;
}

export interface FixtureResult {
  status: number;
  data?: unknown;
  meta?: Record<string, unknown>;
}

type Handler = (req: FixtureRequest) => FixtureResult;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
        keys.push(key);
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern, keys, handler });
}

export function matchRoute(
  method: string,
  path: string,
): { handler: Handler; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    return { handler: r.handler, params };
  }
  return null;
}

// ── helpers ──────────────────────────────────────────────────────────────

const ok = (data: unknown, status = 200, meta?: Record<string, unknown>): FixtureResult => ({
  status,
  data,
  meta,
});
const noContent = (): FixtureResult => ({ status: 204 });
const iso = (ms: number) => new Date(ms).toISOString();

function currentUser(req: FixtureRequest): T.User {
  const user = req.state.users.find((u) => u.id === req.state.session_user_id);
  if (!user) throw new FixtureHttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return user;
}

function membership(req: FixtureRequest, workspaceId: string) {
  const user = currentUser(req);
  const m = req.state.memberships.find(
    (x) => x.workspace_id === workspaceId && x.user_id === user.id,
  );
  // 404 rather than 403 conceals other tenants' workspaces.
  if (!m) throw new FixtureHttpError(404, "NOT_FOUND", "Workspace not found.");
  return m;
}

const RANK: Record<T.WorkspaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

function requireRole(req: FixtureRequest, workspaceId: string, min: T.WorkspaceRole) {
  const m = membership(req, workspaceId);
  if (RANK[m.role] < RANK[min]) {
    throw new FixtureHttpError(
      403,
      "FORBIDDEN",
      `This action requires the ${min} role or higher.`,
      { required_role: min },
    );
  }
  return m;
}

/** Workspace scope: X-Workspace-Id header, `workspace_id` query, or body field (must agree). */
function scope(req: FixtureRequest, min: T.WorkspaceRole = "viewer") {
  const candidates = [
    req.headers["X-Workspace-Id"],
    req.query.get("workspace_id"),
    typeof req.body.workspace_id === "string" ? req.body.workspace_id : null,
  ].filter((v): v is string => !!v);
  if (candidates.length === 0) throw validation("workspace_id", "is required");
  if (new Set(candidates).size > 1)
    throw new FixtureHttpError(
      400,
      "WORKSPACE_MISMATCH",
      "The workspace header and parameter disagree.",
    );
  requireRole(req, candidates[0]!, min);
  return candidates[0]!;
}

function findScoped<X extends { id: string; workspace_id: string }>(
  req: FixtureRequest,
  items: X[],
  id: string,
  min: T.WorkspaceRole = "viewer",
): X {
  const item = items.find((i) => i.id === id);
  if (!item) throw new FixtureHttpError(404, "NOT_FOUND", "Not found.");
  try {
    requireRole(req, item.workspace_id, min);
  } catch (e) {
    if (e instanceof FixtureHttpError && e.status === 404)
      throw new FixtureHttpError(404, "NOT_FOUND", "Not found.");
    throw e;
  }
  return item;
}

/** Strict bodies: unknown fields are rejected, like the backend's Zod `.strict()`. */
function strictBody(req: FixtureRequest, allowed: string[]) {
  const extra = Object.keys(req.body).filter((k) => !allowed.includes(k));
  if (extra.length) {
    throw new FixtureHttpError(422, "VALIDATION_FAILED", "Request validation failed.", {
      issues: extra.map((k) => ({
        path: [k],
        message: `Unrecognized key: "${k}"`,
        code: "unrecognized_keys",
      })),
    });
  }
}

function str(
  body: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; optional?: boolean } = {},
): string {
  const v = body[key];
  if ((v === undefined || v === null) && opts.optional) return "";
  if (typeof v !== "string") throw validation(key, "is required");
  const t = v.trim();
  if (opts.min && t.length < opts.min)
    throw validation(key, `must be at least ${opts.min} characters`);
  if (opts.max && t.length > opts.max)
    throw validation(key, `must be at most ${opts.max} characters`);
  return t;
}

const validation = (field: string, msg: string) =>
  new FixtureHttpError(422, "VALIDATION_FAILED", `${field} ${msg}.`, {
    issues: [
      {
        path: field.split("."),
        message: `${field.split(".").pop()!.replace(/_/g, " ")} ${msg}`,
        code: "custom",
      },
    ],
  });

function audit(
  req: FixtureRequest,
  workspaceId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
) {
  const user = req.state.users.find((u) => u.id === req.state.session_user_id);
  req.state.audit.unshift({
    id: nextId(req.state, "90000000"),
    workspace_id: workspaceId,
    actor_user_id: user?.id ?? null,
    actor_display: user?.email ?? null,
    actor_type: user ? "user" : "system",
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    request_id: req.headers["X-Request-Id"] ?? null,
    metadata_redacted: metadata,
    created_at: iso(req.now),
  });
}

/** Offset cursor encoded opaquely; meta.page like the backend. */
function paginate<X>(items: X[], query: URLSearchParams): FixtureResult {
  const limit = Math.min(Number(query.get("limit") ?? 25) || 25, 100);
  const raw = query.get("cursor");
  let offset = 0;
  if (raw) {
    offset = Number(atob(raw));
    if (!Number.isInteger(offset) || offset < 0) throw validation("cursor", "is malformed");
  }
  const page = items.slice(offset, offset + limit);
  const more = offset + limit < items.length;
  return ok(page, 200, {
    page: { next_cursor: more ? btoa(String(offset + limit)) : null, has_more: more },
  });
}

function requireStatus(run: FixtureRun, allowed: T.RunStatus[], action: string) {
  if (!allowed.includes(run.status)) {
    throw new FixtureHttpError(
      409,
      "INVALID_STATE_TRANSITION",
      `Cannot ${action} while the run is ${run.status.replace(/_/g, " ")}.`,
      {
        current_status: run.status,
      },
    );
  }
}

function getRun(req: FixtureRequest, min: T.WorkspaceRole = "viewer") {
  return findScoped(req, req.state.runs, req.params.runId!, min);
}

// ── wire encoders (UI-model state → backend wire format) ────────────────

function wWorkspace(req: FixtureRequest, w: FixtureWorkspace): W.WWorkspace {
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    plan_key: w.plan_key,
    role: membership(req, w.id).role,
    settings: w.settings,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

function wRepository(r: Scoped<T.Repository>): W.WRepository {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    installation_id: r.installation_id,
    provider: "github",
    external_repository_id: r.external_repository_id,
    owner: r.owner,
    name: r.name,
    full_name: r.full_name,
    default_branch: r.default_branch,
    visibility: r.visibility,
    status: r.status,
    indexing_status: r.indexing_status,
    latest_indexed_commit_sha: r.latest_indexed_commit_sha,
    indexed_at: r.indexed_at,
    settings: {
      exclude_paths: r.settings.exclude_paths ?? [],
      verification_profiles: r.settings.verification_profiles ?? [],
    },
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function wInstallation(i: Scoped<T.GitInstallation>): W.WInstallation {
  return { ...i, updated_at: i.created_at };
}

function wRunCore(state: FixtureState, run: FixtureRun): W.WRun {
  const task = state.tasks.find((t) => t.id === run.task_id)!;
  const repo = state.repositories.find((r) => r.id === task.repository_id);
  return {
    id: run.id,
    task_id: run.task_id,
    workspace_id: run.workspace_id,
    repository_id: task.repository_id,
    run_number: run.run_number,
    status: run.status,
    current_stage: run.current_stage,
    mode: run.mode,
    provider: run.provider,
    model: run.model,
    base_branch: run.base_branch ?? null,
    snapshot_id: repo?.latest_indexed_commit_sha
      ? `snap-${repo.latest_indexed_commit_sha.slice(0, 8)}`
      : null,
    state_version: run.state_version,
    budget: run.budget,
    usage_summary: {
      input_tokens: run.usage_summary.input_tokens,
      output_tokens: run.usage_summary.output_tokens,
      agent_steps: run.steps.length,
      model_calls: run.steps.filter((s) => s.model).length,
      repair_attempts: run.usage_summary.repair_attempts,
    },
    retry_of_run_id: run.retry_of_run_id ?? null,
    error_code: run.error_code,
    error_summary: run.error_summary,
    cancel_requested_at: null,
    started_at: run.started_at,
    ended_at: run.ended_at,
    created_at: run.created_at,
    updated_at: run.updated_at,
  };
}

/** GET /runs/:id: core + plan hash + approvals (GAP-19) + task/repo/PR context (R1). */
function wRunDetail(state: FixtureState, run: FixtureRun): W.WRun {
  const task = state.tasks.find((t) => t.id === run.task_id)!;
  const repo = state.repositories.find((r) => r.id === task.repository_id);
  return {
    ...wRunCore(state, run),
    plan_hash: run.plan?.plan_hash ?? null,
    plan_version: run.plan?.version ?? null,
    data_disclosure: null,
    approvals: run.approvals.map((a) => ({
      id: a.id ?? undefined,
      approval_type: a.approval_type,
      decision: a.decision,
      subject_hash: a.subject_hash,
      comment: a.comment,
      user_id: a.user_id,
      created_at: a.created_at,
    })),
    task_title: task.title,
    repository_full_name: repo?.full_name,
    pull_request: run.pull_request
      ? { ...run.pull_request, created_at: run.pull_request.created_at ?? undefined }
      : null,
  };
}

/** The server sends `{}` for manual and issue tasks, and the untagged metadata otherwise. */
function wSourceContext(ctx: T.TaskSourceContext | null): NonNullable<W.WTask["source_context"]> {
  if (!ctx) return {};
  const { kind: _k, ...rest } = ctx;
  void _k;
  return rest;
}

function wTask(state: FixtureState, task: Scoped<T.EngineeringTask>): W.WTask {
  const repo = state.repositories.find((r) => r.id === task.repository_id);
  const latest = state.runs
    .filter((r) => r.task_id === task.id)
    .sort((a, b) => b.run_number - a.run_number)[0];
  return {
    id: task.id,
    workspace_id: task.workspace_id,
    repository_id: task.repository_id,
    created_by: task.created_by,
    source_type: task.source_type,
    external_number: task.external_number,
    external_id: task.external_id,
    source_url: task.source_url,
    source_context: wSourceContext(task.source_context),
    title: task.title,
    description: task.description,
    status: task.status,
    labels: task.labels,
    created_at: task.created_at,
    updated_at: task.updated_at,
    latest_run: latest
      ? {
          id: latest.id,
          run_number: latest.run_number,
          status: latest.status,
          current_stage: latest.current_stage,
          created_at: latest.created_at,
        }
      : null,
    repository_full_name: repo?.full_name,
  };
}

function wPlan(run: FixtureRun): W.WPlan {
  const p = run.plan!;
  const approval = run.approvals.filter((a) => a.approval_type === "plan").at(-1);
  return {
    run_id: run.id,
    version: p.version,
    plan_hash: p.plan_hash,
    source: p.source,
    created_by: null,
    created_at: p.updated_at,
    editable: run.status === "awaiting_plan_approval",
    plan: p.plan,
    investigation: p.investigation,
    approval: approval
      ? {
          decision: approval.decision,
          user_id: approval.user_id,
          comment: approval.comment,
          subject_hash: approval.subject_hash,
          created_at: approval.created_at,
        }
      : null,
  };
}

function wDiff(d: T.RunDiff): W.WDiff {
  return {
    patch_id: d.patch_id ?? "patch",
    patch_hash: d.patch_hash,
    attempt: d.attempt,
    base_commit_sha: d.base_commit_sha,
    summary: d.summary,
    additions: d.additions,
    deletions: d.deletions,
    changed_files: d.changed_files.map((c) => ({
      path: c.path,
      action: c.status === "added" ? "create" : c.status === "deleted" ? "delete" : "modify",
      explanation: c.explanation ?? null,
    })),
    diff: d.unified_diff,
    diff_truncated: d.truncated,
    attempts: [],
  };
}

function wVerification(v: T.VerificationReport, patchId: string | null): W.WVerification {
  const count = (s: T.VerificationStatus) => v.results.filter((r) => r.status === s).length;
  return {
    deterministic: true,
    current_patch_id: patchId,
    summary: {
      passed: count("passed"),
      failed: count("failed"),
      timed_out: count("timed_out"),
      skipped: count("skipped"),
      unavailable: v.unavailable.length,
    },
    results: v.results.map((r) => ({
      id: r.id,
      profile_id: r.profile_id,
      command_display: r.command_display,
      image: "node:22-alpine",
      status: r.status,
      exit_code: r.exit_code,
      duration_ms: r.duration_ms,
      output_truncated: false,
      stdout_excerpt: r.output_excerpt ?? null,
      stderr_excerpt: null,
      attempt: r.attempt ?? 1,
      patch_id: patchId ?? undefined,
      created_at: r.created_at ?? undefined,
    })),
    unavailable: v.unavailable.map((u) => ({ ...u, kind: "unsupported" as const })),
  };
}

function wFinding(f: T.ReviewFinding): W.WFinding {
  const ai = f.source === "ai_review";
  return {
    id: f.id,
    source: f.source,
    severity: f.severity,
    file_path: f.file_path,
    start_line: f.start_line,
    end_line: f.end_line,
    title: f.title,
    description: f.description,
    evidence: f.evidence,
    status: f.status,
    confidence: ai ? (f.confidence ?? null) : null,
    suggested_action: ai ? (f.evidence.suggested_action ?? null) : null,
    created_at: f.created_at ?? undefined,
  };
}

function wStep(s: T.AgentStep): W.WStep {
  return {
    id: s.id,
    sequence_number: s.sequence_number,
    agent_type: s.agent_type,
    status: s.status,
    prompt_version: s.prompt_version,
    provider: s.provider,
    model: s.model,
    input_tokens: s.input_tokens,
    output_tokens: s.output_tokens,
    duration_ms: s.duration_ms,
    error_code: s.error_code,
    input: null,
    output: s.output_redacted ?? null,
    started_at: s.started_at,
    ended_at: s.ended_at,
    tool_calls: (s.tools ?? []).map((t) => ({
      tool_name: t.tool_name,
      status: t.status,
      input: t.input_redacted,
      output: t.output_redacted,
      duration_ms: t.duration_ms,
    })),
  };
}

// ── repository indexing (lazy, time-based) ───────────────────────────────

const PARSERS = ["typescript", "javascript", "python"];

function advanceIndex(state: FixtureState, repo: Scoped<T.Repository>, now: number) {
  const job = state.index_jobs[repo.id];
  if (!job) return;
  const ratio = (now - job.started_at) / job.duration_ms;
  if (ratio >= 1) {
    repo.indexing_status = repo.full_name.endsWith("ml-pipeline") ? "partial" : "ready";
    repo.latest_indexed_commit_sha = job.commit_sha;
    repo.indexed_at = iso(job.started_at + job.duration_ms);
    delete state.index_jobs[repo.id];
  } else {
    repo.indexing_status = ratio < 0.12 ? "queued" : "indexing";
  }
}

function wIndexStatus(
  state: FixtureState,
  repo: Scoped<T.Repository>,
  now: number,
): W.WIndexStatus {
  advanceIndex(state, repo, now);
  const files = filesForRepository(repo.full_name);
  const job = state.index_jobs[repo.id];
  const included = files.filter((f) => !f.excluded);
  const languages: Record<string, { files: number; parsed: number }> = {};
  for (const f of files) {
    if (!f.language) continue;
    const e = (languages[f.language] ??= { files: 0, parsed: 0 });
    e.files++;
    if (!f.excluded) e.parsed++;
  }
  const excluded: Record<string, number> = {};
  for (const f of files) if (f.excluded) excluded[f.excluded] = (excluded[f.excluded] ?? 0) + 1;
  const sha = job?.commit_sha ?? repo.latest_indexed_commit_sha;
  const ready = repo.indexing_status === "ready" || repo.indexing_status === "partial";
  const ratio = job ? Math.min(1, (now - job.started_at) / job.duration_ms) : 1;
  const stages = [
    "resolving_commit",
    "fetching",
    "processing_files",
    "embedding",
    "resolving_relationships",
  ];
  const ml = repo.full_name.endsWith("ml-pipeline");
  return {
    repository_id: repo.id,
    indexing_status: repo.indexing_status,
    latest_snapshot: sha
      ? {
          id: `snap-${sha.slice(0, 8)}`,
          commit_sha: sha,
          branch_name: repo.default_branch,
          status: ready ? (repo.indexing_status === "partial" ? "partial" : "ready") : "processing",
          parser_version: "tree-sitter@0.25/anvaya-1",
          chunker_version: "lines-v2",
          embedding_model: `${EMBEDDING_MODEL}@v1.5`,
          limitations: ml
            ? "Jupyter notebooks are not parsed; notebook cells are excluded from retrieval.\nPython call relationships are not extracted yet."
            : "Symbol relationships across package boundaries are not extracted yet.",
          completed_at: repo.indexed_at,
        }
      : null,
    coverage: sha
      ? {
          total_files: files.length,
          indexed_files: ready ? included.length : Math.floor(included.length * ratio),
          excluded_files: files.length - included.length,
          failed_files: ml ? 1 : 0,
          reused_files: 0,
          excluded_by_reason: excluded,
          parse_status: {
            parsed: included.filter((f) => f.language && PARSERS.includes(f.language)).length,
            text_only: included.filter((f) => !f.language || !PARSERS.includes(f.language)).length,
          },
          languages,
          chunks: included.length * 3,
          embedded_chunks: ready ? included.length * 3 : 0,
        }
      : null,
    active_job: job
      ? {
          id: job.id,
          status: repo.indexing_status === "queued" ? "queued" : "running",
          stage:
            repo.indexing_status === "queued"
              ? null
              : stages[Math.min(stages.length - 1, Math.floor(ratio * stages.length))]!,
          trigger: "manual",
          commit_sha: job.commit_sha,
          progress: {
            files_total: files.length,
            files_processed: Math.floor(files.length * ratio),
            files_reused: 0,
          },
          attempts: 1,
          error_code: null,
          error_summary: null,
          created_at: iso(job.started_at),
          started_at: iso(job.started_at),
          ended_at: null,
        }
      : null,
    last_job: ml
      ? {
          id: "job-ml-last",
          status: "completed",
          stage: null,
          trigger: "initial",
          commit_sha: repo.latest_indexed_commit_sha,
          progress: {},
          attempts: 1,
          error_code: "PARTIAL_PARSE",
          error_summary: "notebooks/exploration.ipynb: unsupported language (jupyter)",
          created_at: repo.created_at,
          started_at: repo.created_at,
          ended_at: repo.indexed_at,
        }
      : null,
    supported_parsers: PARSERS,
  };
}

/** One directory level at `path` (lazy, like GET /repositories/:id/tree?path=). */
function treeLevel(fullName: string, dir: string): W.WTreeEntry[] {
  const prefix = dir ? `${dir.replace(/\/$/, "")}/` : "";
  const out = new Map<string, W.WTreeEntry>();
  for (const f of filesForRepository(fullName)) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const [head, ...tail] = rest.split("/");
    if (!head) continue;
    const path = prefix + head;
    if (tail.length) {
      const existing = out.get(path);
      const count = existing && existing.type === "directory" ? (existing.file_count ?? 0) + 1 : 1;
      out.set(path, { type: "directory", name: head, path, file_count: count });
    } else {
      out.set(path, {
        type: "file",
        name: head,
        path,
        language: f.language,
        parse_status: f.excluded
          ? null
          : f.language && PARSERS.includes(f.language)
            ? "parsed"
            : "text_only",
        excluded: !!f.excluded,
        exclusion_reason: f.excluded ?? null,
        byte_size: f.content.length,
        line_count: f.content ? f.content.replace(/\n$/, "").split("\n").length : 0,
      });
    }
  }
  return [...out.values()];
}

function repoForRead(req: FixtureRequest) {
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!);
  advanceIndex(req.state, repo, req.now);
  return repo;
}

function requireIndexed(repo: Scoped<T.Repository>) {
  if (!repo.latest_indexed_commit_sha)
    throw new FixtureHttpError(
      409,
      "REPOSITORY_NOT_INDEXED",
      "This repository has not finished indexing yet.",
    );
  return repo.latest_indexed_commit_sha;
}

// ── auth ─────────────────────────────────────────────────────────────────

route("GET", "/auth/providers", () => ok({ github: true, dev: true } satisfies W.WProviders));

route("POST", "/auth/dev-login", (req) => {
  strictBody(req, ["email", "display_name"]);
  const email = str(req.body, "email", { max: 254 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw validation("email", "must be a valid email address");
  let user = req.state.users.find((u) => u.email === email);
  if (!user) {
    user = {
      id: nextId(req.state, "01000000"),
      email,
      display_name: typeof req.body.display_name === "string" ? req.body.display_name : null,
      avatar_url: null,
    };
    req.state.users.push(user);
  }
  req.state.session_user_id = user.id;
  return ok({
    user,
    csrf_token: "fixture-csrf",
    expires_at: iso(req.now + 86_400_000),
  } satisfies W.WDevLogin);
});

route("GET", "/auth/csrf", () => ok({ csrf_token: "fixture-csrf" }));

route("POST", "/auth/logout", (req) => {
  req.state.session_user_id = null;
  return noContent();
});

// ── identity & workspaces ───────────────────────────────────────────────

route("GET", "/me", (req) => {
  const user = currentUser(req);
  const memberships = req.state.memberships
    .filter((m) => m.user_id === user.id)
    .map((m) => {
      const ws = req.state.workspaces.find((w) => w.id === m.workspace_id)!;
      return {
        workspace_id: m.workspace_id,
        workspace_name: ws.name,
        workspace_slug: ws.slug,
        role: m.role,
      };
    });
  return ok({
    user: { ...user, created_at: "2026-09-01T00:00:00.000Z" },
    memberships,
  } satisfies W.WMe);
});

route("GET", "/workspaces", (req) => {
  const user = currentUser(req);
  const ids = req.state.memberships.filter((m) => m.user_id === user.id).map((m) => m.workspace_id);
  return ok(req.state.workspaces.filter((w) => ids.includes(w.id)).map((w) => wWorkspace(req, w)));
});

route("POST", "/workspaces", (req) => {
  strictBody(req, ["name", "slug"]);
  const user = currentUser(req);
  const name = str(req.body, "name", { min: 2, max: 64 });
  const slug = str(req.body, "slug", { min: 2, max: 40 });
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug))
    throw validation("slug", "may contain lowercase letters, numbers, and hyphens");
  if (req.state.workspaces.some((w) => w.slug === slug)) {
    throw new FixtureHttpError(409, "SLUG_TAKEN", "That workspace URL is already taken.", {
      issues: [{ path: ["slug"], message: "This URL is already taken" }],
    });
  }
  const at = iso(req.now);
  const ws: FixtureWorkspace = {
    id: nextId(req.state, "11000000"),
    name,
    slug,
    plan_key: "personal",
    settings: {},
    created_at: at,
    updated_at: at,
  };
  req.state.workspaces.push(ws);
  req.state.memberships.push({
    workspace_id: ws.id,
    user_id: user.id,
    role: "owner",
    created_at: at,
  });
  req.state.policies[ws.id] = defaultPolicy();
  audit(req, ws.id, "workspace.created", "workspace", ws.id);
  return ok(wWorkspace(req, ws), 201);
});

route("GET", "/workspaces/:workspaceId", (req) => {
  const ws = req.state.workspaces.find((w) => w.id === req.params.workspaceId);
  if (!ws) throw new FixtureHttpError(404, "NOT_FOUND", "Workspace not found.");
  return ok(wWorkspace(req, ws));
});

route("PATCH", "/workspaces/:workspaceId", (req) => {
  strictBody(req, ["name", "settings"]);
  requireRole(req, req.params.workspaceId!, "admin");
  const ws = req.state.workspaces.find((w) => w.id === req.params.workspaceId)!;
  if (req.body.name !== undefined) ws.name = str(req.body, "name", { min: 2, max: 64 });
  const settings = req.body.settings as W.WWorkspace["settings"] | undefined;
  if (settings?.run_budget_limits) {
    for (const [k, v] of Object.entries(settings.run_budget_limits)) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
        throw validation(`settings.run_budget_limits.${k}`, "must be a non-negative integer");
    }
    ws.settings = {
      ...ws.settings,
      run_budget_limits: { ...ws.settings.run_budget_limits, ...settings.run_budget_limits },
    };
  }
  if (settings?.retention)
    ws.settings = {
      ...ws.settings,
      retention: { ...ws.settings.retention, ...settings.retention },
    };
  let quotaChange: { from: W.WRunQuotas; to: W.WRunQuotas } | null = null;
  if (settings?.run_quotas) {
    const from = { ...(ws.settings.run_quotas ?? {}) };
    const to: W.WRunQuotas = { ...from };
    for (const [k, v] of Object.entries(settings.run_quotas)) {
      const key = k as keyof W.WRunQuotas;
      const range = QUOTA_RANGES[key];
      if (!range) throw validation(`settings.run_quotas.${k}`, "is not a known quota");
      if (v === null) delete to[key];
      else if (typeof v !== "number" || !Number.isInteger(v) || v < range[0] || v > range[1])
        throw validation(
          `settings.run_quotas.${k}`,
          `must be an integer from ${range[0]} to ${range[1]}`,
        );
      else to[key] = v;
    }
    ws.settings = { ...ws.settings, run_quotas: to };
    quotaChange = { from, to };
  }
  ws.updated_at = iso(req.now);
  audit(req, ws.id, "workspace.updated", "workspace", ws.id, { fields: Object.keys(req.body) });
  if (quotaChange) audit(req, ws.id, "workspace.quotas_updated", "workspace", ws.id, quotaChange);
  return ok(wWorkspace(req, ws));
});

const QUOTA_RANGES: Record<keyof W.WRunQuotas, [number, number]> = {
  max_active_runs: [1, 1000],
  daily_runs: [1, 100_000],
  daily_tokens: [1000, 1_000_000_000],
};

/** Start of the UTC day containing `now` and the next UTC midnight. */
function utcDay(now: number) {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { start, end: start + 86_400_000 };
}

function quotaUsage(state: FixtureState, workspaceId: string, now: number) {
  const { start } = utcDay(now);
  const runs = state.runs.filter((r) => r.workspace_id === workspaceId);
  const today = runs.filter((r) => Date.parse(r.created_at) >= start);
  return {
    active: runs.filter((r) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status))
      .length,
    runsToday: today.length,
    // Fixture approximation of usage_records: tokens recorded by today's runs.
    tokensToday: today.reduce(
      (s, r) => s + (r.usage_summary.input_tokens ?? 0) + (r.usage_summary.output_tokens ?? 0),
      0,
    ),
  };
}

/** FR-OBS-004: mirrors the API's checks when a run starts (or is retried). */
function assertCanStartRun(req: FixtureRequest, workspaceId: string) {
  const ws = req.state.workspaces.find((w) => w.id === workspaceId)!;
  const q = ws.settings.run_quotas ?? {};
  const u = quotaUsage(req.state, workspaceId, req.now);
  const { end } = utcDay(req.now);
  const retry_after_seconds = Math.max(1, Math.ceil((end - req.now) / 1000));
  const resets_at = new Date(end).toISOString();
  if (typeof q.max_active_runs === "number" && u.active >= q.max_active_runs)
    throw new FixtureHttpError(
      429,
      "CONCURRENCY_LIMIT_REACHED",
      `This workspace already has ${u.active} active run(s); its limit is ${q.max_active_runs}. Wait for a run to finish or cancel one.`,
      { limit: q.max_active_runs, active_runs: u.active },
    );
  if (typeof q.daily_runs === "number" && u.runsToday >= q.daily_runs)
    throw new FixtureHttpError(
      429,
      "QUOTA_EXCEEDED",
      `This workspace has used its daily quota of ${q.daily_runs} run(s). It resets at ${resets_at}.`,
      {
        quota: "daily_runs",
        limit: q.daily_runs,
        used: u.runsToday,
        resets_at,
        retry_after_seconds,
      },
    );
  if (typeof q.daily_tokens === "number" && u.tokensToday >= q.daily_tokens)
    throw new FixtureHttpError(
      429,
      "QUOTA_EXCEEDED",
      `This workspace has used its daily quota of ${q.daily_tokens} model tokens. It resets at ${resets_at}.`,
      {
        quota: "daily_tokens",
        limit: q.daily_tokens,
        used: u.tokensToday,
        resets_at,
        retry_after_seconds,
      },
    );
}

route("GET", "/workspaces/:workspaceId/quotas", (req) => {
  membership(req, req.params.workspaceId!);
  const ws = req.state.workspaces.find((w) => w.id === req.params.workspaceId)!;
  const q = ws.settings.run_quotas ?? {};
  const u = quotaUsage(req.state, ws.id, req.now);
  const { start, end } = utcDay(req.now);
  const entry = (limit: number | null | undefined, used: number): W.WQuotaEntry => ({
    limit: limit ?? null,
    used,
    remaining: typeof limit === "number" ? Math.max(0, limit - used) : null,
  });
  const body: W.WQuotaStatus = {
    workspace_id: ws.id,
    active_runs: entry(q.max_active_runs, u.active),
    daily_runs: entry(q.daily_runs, u.runsToday),
    daily_tokens: entry(q.daily_tokens, u.tokensToday),
    window_start: new Date(start).toISOString(),
    resets_at: new Date(end).toISOString(),
  };
  return ok(body);
});

route("GET", "/workspaces/:workspaceId/members", (req) => {
  membership(req, req.params.workspaceId!);
  const members: W.WMember[] = req.state.memberships
    .filter((m) => m.workspace_id === req.params.workspaceId)
    .map((m) => {
      const u = req.state.users.find((x) => x.id === m.user_id)!;
      return {
        user_id: u.id,
        email: u.email,
        display_name: u.display_name,
        avatar_url: u.avatar_url,
        role: m.role,
        joined_at: m.created_at,
      };
    });
  return paginate(members, req.query);
});

route("GET", "/workspaces/:workspaceId/invitations", (req) => {
  requireRole(req, req.params.workspaceId!, "admin");
  const items: W.WInvitation[] = req.state.invitations
    .filter((i) => i.workspace_id === req.params.workspaceId)
    .map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role as W.WInvitation["role"],
      status:
        i.status === "pending" && i.expires_at && Date.parse(i.expires_at) < req.now
          ? "expired"
          : i.status,
      expires_at: i.expires_at ?? iso(req.now),
      created_at: i.created_at,
    }));
  return paginate(items, req.query);
});

route("POST", "/workspaces/:workspaceId/invitations", (req) => {
  strictBody(req, ["email", "role"]);
  const wsId = req.params.workspaceId!;
  const actor = requireRole(req, wsId, "admin");
  const email = str(req.body, "email", { max: 254 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw validation("email", "must be a valid email address");
  const role = req.body.role as T.WorkspaceRole;
  if (!["admin", "member", "viewer"].includes(role))
    throw validation("role", "must be admin, member, or viewer");
  if (role === "admin" && actor.role !== "owner")
    throw new FixtureHttpError(403, "FORBIDDEN", "Only owners can invite admins.");
  const isMember = req.state.memberships.some(
    (m) =>
      m.workspace_id === wsId && req.state.users.find((u) => u.id === m.user_id)?.email === email,
  );
  if (isMember)
    throw new FixtureHttpError(409, "ALREADY_MEMBER", "This person is already a member.", {
      issues: [{ path: ["email"], message: "Already a member" }],
    });
  if (
    req.state.invitations.some(
      (i) => i.workspace_id === wsId && i.email === email && i.status === "pending",
    )
  ) {
    throw new FixtureHttpError(
      409,
      "INVITATION_PENDING",
      "An invitation is already pending for this email.",
      { issues: [{ path: ["email"], message: "An invitation is already pending" }] },
    );
  }
  const token = `inv_${nextId(req.state, "13000000").replace(/-/g, "")}`;
  const inv = {
    id: nextId(req.state, "12000000"),
    workspace_id: wsId,
    email,
    role,
    status: "pending" as const,
    expires_at: iso(req.now + 7 * 86_400_000),
    created_at: iso(req.now),
    token,
  };
  req.state.invitations.push(inv);
  audit(req, wsId, "membership.invited", "invitation", inv.id, { role });
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return ok(
    {
      id: inv.id,
      email,
      role: role as W.WInvitation["role"],
      status: "pending",
      expires_at: inv.expires_at,
      created_at: inv.created_at,
      token,
      accept_url: `${origin}/invitations/accept#token=${token}`,
    } satisfies W.WInvitation,
    201,
  );
});

route("DELETE", "/workspaces/:workspaceId/invitations/:invitationId", (req) => {
  requireRole(req, req.params.workspaceId!, "admin");
  const inv = req.state.invitations.find(
    (i) => i.id === req.params.invitationId && i.workspace_id === req.params.workspaceId,
  );
  if (!inv) throw new FixtureHttpError(404, "NOT_FOUND", "Invitation not found.");
  inv.status = "revoked";
  audit(req, inv.workspace_id, "membership.invitation_revoked", "invitation", inv.id);
  return noContent();
});

route("POST", "/invitations/accept", (req) => {
  strictBody(req, ["token"]);
  const user = currentUser(req);
  const token = str(req.body, "token", { min: 20, max: 128 });
  const inv = req.state.invitations.find((i) => i.token === token);
  if (!inv || inv.status !== "pending")
    throw new FixtureHttpError(
      404,
      "NOT_FOUND",
      "This invitation is invalid or has already been used.",
    );
  if (inv.expires_at && Date.parse(inv.expires_at) < req.now)
    throw new FixtureHttpError(404, "NOT_FOUND", "This invitation has expired.");
  if (inv.email !== user.email)
    throw new FixtureHttpError(
      403,
      "FORBIDDEN",
      `This invitation was sent to ${inv.email}. Sign in with that account to accept it.`,
    );
  inv.status = "accepted";
  req.state.memberships.push({
    workspace_id: inv.workspace_id,
    user_id: user.id,
    role: inv.role,
    created_at: iso(req.now),
  });
  audit(req, inv.workspace_id, "membership.joined", "membership", user.id, { role: inv.role });
  return ok(
    wWorkspace(
      req,
      req.state.workspaces.find((w) => w.id === inv.workspace_id)!,
    ),
  );
});

route("PATCH", "/workspaces/:workspaceId/members/:userId", (req) => {
  strictBody(req, ["role"]);
  const wsId = req.params.workspaceId!;
  const actor = requireRole(req, wsId, "admin");
  const target = req.state.memberships.find(
    (m) => m.workspace_id === wsId && m.user_id === req.params.userId,
  );
  if (!target) throw new FixtureHttpError(404, "NOT_FOUND", "Member not found.");
  const role = req.body.role as T.WorkspaceRole;
  if (!["owner", "admin", "member", "viewer"].includes(role))
    throw validation("role", "is invalid");
  if (
    (target.role === "owner" || target.role === "admin" || role === "owner" || role === "admin") &&
    actor.role !== "owner"
  ) {
    throw new FixtureHttpError(403, "FORBIDDEN", "Only owners can change owner or admin roles.");
  }
  if (
    target.role === "owner" &&
    role !== "owner" &&
    req.state.memberships.filter((m) => m.workspace_id === wsId && m.role === "owner").length === 1
  ) {
    throw new FixtureHttpError(409, "LAST_OWNER", "A workspace must keep at least one owner.");
  }
  const previous = target.role;
  target.role = role;
  audit(req, wsId, "membership.role_changed", "membership", target.user_id, {
    from: previous,
    to: role,
  });
  const u = req.state.users.find((x) => x.id === target.user_id)!;
  return ok({
    user_id: u.id,
    email: u.email,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    role,
    joined_at: target.created_at,
  } satisfies W.WMember);
});

route("DELETE", "/workspaces/:workspaceId/members/:userId", (req) => {
  const wsId = req.params.workspaceId!;
  const self = req.params.userId === req.state.session_user_id;
  if (self) membership(req, wsId);
  else requireRole(req, wsId, "admin");
  const idx = req.state.memberships.findIndex(
    (m) => m.workspace_id === wsId && m.user_id === req.params.userId,
  );
  if (idx < 0) throw new FixtureHttpError(404, "NOT_FOUND", "Member not found.");
  const target = req.state.memberships[idx]!;
  if (
    target.role === "owner" &&
    req.state.memberships.filter((m) => m.workspace_id === wsId && m.role === "owner").length === 1
  ) {
    throw new FixtureHttpError(409, "LAST_OWNER", "The last owner cannot be removed.");
  }
  req.state.memberships.splice(idx, 1);
  audit(req, wsId, "membership.removed", "membership", req.params.userId!);
  return noContent();
});

route("GET", "/workspaces/:workspaceId/audit-events", (req) => {
  const wsId = req.params.workspaceId!;
  requireRole(req, wsId, "admin");
  const action = req.query.get("action");
  const actor = req.query.get("actor_user_id");
  const from = req.query.get("from");
  const to = req.query.get("to");
  const items: W.WAuditEvent[] = req.state.audit
    .filter((a) => a.workspace_id === wsId)
    .filter((a) => !action || a.action.startsWith(action))
    .filter((a) => !actor || a.actor_user_id === actor)
    .filter((a) => !from || a.created_at >= from)
    .filter((a) => !to || a.created_at < to)
    .map((a) => ({
      id: a.id,
      actor_type: a.actor_type,
      actor_user_id: a.actor_user_id,
      actor_email: a.actor_user_id
        ? (req.state.users.find((u) => u.id === a.actor_user_id)?.email ?? a.actor_display)
        : null,
      action: a.action,
      resource_type: a.resource_type,
      resource_id: a.resource_id,
      request_id: a.request_id,
      metadata: a.metadata_redacted,
      created_at: a.created_at,
    }));
  return paginate(items, req.query);
});

// ── AI policy, health, usage ─────────────────────────────────────────────

route("GET", "/workspaces/:workspaceId/ai-policy", (req) => {
  membership(req, req.params.workspaceId!);
  return ok((req.state.policies[req.params.workspaceId!] ??= defaultPolicy()));
});

route("PATCH", "/workspaces/:workspaceId/ai-policy", (req) => {
  strictBody(req, [
    "default_mode",
    "allowed_modes",
    "cloud",
    "limits",
    "acknowledge_data_disclosure",
  ]);
  const wsId = req.params.workspaceId!;
  requireRole(req, wsId, "admin");
  const current = (req.state.policies[wsId] ??= defaultPolicy());
  const body = req.body as T.UpdateAiPolicyRequest;
  const next: T.AiPolicy = structuredClone(current);
  if (body.cloud) next.cloud = { ...next.cloud, ...body.cloud };
  if (body.limits) next.limits = { ...next.limits, ...body.limits };
  if (body.allowed_modes) next.allowed_modes = body.allowed_modes;
  if (body.default_mode) next.default_mode = body.default_mode;
  if (next.cloud.enabled && !current.cloud.enabled) {
    if (!next.cloud.provider) next.cloud.provider = "hosted-provider";
    if (!next.cloud.model) next.cloud.model = "hosted-large";
    if (!next.cloud.data_categories.length)
      next.cloud.data_categories = ["source_code", "documentation", "test_output"];
    if (!body.acknowledge_data_disclosure) {
      throw new FixtureHttpError(
        422,
        "DATA_DISCLOSURE_REQUIRED",
        "Enabling cloud inference requires acknowledging what data is sent.",
        {
          provider: next.cloud.provider,
          data_categories: next.cloud.data_categories,
        },
      );
    }
    if (!next.allowed_modes.includes("cloud"))
      next.allowed_modes = [...next.allowed_modes, "cloud"];
  }
  if (!next.cloud.enabled) {
    next.allowed_modes = next.allowed_modes.filter((m) => m !== "cloud");
    if (next.default_mode === "cloud") next.default_mode = "local";
  }
  if (next.allowed_modes.length === 0)
    throw validation("allowed_modes", "must contain at least one mode");
  if (!next.allowed_modes.includes(next.default_mode))
    throw validation("default_mode", "must be one of the allowed modes");
  req.state.policies[wsId] = next;
  audit(req, wsId, "ai_policy.updated", "ai_policy", wsId, {
    fields: Object.keys(body),
    cloud_enabled: next.cloud.enabled,
  });
  return ok(next);
});

route("POST", "/ai/providers/health-check", (req) => {
  strictBody(req, ["workspace_id", "mode"]);
  const wsId = scope(req);
  const policy = req.state.policies[wsId] ?? defaultPolicy();
  const mode = (req.body.mode as T.InferenceMode | undefined) ?? policy.default_mode;
  if (!policy.allowed_modes.includes(mode))
    throw new FixtureHttpError(
      403,
      "MODE_NOT_ALLOWED",
      `The ${mode} mode is not allowed by workspace policy.`,
    );
  return ok({
    mode,
    provider: mode === "cloud" ? policy.cloud.provider : mode === "mock" ? "mock" : "ollama",
    available: true,
    models:
      mode === "cloud"
        ? [policy.cloud.model ?? "hosted"]
        : mode === "mock"
          ? ["mock-deterministic"]
          : [LOCAL_MODEL, EMBEDDING_MODEL],
    detail: mode === "local" ? "1 model loaded · 1 concurrent request" : null,
    checked_at: iso(req.now),
  } satisfies W.WProviderHealth);
});

route("GET", "/workspaces/:workspaceId/usage", (req) => {
  const wsId = req.params.workspaceId!;
  requireRole(req, wsId, "member");
  const from = req.query.get("from") ?? iso(req.now - 29 * 86_400_000);
  const to = req.query.get("to");
  const records = req.state.usage.filter(
    (u) => u.workspace_id === wsId && u.at >= from && (!to || u.at < to),
  );
  const cost = (rs: typeof records) =>
    rs.some((r) => r.cost) ? rs.reduce((s, r) => s + r.cost, 0) : null;
  const agg = (rs: typeof records): W.WUsageAgg => ({
    requests: rs.length,
    input_tokens: rs.reduce((s, r) => s + r.input_tokens, 0),
    output_tokens: rs.reduce((s, r) => s + r.output_tokens, 0),
    estimated_cost_microunits: cost(rs),
    avg_duration_ms: rs.length ? 820 : 0,
  });
  const group = (key: (r: (typeof records)[number]) => string) => {
    const m = new Map<string, typeof records>();
    for (const r of records) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  const byProvider = [...group((r) => `${r.provider}\u0000${r.model}`).entries()].map(([k, rs]) => {
    const [provider, model] = k.split("\u0000");
    return { provider: provider!, model: model!, ...agg(rs) };
  });
  const byOperation = [...group((r) => r.operation).entries()].map(([operation, rs]) => ({
    operation,
    ...agg(rs),
  }));
  const daily: NonNullable<W.WUsage["daily"]> = [];
  for (
    let t = Date.parse(from.slice(0, 10));
    t <= (to ? Date.parse(to) : req.now);
    t += 86_400_000
  ) {
    const date = iso(t).slice(0, 10);
    const day = records.filter((r) => r.at.slice(0, 10) === date);
    daily.push({
      date,
      requests: day.length,
      input_tokens: day.reduce((s, r) => s + r.input_tokens, 0),
      output_tokens: day.reduce((s, r) => s + r.output_tokens, 0),
      estimated_cost_microunits: cost(day),
    });
  }
  return ok({
    workspace_id: wsId,
    period: { from, to },
    totals: agg(records),
    local_vs_hosted: {
      local: records.filter((r) => r.provider === "ollama").length,
      mock: records.filter((r) => r.provider === "mock").length,
      hosted: records.filter((r) => r.provider !== "ollama" && r.provider !== "mock").length,
    },
    by_provider: byProvider,
    by_operation: byOperation,
    daily,
  } satisfies W.WUsage);
});

// ── GitHub (server-held install state, GAP-14) ───────────────────────────

route("GET", "/integrations/github/install-url", (req) => {
  const wsId = scope(req, "admin");
  const state = `st_${nextId(req.state, "14000000").replace(/-/g, "")}`;
  req.state.install_states[state] = {
    workspace_id: wsId,
    user_id: req.state.session_user_id!,
    expires_at: req.now + 600_000,
    used: false,
  };
  // In fixtures the "GitHub" round-trip returns straight to our callback page with the
  // same query parameters GitHub appends (code, installation_id, setup_action, state).
  const url = `/integrations/github/callback?code=fixture-oauth-code&installation_id=99001&setup_action=install&state=${state}`;
  return ok({ url, state, expires_in_seconds: 600 } satisfies W.WInstallUrl);
});

route("POST", "/integrations/github/complete", (req) => {
  strictBody(req, ["workspace_id", "installation_id", "state", "code", "setup_action"]);
  const user = currentUser(req);
  const state = str(req.body, "state");
  if (typeof req.body.code !== "string" || !req.body.code) throw validation("code", "is required");
  const held = req.state.install_states[state];
  if (!held || held.used || held.expires_at < req.now || held.user_id !== user.id) {
    throw new FixtureHttpError(
      409,
      "INSTALL_STATE_INVALID",
      "This installation request expired or was already used. Start again from your workspace.",
    );
  }
  if (typeof req.body.workspace_id === "string" && req.body.workspace_id !== held.workspace_id) {
    throw new FixtureHttpError(
      403,
      "FORBIDDEN",
      "The installation request belongs to another workspace.",
    );
  }
  const wsId = held.workspace_id;
  requireRole(req, wsId, "admin");
  held.used = true;
  const externalId = Number(req.body.installation_id);
  if (!Number.isInteger(externalId) || externalId <= 0)
    throw validation("installation_id", "is invalid");
  const existing = req.state.installations.find((i) => i.external_installation_id === externalId);
  if (existing && existing.workspace_id !== wsId)
    throw new FixtureHttpError(
      409,
      "INSTALLATION_IN_USE",
      "This GitHub installation is connected to another workspace.",
    );
  if (existing) {
    existing.status = "active";
    return ok(wInstallation(existing));
  }
  const inst: Scoped<T.GitInstallation> = {
    id: nextId(req.state, "21000000"),
    workspace_id: wsId,
    provider: "github",
    external_installation_id: externalId,
    account_login: "acme-labs",
    account_type: "Organization",
    granted_permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "read",
      metadata: "read",
    },
    status: "active",
    created_at: iso(req.now),
  };
  req.state.installations.push(inst);
  for (const name of ["checkout-service", "payments-api"]) {
    req.state.available.push({
      external_repository_id: 900_000 + req.state.available.length,
      full_name: `acme-labs/${name}`,
      owner: "acme-labs",
      name,
      default_branch: "main",
      visibility: "private",
      installation_id: inst.id,
    });
  }
  audit(req, wsId, "git_installation.connected", "git_installation", inst.id, {
    account: inst.account_login,
  });
  return ok(wInstallation(inst), 201);
});

route("GET", "/integrations/github/installations", (req) => {
  const wsId = scope(req);
  return ok(
    req.state.installations
      .filter((i) => i.workspace_id === wsId && i.status !== "disconnected")
      .map(wInstallation),
  );
});

route("DELETE", "/integrations/github/installations/:id", (req) => {
  const inst = findScoped(req, req.state.installations, req.params.id!, "admin");
  inst.status = "disconnected";
  for (const repo of req.state.repositories.filter((r) => r.installation_id === inst.id)) {
    repo.status = "disconnected";
    repo.indexing_status = "disabled";
    delete req.state.index_jobs[repo.id];
  }
  audit(req, inst.workspace_id, "git_installation.disconnected", "git_installation", inst.id);
  return noContent();
});

route("GET", "/integrations/github/installations/:id/repositories", (req) => {
  const inst = findScoped(req, req.state.installations, req.params.id!, "admin");
  if (inst.status !== "active")
    throw new FixtureHttpError(409, "INVALID_STATE_TRANSITION", "The installation is not active.");
  const connected = new Map(
    req.state.repositories
      .filter((r) => r.workspace_id === inst.workspace_id && r.status !== "disconnected")
      .map((r) => [r.external_repository_id, r.id] as const),
  );
  const page = Math.max(1, Math.min(100, Number(req.query.get("page") ?? 1) || 1));
  const all = req.state.available.filter((a) => a.installation_id === inst.id);
  const repositories: W.WAvailableRepository[] = all
    .slice((page - 1) * 100, page * 100)
    .map((a) => ({
      external_repository_id: a.external_repository_id,
      full_name: a.full_name,
      private: a.visibility !== "public",
      default_branch: a.default_branch,
      archived: false,
      connected_repository_id: connected.get(a.external_repository_id) ?? null,
    }));
  return ok({ total_count: all.length, page, repositories } satisfies W.WAvailableRepositoriesPage);
});

// ── repositories ─────────────────────────────────────────────────────────

route("GET", "/repositories", (req) => {
  const wsId = scope(req);
  const items = req.state.repositories
    .filter((r) => r.workspace_id === wsId && r.status !== "disconnected")
    .map((r) => {
      advanceIndex(req.state, r, req.now);
      return wRepository(r);
    });
  return paginate(items, req.query);
});

function startIndex(req: FixtureRequest, repo: Scoped<T.Repository>) {
  if (req.state.index_jobs[repo.id]) return;
  const sha = repo.full_name.endsWith("ml-pipeline")
    ? "4e8a1c93b27f6d05e1a2c3b4d5e6f708192a3b4c"
    : "9f3c2a17e4b5d8061c2e7a9b4f1d3e5c7a8b9c0d";
  req.state.index_jobs[repo.id] = {
    id: nextId(req.state, "32000000"),
    started_at: req.now,
    duration_ms: Math.max(1500, stageDurationMs() * 5),
    commit_sha: sha,
  };
  repo.indexing_status = "queued";
}

route("POST", "/repositories", (req) => {
  strictBody(req, ["workspace_id", "installation_id", "external_repository_id", "index"]);
  const wsId = scope(req, "admin");
  const installationId = str(req.body, "installation_id");
  const externalId = Number(req.body.external_repository_id);
  const inst = req.state.installations.find(
    (i) => i.id === installationId && i.workspace_id === wsId,
  );
  if (!inst) throw new FixtureHttpError(404, "NOT_FOUND", "Installation not found.");
  if (inst.status !== "active")
    throw new FixtureHttpError(409, "INVALID_STATE_TRANSITION", "The installation is not active.");
  const avail = req.state.available.find(
    (a) => a.installation_id === inst.id && a.external_repository_id === externalId,
  );
  if (!avail)
    throw new FixtureHttpError(
      403,
      "REPOSITORY_NOT_GRANTED",
      "The GitHub App installation does not grant access to this repository.",
    );
  const existing = req.state.repositories.find((r) => r.external_repository_id === externalId);
  if (existing && existing.workspace_id !== wsId)
    throw new FixtureHttpError(
      409,
      "REPOSITORY_ALREADY_CONNECTED",
      "This repository is connected to another workspace.",
    );
  if (existing && existing.status === "connected") {
    throw new FixtureHttpError(
      409,
      "REPOSITORY_ALREADY_CONNECTED",
      "This repository is already connected.",
      { repository_id: existing.id },
    );
  }
  const at = iso(req.now);
  const repo: Scoped<T.Repository> = existing ?? {
    id: nextId(req.state, "31000000"),
    workspace_id: wsId,
    installation_id: inst.id,
    provider: "github",
    external_repository_id: externalId,
    owner: avail.owner,
    name: avail.name,
    full_name: avail.full_name,
    default_branch: avail.default_branch,
    visibility: avail.visibility,
    status: "connected",
    indexing_status: "pending",
    latest_indexed_commit_sha: null,
    indexed_at: null,
    settings: {},
    created_at: at,
    updated_at: at,
  };
  repo.status = "connected";
  repo.indexing_status = "pending";
  if (!existing) req.state.repositories.push(repo);
  if (req.body.index === true) startIndex(req, repo);
  audit(req, wsId, "repository.connected", "repository", repo.id, { full_name: repo.full_name });
  return ok(wRepository(repo), 201);
});

route("GET", "/repositories/:repositoryId", (req) => ok(wRepository(repoForRead(req))));

route("PATCH", "/repositories/:repositoryId", (req) => {
  strictBody(req, ["settings", "status"]);
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!, "admin");
  const body = req.body as { settings?: W.WRepositorySettings; status?: "connected" | "disabled" };
  if (body.settings) {
    const unknown = Object.keys(body.settings).filter(
      (k) =>
        ![
          "exclude_paths",
          "max_file_bytes",
          "auto_index_on_push",
          "verification_profiles",
        ].includes(k),
    );
    if (unknown.length) throw validation(`settings.${unknown[0]}`, "is not a recognised setting");
    if (body.settings.exclude_paths) {
      const paths = body.settings.exclude_paths.map((p) => p.trim()).filter(Boolean);
      if (paths.some((p) => p.includes("..") || p.startsWith("/")))
        throw validation("settings.exclude_paths", "must be relative paths without '..'");
      repo.settings = { ...repo.settings, exclude_paths: paths };
    }
    if (body.settings.verification_profiles)
      repo.settings = {
        ...repo.settings,
        verification_profiles: body.settings.verification_profiles,
      };
  }
  if (body.status) {
    repo.status = body.status;
    if (body.status === "disabled") repo.indexing_status = "disabled";
  }
  repo.updated_at = iso(req.now);
  audit(req, repo.workspace_id, "repository.updated", "repository", repo.id, {
    fields: Object.keys(body),
  });
  return ok(wRepository(repo));
});

route("DELETE", "/repositories/:repositoryId", (req) => {
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!, "admin");
  repo.status = "disconnected";
  repo.indexing_status = "disabled";
  delete req.state.index_jobs[repo.id];
  audit(req, repo.workspace_id, "repository.disconnected", "repository", repo.id, {
    full_name: repo.full_name,
  });
  return noContent();
});

route("POST", "/repositories/:repositoryId/index", (req) => {
  strictBody(req, ["ref"]);
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!, "member");
  if (repo.status !== "connected")
    throw new FixtureHttpError(
      409,
      "REPOSITORY_NOT_CONNECTED",
      "Reconnect this repository before indexing.",
    );
  const coalesced = !!req.state.index_jobs[repo.id];
  startIndex(req, repo);
  const job = req.state.index_jobs[repo.id]!;
  audit(req, repo.workspace_id, "repository.index_queued", "repository", repo.id);
  return ok(
    {
      indexing_job_id: job.id,
      status: "queued",
      trigger: "manual",
      requested_ref: req.body.ref ?? null,
      coalesced,
      created_at: iso(job.started_at),
    },
    202,
  );
});

route("GET", "/repositories/:repositoryId/index-status", (req) => {
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!);
  return ok(wIndexStatus(req.state, repo, req.now));
});

route("GET", "/repositories/:repositoryId/tree", (req) => {
  const repo = repoForRead(req);
  const sha = requireIndexed(repo);
  const path = (req.query.get("path") ?? "").replace(/^\/+|\/+$/g, "");
  if (path.split("/").includes(".."))
    throw new FixtureHttpError(400, "BAD_REQUEST", "Invalid path.");
  const entries = treeLevel(repo.full_name, path);
  if (path && entries.length === 0)
    throw new FixtureHttpError(404, "NOT_FOUND", "Directory not found at this commit.");
  return ok({
    snapshot_id: `snap-${sha.slice(0, 8)}`,
    commit_sha: sha,
    path,
    entries,
    truncated: false,
  } satisfies W.WTree);
});

route("GET", "/repositories/:repositoryId/files/content", (req) => {
  const repo = repoForRead(req);
  const sha = requireIndexed(repo);
  const path = req.query.get("path") ?? "";
  if (!path || path.split("/").includes("..") || path.startsWith("/"))
    throw new FixtureHttpError(400, "BAD_REQUEST", "Invalid path.");
  const file = filesForRepository(repo.full_name).find((f) => f.path === path);
  if (!file) throw new FixtureHttpError(404, "NOT_FOUND", "File not found at this commit.");
  if (file.excluded) {
    throw new FixtureHttpError(
      403,
      "FILE_EXCLUDED",
      `This file is excluded from indexing (${file.excluded.replace(/_/g, " ")}).`,
      { reason: file.excluded },
    );
  }
  const lines = file.content.replace(/\n$/, "").split("\n");
  return ok({
    path,
    commit_sha: req.query.get("commit_sha") || sha,
    content_hash: contentHash(file.content),
    language: file.language,
    content: file.content,
    line_count: lines.length,
    start_line: 1,
    end_line: lines.length,
    truncated: false,
    parse_status: file.language && PARSERS.includes(file.language) ? "parsed" : "text_only",
  } satisfies W.WFile);
});

route("POST", "/repositories/:repositoryId/search", (req) => {
  strictBody(req, ["query", "snapshot", "top_k", "mode", "filters"]);
  const repo = repoForRead(req);
  const sha = requireIndexed(repo);
  const query = str(req.body, "query", { min: 2, max: 500 });
  const topK = Math.min(Math.max(Number(req.body.top_k) || 8, 1), 25);
  const results = searchFiles(
    filesForRepository(repo.full_name),
    query,
    sha,
    topK,
    req.body.filters as T.SearchFilters | undefined,
  );
  return ok({
    results: results.map((r, i) => ({
      ...r,
      chunk_id: `chunk-${i}`,
      score:
        Math.round(((r.lexical_score ?? 0) * 0.45 + (r.semantic_score ?? 0) * 0.55) * 100) / 100,
      language: r.language ?? null,
      symbol_name: r.symbol_name ?? null,
    })),
    retrieval: {
      snapshot_id: `snap-${sha.slice(0, 8)}`,
      commit_sha: sha,
      snapshot_status: repo.indexing_status,
      lexical: "ok",
      semantic: "ok",
      embedding_model: EMBEDDING_MODEL,
    },
  } satisfies W.WSearch);
});

// ── code intelligence (GAP-15) ───────────────────────────────────────────

function snapshotSha(req: FixtureRequest, repo: Scoped<T.Repository>): string {
  const sha = requireIndexed(repo);
  const snap = req.query.get("snapshot");
  if (!snap || snap === "latest") return sha;
  if (!/^[0-9a-f]{40}$/.test(snap))
    throw validation("snapshot", "must be latest or a 40-char commit SHA");
  if (snap !== sha) throw new FixtureHttpError(404, "NOT_FOUND", "Snapshot not found.");
  return sha;
}

const KINDS = ["function", "class", "method", "type", "interface", "module"];

route("GET", "/repositories/:repositoryId/symbols", (req) => {
  const repo = repoForRead(req);
  const sha = snapshotSha(req, repo);
  const q = (req.query.get("q") ?? "").toLowerCase();
  const kinds = req.query.getAll("kind");
  for (const k of kinds)
    if (!KINDS.includes(k)) throw validation("kind", `must be one of ${KINDS.join(", ")}`);
  const path = req.query.get("path") ?? "";
  const items = parseSymbols(filesForRepository(repo.full_name), sha)
    .filter(
      (s) => !q || s.name.toLowerCase().includes(q) || s.qualified_name!.toLowerCase().includes(q),
    )
    .filter((s) => !kinds.length || kinds.includes(s.kind))
    .filter((s) => !path || (path.endsWith("/") ? s.path.startsWith(path) : s.path === path))
    .map(toWire);
  if (req.query.get("limit") === null) req.query.set("limit", "50");
  return paginate(items, req.query);
});

route("GET", "/repositories/:repositoryId/symbols/:symbolId", (req) => {
  const repo = repoForRead(req);
  const sha = snapshotSha(req, repo);
  const detail = symbolDetail(filesForRepository(repo.full_name), sha, req.params.symbolId!);
  if (!detail) throw new FixtureHttpError(404, "NOT_FOUND", "Symbol not found.");
  return ok(detail);
});

route("GET", "/repositories/:repositoryId/dependency-map", (req) => {
  const repo = repoForRead(req);
  const sha = snapshotSha(req, repo);
  const path = (req.query.get("path") ?? "").replace(/^\/+/, "");
  if (path.split("/").includes(".."))
    throw new FixtureHttpError(400, "BAD_REQUEST", "Invalid path.");
  return ok(dependencyMap(filesForRepository(repo.full_name), sha, path));
});

route("GET", "/repositories/:repositoryId/snapshots", (req) => {
  const repo = repoForRead(req);
  const s = wIndexStatus(req.state, repo, req.now);
  return paginate(s.latest_snapshot ? [{ ...s.latest_snapshot, ...s.coverage }] : [], req.query);
});

/** Knowledge notes whose lines share terms with the question (B-2 keyword fallback). */
function knowledgeHits(state: FixtureState, repositoryId: string, question: string) {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3);
  const hits: W.WCitation[] = [];
  for (const k of state.knowledge.filter((d) => d.repository_id === repositoryId)) {
    const lines = k.content.split("\n");
    const idx = lines.findIndex((l) => {
      const low = l.toLowerCase();
      return terms.filter((t) => low.includes(t)).length >= 2;
    });
    if (idx < 0) continue;
    hits.push({
      source: "knowledge",
      evidence_id: `kn-${k.id.slice(-4)}`,
      path: null,
      start_line: idx + 1,
      end_line: idx + 1,
      commit_sha: null,
      content_hash: k.content_hash,
      symbol: null,
      knowledge_document_id: k.id,
      title: k.title,
      supports: null,
    });
  }
  return hits.slice(0, 2);
}

function saveQuestion(
  req: FixtureRequest,
  repo: Scoped<T.Repository>,
  question: string,
  sha: string,
  answer: W.WQuestionAnswer,
): W.WQuestionAnswer {
  const id = `51000000-0000-4000-8000-${String(++req.state.seq).padStart(12, "0")}`;
  const created_at = iso(req.now);
  req.state.questions.unshift({
    id,
    repository_id: repo.id,
    workspace_id: repo.workspace_id,
    user_id: currentUser(req).id,
    question,
    answer: answer.answer,
    insufficient_evidence: answer.insufficient_evidence,
    citations: answer.citations,
    limitations: answer.limitations,
    provider: answer.provider,
    model: answer.model,
    mode: answer.mode,
    commit_sha: sha,
    created_at,
  });
  return { ...answer, id, created_at };
}

function wQuestion(q: FixtureState["questions"][number]): W.WQuestionHistoryItem {
  const { user_id: _u, workspace_id: _w, ...item } = q;
  void _u;
  void _w;
  return item;
}

function ownQuestion(req: FixtureRequest) {
  const q = req.state.questions.find((x) => x.id === req.params.questionId);
  // Other users' entries (admins included) are indistinguishable from missing ones.
  if (!q || q.user_id !== currentUser(req).id) {
    throw new FixtureHttpError(404, "NOT_FOUND", "Question not found.");
  }
  membership(req, q.workspace_id);
  return q;
}

route("POST", "/repositories/:repositoryId/questions", (req) => {
  strictBody(req, ["question", "snapshot", "mode", "top_k", "filters", "include_knowledge"]);
  const repo = repoForRead(req);
  const sha = requireIndexed(repo);
  const question = str(req.body, "question", { min: 3, max: 2000 });
  const policy = req.state.policies[repo.workspace_id] ?? defaultPolicy();
  const mode = (req.body.mode as T.InferenceMode | undefined) ?? "mock";
  if (!policy.allowed_modes.includes(mode))
    throw new FixtureHttpError(
      403,
      "MODE_NOT_ALLOWED",
      `The ${mode} mode is not allowed by workspace policy.`,
    );
  const includeKnowledge = req.body.include_knowledge !== false;
  const hits = searchFiles(filesForRepository(repo.full_name), question, sha, 4);
  const strong = hits.filter((h) => (h.semantic_score ?? 0) >= 0.6);
  const notes = includeKnowledge ? knowledgeHits(req.state, repo.id, question) : [];
  if (strong.length === 0) {
    return ok(
      saveQuestion(req, repo, question, sha, {
        answer:
          "I couldn't find indexed evidence that answers this question, so I won't guess. Try naming a file, function, or concept that appears in the code.",
        insufficient_evidence: true,
        citations: [],
        limitations: [
          "No retrieved chunk met the relevance threshold.",
          "Answers are only generated from indexed evidence.",
        ],
        provider: null,
        model: null,
        mode,
        prompt_version: "repository_qa.v1",
        data_disclosure: null,
        retrieval: { result_count: hits.length, knowledge_result_count: 0, evidence_included: [] },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          duration_ms: 180,
          schema_repair_attempted: false,
        },
      }),
    );
  }
  req.state.usage.push({
    workspace_id: repo.workspace_id,
    provider: "mock",
    model: "mock-deterministic",
    mode: "mock",
    operation: "repository_qa",
    input_tokens: 900 + strong.length * 450,
    output_tokens: 240,
    cost: 0,
    at: iso(req.now),
    run_id: null,
  });
  const lead = strong[0]!;
  const lines = strong.map(
    (h, i) =>
      `- \`${h.file_path}\` lines ${h.start_line}–${h.end_line}${h.symbol_name ? ` (\`${h.symbol_name}\`)` : ""} [${i + 1}]`,
  );
  const noteLines = notes.map((n, i) => `- Team note “${n.title}” [${strong.length + i + 1}]`);
  const codeCitations: W.WCitation[] = strong.map((h, i) => ({
    source: "code",
    evidence_id: `ev-${i + 1}`,
    path: h.file_path,
    start_line: h.start_line,
    end_line: h.end_line,
    commit_sha: h.commit_sha,
    content_hash: h.content_hash,
    symbol: h.symbol_name ?? null,
    knowledge_document_id: null,
    title: null,
    supports: null,
  }));
  return ok(
    saveQuestion(req, repo, question, sha, {
      answer: `The most relevant logic is in \`${lead.file_path}\`${lead.symbol_name ? `, around \`${lead.symbol_name}\`` : ""} [1]. Related evidence:\n\n${[...lines, ...noteLines].join("\n")}\n\nThis answer was assembled by the mock provider from retrieved snippets; it summarises where the behaviour lives rather than explaining it.`,
      insufficient_evidence: false,
      citations: [...codeCitations, ...notes],
      limitations: repo.full_name.endsWith("ml-pipeline")
        ? ["Notebook files are not indexed and were not searched."]
        : [],
      provider: "mock",
      model: "mock-deterministic",
      mode,
      prompt_version: "repository_qa.v1",
      data_disclosure: null,
      retrieval: {
        result_count: hits.length + 6,
        knowledge_result_count: notes.length,
        evidence_included: [...codeCitations, ...notes].map((c) => c.evidence_id!),
      },
      usage: {
        input_tokens: 900 + strong.length * 450,
        output_tokens: 240,
        duration_ms: 640,
        schema_repair_attempted: false,
      },
    }),
  );
});

route("GET", "/repositories/:repositoryId/questions", (req) => {
  const repo = repoForRead(req);
  const me = currentUser(req).id;
  const items = req.state.questions
    .filter((q) => q.repository_id === repo.id && q.user_id === me)
    .map(wQuestion);
  return paginate(items, req.query);
});

route("GET", "/questions/:questionId", (req) => ok(wQuestion(ownQuestion(req))));

route("DELETE", "/questions/:questionId", (req) => {
  const q = ownQuestion(req);
  req.state.questions = req.state.questions.filter((x) => x.id !== q.id);
  return noContent();
});

route("GET", "/repositories/:repositoryId/knowledge", (req) => {
  const repo = repoForRead(req);
  const items: W.WKnowledge[] = req.state.knowledge
    .filter((k) => k.repository_id === repo.id)
    .map((k) => ({
      id: k.id,
      repository_id: k.repository_id,
      source_type: k.source_type,
      external_id: k.external_id,
      title: k.title,
      content_hash: k.content_hash,
      source_url: k.source_url,
      indexed_at: k.indexed_at,
      created_at: k.created_at,
    }));
  return paginate(items, req.query);
});

route("POST", "/repositories/:repositoryId/knowledge", (req) => {
  strictBody(req, ["source_type", "title", "content", "source_url"]);
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!, "member");
  const title = str(req.body, "title", { min: 3, max: 200 });
  const content = str(req.body, "content", { min: 10, max: 100_000 });
  const source_type = req.body.source_type as T.KnowledgeSourceType;
  if (!["engineering_note", "decision", "architecture"].includes(source_type))
    throw validation("source_type", "is invalid");
  const source_url = typeof req.body.source_url === "string" ? req.body.source_url : null;
  if (source_url && !source_url.startsWith("https://"))
    throw validation("source_url", "must be an https URL");
  const doc = {
    id: nextId(req.state, "41000000"),
    workspace_id: repo.workspace_id,
    repository_id: repo.id,
    source_type,
    external_id: null,
    title,
    content,
    content_hash: contentHash(content),
    source_url,
    indexed_at: null,
    created_at: iso(req.now),
  };
  req.state.knowledge.unshift(doc);
  audit(req, repo.workspace_id, "knowledge.created", "knowledge_document", doc.id);
  const { workspace_id: _w, ...wire } = doc;
  void _w;
  return ok(wire satisfies W.WKnowledge, 201);
});

route("GET", "/knowledge/:documentId", (req) => {
  const { workspace_id: _w, ...doc } = findScoped(req, req.state.knowledge, req.params.documentId!);
  void _w;
  return ok(doc satisfies W.WKnowledge);
});

route("DELETE", "/knowledge/:documentId", (req) => {
  const doc = findScoped(req, req.state.knowledge, req.params.documentId!, "member");
  req.state.knowledge = req.state.knowledge.filter((k) => k.id !== doc.id);
  audit(req, doc.workspace_id, "knowledge.deleted", "knowledge_document", doc.id);
  return noContent();
});

// ── tasks & runs ─────────────────────────────────────────────────────────

/**
 * Simulated GitHub for task imports. PR numbers 1–999 exist; anything larger is outside
 * what the installation can see (the server answers 403 FORBIDDEN). Check runs come from
 * `fixtureCheckRuns`.
 */
const FIXTURE_HIDDEN_FROM = 1000;

function fixtureCheckRuns(repo: { id: string; default_branch: string | null }) {
  const sha = createHashLike(`${repo.id}:${repo.default_branch ?? "main"}`);
  const base = 31_000_000_000 + (parseInt(repo.id.slice(-4), 16) || 0) * 10;
  return [
    {
      id: base + 1,
      name: "test (node 22)",
      conclusion: "failure",
      status: "completed",
      head_sha: sha,
      summary:
        "1 failed, 212 passed. TokenRefresher › retries once on 401 — expected 1 call, got 2.",
      annotations: [
        {
          path: "src/auth/token-refresher.ts",
          start_line: 42,
          end_line: 42,
          level: "failure",
          title: "retries once on 401",
          message: "AssertionError: expected fetch to be called 1 time, but it was called 2 times",
        },
      ],
    },
    {
      id: base + 2,
      name: "typecheck",
      conclusion: "timed_out",
      status: "completed",
      head_sha: sha,
      summary: "The job exceeded the maximum execution time of 10 minutes.",
      annotations: [],
    },
    {
      id: base + 3,
      name: "lint",
      conclusion: "success",
      status: "completed",
      head_sha: sha,
      summary: "No problems found.",
      annotations: [],
    },
  ];
}

const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

/** Deterministic 40-hex pseudo SHA (fixtures only). */
function createHashLike(seed: string): string {
  let h = 2166136261;
  let out = "";
  for (let i = 0; out.length < 40; i++) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

function positiveInt(value: unknown, field: string, message: string): number {
  const n = Number(value);
  if (value === undefined || !Number.isSafeInteger(n) || n < 1) throw validation(field, message);
  return n;
}

route("GET", "/repositories/:repositoryId/failing-checks", (req) => {
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!, "member");
  const ref = req.query.get("ref") ?? repo.default_branch ?? "main";
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes(".."))
    throw validation("ref", "must be a branch name or commit SHA");
  const runs = ref === (repo.default_branch ?? "main") ? fixtureCheckRuns(repo) : [];
  const body: W.WFailingChecks = {
    ref,
    check_runs: runs
      .filter((r) => FAILING_CONCLUSIONS.has(r.conclusion))
      .map((r) => ({
        id: r.id,
        name: r.name,
        conclusion: r.conclusion,
        head_sha: r.head_sha,
        html_url: `https://github.com/${repo.full_name}/runs/${r.id}`,
        completed_at: iso(req.now - 3_600_000),
        app: "github-actions",
      })),
  };
  return ok(body);
});

route("POST", "/repositories/:repositoryId/tasks", (req) => {
  strictBody(req, [
    "source_type",
    "title",
    "description",
    "external_number",
    "check_run_id",
    "include_review_comments",
    "labels",
  ]);
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!, "member");
  const source_type = req.body.source_type as T.TaskSourceType;
  if (!(CREATABLE_TASK_SOURCES as readonly string[]).includes(source_type))
    throw validation("source_type", "must be manual, github_issue, pull_request or failing_check");
  if (source_type !== "failing_check" && req.body.check_run_id !== undefined)
    throw validation("check_run_id", "only accepted for failing_check tasks");
  if (source_type !== "pull_request" && req.body.include_review_comments !== undefined)
    throw validation("include_review_comments", "only accepted for pull_request tasks");
  if (source_type === "failing_check" && req.body.external_number !== undefined)
    throw validation("external_number", "use check_run_id for failing_check tasks");
  let labels = Array.isArray(req.body.labels)
    ? (req.body.labels as unknown[]).filter((l): l is string => typeof l === "string").slice(0, 20)
    : [];
  // Like the server: a caller-supplied title/description wins over the imported one.
  const given = (field: "title" | "description", min: number, max: number) =>
    req.body[field] === undefined ? undefined : str(req.body, field, { min, max });
  let title: string;
  let description: string;
  let external_number: number | null = null;
  let external_id: string | null = null;
  let source_url: string | null = null;
  let source_context: T.TaskSourceContext | null = null;
  if (source_type === "github_issue") {
    if (req.body.title !== undefined || req.body.description !== undefined)
      throw validation("title", "is imported from the GitHub issue and must not be sent");
    external_number = positiveInt(
      req.body.external_number,
      "external_number",
      "required for github_issue tasks",
    );
    title = `Issue #${external_number} in ${repo.full_name}`;
    description = `Imported from GitHub issue #${external_number}. The issue body is treated as untrusted context.`;
    source_url = `https://github.com/${repo.full_name}/issues/${external_number}`;
  } else if (source_type === "pull_request") {
    external_number = positiveInt(
      req.body.external_number,
      "external_number",
      "required for pull_request tasks",
    );
    if (external_number >= FIXTURE_HIDDEN_FROM)
      throw new FixtureHttpError(
        403,
        "FORBIDDEN",
        "The GitHub App installation does not grant access to this resource.",
      );
    const headBranch = `feature/pr-${external_number}`;
    const withComments = req.body.include_review_comments === true;
    title = given("title", 1, 300) ?? `Pull request #${external_number} in ${repo.full_name}`;
    description =
      given("description", 1, 20000) ??
      `Imported from pull request #${external_number}. The PR body is treated as untrusted context.`;
    labels = labels.length > 0 ? labels : ["from-pr"];
    source_url = `https://github.com/${repo.full_name}/pull/${external_number}`;
    source_context = {
      kind: "pull_request",
      state: "open",
      draft: false,
      merged: false,
      head_branch: headBranch,
      head_sha: createHashLike(headBranch),
      base_branch: repo.default_branch ?? "main",
      base_sha: createHashLike(repo.default_branch ?? "main"),
      changed_files: [
        { path: "src/auth/token-refresher.ts", status: "modified", additions: 18, deletions: 6 },
        { path: "src/auth/token-refresher.test.ts", status: "added", additions: 64, deletions: 0 },
      ],
      changed_files_total: 2,
      changed_files_truncated: false,
      review_comments: withComments
        ? [
            {
              path: "src/auth/token-refresher.ts",
              line: 42,
              author: "reviewer",
              body: "This still retries twice when the refresh itself returns 401.",
            },
          ]
        : [],
      review_comments_truncated: false,
    };
  } else if (source_type === "failing_check") {
    const id = positiveInt(
      req.body.check_run_id,
      "check_run_id",
      "required for failing_check tasks",
    );
    const check = fixtureCheckRuns(repo).find((c) => c.id === id);
    if (!check)
      throw new FixtureHttpError(
        403,
        "FORBIDDEN",
        "The GitHub App installation does not grant access to this resource.",
      );
    if (!FAILING_CONCLUSIONS.has(check.conclusion))
      throw new FixtureHttpError(
        422,
        "CHECK_NOT_FAILING",
        "This check run has not failed, so there is no failure to fix.",
        {
          status: check.status,
          conclusion: check.conclusion,
        },
      );
    external_id = String(check.id);
    title = given("title", 1, 300) ?? `Fix failing check: ${check.name}`;
    description = given("description", 1, 20000) ?? check.summary;
    source_url = `https://github.com/${repo.full_name}/runs/${check.id}`;
    source_context = {
      kind: "failing_check",
      check_name: check.name,
      app: "github-actions",
      conclusion: check.conclusion,
      head_sha: check.head_sha,
      started_at: iso(req.now - 3_900_000),
      completed_at: iso(req.now - 3_600_000),
      pull_request_numbers: [],
      output_title: check.conclusion === "failure" ? "1 test failed" : "Timed out",
      annotations: check.annotations,
      annotations_total: check.annotations.length,
      annotations_truncated: false,
    };
  } else {
    title = str(req.body, "title", { min: 4, max: 200 });
    description = str(req.body, "description", { min: 10, max: 10000 });
  }
  const at = iso(req.now);
  const task: Scoped<T.EngineeringTask> = {
    id: nextId(req.state, "81000000"),
    workspace_id: repo.workspace_id,
    repository_id: repo.id,
    created_by: req.state.session_user_id!,
    source_type,
    external_number,
    external_id,
    source_url,
    source_context,
    title,
    description,
    status: "open",
    labels,
    created_at: at,
    updated_at: at,
  };
  req.state.tasks.unshift(task);
  audit(req, repo.workspace_id, "task.created", "engineering_task", task.id);
  return ok(wTask(req.state, task), 201);
});

route("GET", "/tasks", (req) => {
  const wsId = scope(req);
  const status = req.query.get("status");
  const repoId = req.query.get("repository_id");
  const items = req.state.tasks
    .filter((t) => t.workspace_id === wsId)
    .filter((t) => !status || t.status === status)
    .filter((t) => !repoId || t.repository_id === repoId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((t) => wTask(req.state, t));
  return paginate(items, req.query);
});

route("GET", "/tasks/:taskId", (req) =>
  ok(wTask(req.state, findScoped(req, req.state.tasks, req.params.taskId!))),
);

route("PATCH", "/tasks/:taskId", (req) => {
  strictBody(req, ["title", "description", "labels", "status"]);
  const task = findScoped(req, req.state.tasks, req.params.taskId!, "member");
  if (req.body.status !== undefined && task.status === "active") {
    throw new FixtureHttpError(
      409,
      "INVALID_STATE_TRANSITION",
      "A task with an active run cannot be archived or reopened.",
    );
  }
  if (req.body.title !== undefined) task.title = str(req.body, "title", { min: 4, max: 200 });
  if (req.body.description !== undefined)
    task.description = str(req.body, "description", { min: 10, max: 10000 });
  if (Array.isArray(req.body.labels))
    task.labels = (req.body.labels as unknown[])
      .filter((l): l is string => typeof l === "string")
      .slice(0, 20);
  if (req.body.status === "archived" || req.body.status === "open") task.status = req.body.status;
  task.updated_at = iso(req.now);
  return ok(wTask(req.state, task));
});

route("POST", "/tasks/:taskId/runs", (req) => {
  strictBody(req, ["mode", "base_branch", "budgets"]);
  const task = findScoped(req, req.state.tasks, req.params.taskId!, "member");
  const repo = req.state.repositories.find((r) => r.id === task.repository_id)!;
  if (!repo.latest_indexed_commit_sha)
    throw new FixtureHttpError(
      409,
      "REPOSITORY_NOT_INDEXED",
      "Index the repository before starting a run.",
    );
  const active = req.state.runs.find(
    (r) => r.task_id === task.id && (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status),
  );
  if (active)
    throw new FixtureHttpError(409, "RUN_ALREADY_ACTIVE", "This task already has an active run.", {
      run_id: active.id,
    });
  const policy = req.state.policies[task.workspace_id] ?? defaultPolicy();
  const mode = (req.body.mode as T.InferenceMode | undefined) ?? policy.default_mode;
  if (!policy.allowed_modes.includes(mode)) {
    throw new FixtureHttpError(
      403,
      "MODE_NOT_ALLOWED",
      `The ${mode} mode is not allowed by workspace policy. No other provider was used.`,
    );
  }
  assertCanStartRun(req, task.workspace_id);
  const base_branch =
    typeof req.body.base_branch === "string" && req.body.base_branch.trim()
      ? req.body.base_branch.trim()
      : (repo.default_branch ?? "main");
  const run = createRun(
    req.state,
    task,
    { mode, base_branch, budgets: req.body.budgets as Partial<T.RunBudgets> },
    req.now,
  );
  audit(req, task.workspace_id, "run.started", "workflow_run", run.id, { mode });
  return ok(wRunCore(req.state, run), 202);
});

route("GET", "/tasks/:taskId/runs", (req) => {
  const task = findScoped(req, req.state.tasks, req.params.taskId!);
  return paginate(
    req.state.runs
      .filter((r) => r.task_id === task.id)
      .sort((a, b) => b.run_number - a.run_number)
      .map((r) => wRunCore(req.state, r)),
    req.query,
  );
});

route("GET", "/runs", (req) => {
  const wsId = scope(req);
  const statuses = req.query.getAll("status");
  const known = new Set<string>([...ACTIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES]);
  const bad = statuses.find((s) => !known.has(s));
  if (bad) throw validation("status", `has an unknown value "${bad}"`);
  const repoId = req.query.get("repository_id");
  const taskId = req.query.get("task_id");
  const items: W.WRunListItem[] = req.state.runs
    .filter((r) => r.workspace_id === wsId)
    .filter((r) => !statuses.length || statuses.includes(r.status))
    .filter((r) => !taskId || r.task_id === taskId)
    .map((r) => {
      const task = req.state.tasks.find((t) => t.id === r.task_id)!;
      const repo = req.state.repositories.find((x) => x.id === task.repository_id)!;
      return {
        ...wRunCore(req.state, r),
        task_title: task.title,
        repository_full_name: repo.full_name,
      };
    })
    .filter((r) => !repoId || r.repository_id === repoId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return paginate(items, req.query);
});

route("GET", "/runs/:runId", (req) => ok(wRunDetail(req.state, getRun(req))));
route("GET", "/runs/:runId/steps", (req) => ok(getRun(req).steps.map(wStep)));

route("GET", "/runs/:runId/artifacts", (req) => {
  const run = getRun(req);
  return ok({
    patches: run.diff
      ? [
          {
            id: run.diff.patch_id ?? `${run.id}-patch`,
            patch_hash: run.diff.patch_hash,
            byte_size: run.diff.unified_diff.length,
            created_at: run.updated_at,
            download_url: null,
          },
        ]
      : [],
    verification_logs: (run.verification?.results ?? [])
      .filter((v) => v.status !== "skipped")
      .map((v) => ({
        id: `${v.id}-log`,
        profile_id: v.profile_id,
        name: `${v.profile_id}.log`,
        byte_size: (v.output_excerpt ?? "").length,
        created_at: v.created_at ?? run.updated_at,
        download_url: null,
      })),
  } satisfies W.WArtifacts);
});

route("POST", "/runs/:runId/cancel", (req) => {
  strictBody(req, ["reason"]);
  const run = getRun(req, "member");
  requireStatus(
    run,
    [...ACTIVE_RUN_STATUSES].filter((s) => s !== "creating_pr"),
    "cancel",
  );
  finish(
    req.state,
    run,
    "cancelled",
    req.now,
    "CANCELLED_BY_USER",
    typeof req.body.reason === "string" ? req.body.reason : "Cancelled by a workspace member.",
  );
  audit(req, run.workspace_id, "run.cancelled", "workflow_run", run.id);
  return ok(wRunCore(req.state, run));
});

route("POST", "/runs/:runId/retry", (req) => {
  strictBody(req, []);
  const run = getRun(req, "member");
  requireStatus(run, ["failed", "cancelled", "timed_out"], "retry");
  const task = req.state.tasks.find((t) => t.id === run.task_id)!;
  if (
    req.state.runs.some(
      (r) => r.task_id === task.id && (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status),
    )
  ) {
    throw new FixtureHttpError(409, "RUN_ALREADY_ACTIVE", "This task already has an active run.");
  }
  assertCanStartRun(req, task.workspace_id);
  const next = createRun(
    req.state,
    task,
    { mode: run.mode, base_branch: run.base_branch ?? "main", budgets: run.budget },
    req.now,
  );
  next.retry_of_run_id = run.id;
  audit(req, run.workspace_id, "run.retried", "workflow_run", next.id, { previous_run_id: run.id });
  return ok(wRunCore(req.state, next), 202);
});

route("GET", "/runs/:runId/plan", (req) => {
  const run = getRun(req);
  if (!run.plan)
    throw new FixtureHttpError(404, "NOT_FOUND", "The plan has not been proposed yet.");
  return ok(wPlan(run));
});

route("PATCH", "/runs/:runId/plan", (req) => {
  strictBody(req, ["plan", "base_plan_hash"]);
  const run = getRun(req, "member");
  requireStatus(run, ["awaiting_plan_approval"], "edit the plan");
  const current = run.plan!;
  if (req.body.base_plan_hash !== current.plan_hash) {
    throw new FixtureHttpError(
      409,
      "PLAN_CHANGED",
      "The plan changed since you loaded it. Reload and re-apply your edits.",
    );
  }
  const plan = req.body.plan as T.EngineeringPlan | undefined;
  if (!plan || typeof plan.objective !== "string" || plan.objective.trim().length < 5)
    throw validation("plan.objective", "must be at least 5 characters");
  if (!Array.isArray(plan.steps) || plan.steps.length === 0)
    throw validation("plan.steps", "must contain at least one step");
  const allFiles = [...plan.files_to_modify, ...plan.steps.flatMap((s) => s.files)];
  if (allFiles.some((f) => f.startsWith("/") || f.split("/").includes("..") || /[*?[]/.test(f))) {
    throw validation("plan.files_to_modify", "must be relative paths without '..' or globs");
  }
  if (
    plan.files_to_modify.length >
    (run.budget.max_changed_files ?? DEFAULT_BUDGETS.max_changed_files)
  ) {
    throw validation(
      "plan.files_to_modify",
      `cannot exceed the run's ${run.budget.max_changed_files} changed-file budget`,
    );
  }
  run.plan = {
    ...current,
    plan,
    plan_hash: contentHash(JSON.stringify(plan)),
    version: current.version + 1,
    state: "edited",
    source: "user_edit",
    updated_at: iso(req.now),
  };
  run.events.push({
    id: `evt_${run.run_number}_${run.events.length + 1}_${run.id.slice(-6)}`,
    type: "approval.required",
    payload: {
      run_id: run.id,
      timestamp: iso(req.now),
      approval_type: "plan",
      plan_hash: run.plan.plan_hash,
      plan_version: run.plan.version,
      reason: "plan edited",
    },
  });
  audit(req, run.workspace_id, "plan.edited", "workflow_run", run.id, {
    version: run.plan.version,
  });
  const full = wPlan(run);
  return ok({
    run_id: full.run_id,
    version: full.version,
    plan_hash: full.plan_hash,
    source: full.source,
    plan: full.plan,
  } satisfies W.WPlanRevision);
});

route("POST", "/runs/:runId/plan-approval", (req) => {
  strictBody(req, ["decision", "comment", "plan_hash"]);
  const run = getRun(req, "member");
  requireStatus(run, ["awaiting_plan_approval"], "decide on the plan");
  const decision = req.body.decision;
  if (decision !== "approved" && decision !== "rejected")
    throw validation("decision", "must be approved or rejected");
  const comment =
    typeof req.body.comment === "string" && req.body.comment.trim()
      ? req.body.comment.trim().slice(0, 2000)
      : null;
  if (decision === "approved") {
    if (typeof req.body.plan_hash !== "string")
      throw validation("plan_hash", "is required to approve");
    if (req.body.plan_hash !== run.plan!.plan_hash) {
      throw new FixtureHttpError(
        409,
        "PLAN_CHANGED",
        "The plan changed since you reviewed it. Review the latest version before approving.",
      );
    }
  }
  const user = currentUser(req);
  const approval: T.Approval = {
    id: nextId(req.state, "61000000"),
    approval_type: "plan",
    decision,
    comment,
    user_id: user.id,
    subject_hash: run.plan!.plan_hash,
    created_at: iso(req.now),
  };
  run.approvals.push(approval);
  run.plan = { ...run.plan!, state: decision, approval };
  audit(req, run.workspace_id, `plan.${decision}`, "workflow_run", run.id, {
    plan_hash: run.plan.plan_hash,
  });
  if (decision === "rejected")
    finish(req.state, run, "rejected", req.now, "PLAN_REJECTED", comment ?? undefined);
  else schedule(run, PHASE_TWO, req.now);
  return ok(
    {
      id: approval.id,
      approval_type: "plan",
      decision,
      subject_hash: approval.subject_hash,
      comment,
      user_id: user.id,
      created_at: approval.created_at,
    },
    201,
  );
});

route("GET", "/runs/:runId/diff", (req) => {
  const run = getRun(req);
  if (!run.diff) throw new FixtureHttpError(404, "NOT_FOUND", "No patch has been proposed yet.");
  return ok(wDiff(run.diff));
});

route("GET", "/runs/:runId/verification", (req) => {
  const run = getRun(req);
  if (!run.verification)
    throw new FixtureHttpError(404, "NOT_FOUND", "Verification has not run yet.");
  return ok(wVerification(run.verification, run.diff?.patch_id ?? null));
});

route("GET", "/runs/:runId/review", (req) => {
  const run = getRun(req);
  if (!run.review) throw new FixtureHttpError(404, "NOT_FOUND", "Review has not run yet.");
  return ok({
    summary: run.review.summary ?? null,
    deterministic_findings: run.review.findings
      .filter((f) => f.source !== "ai_review")
      .map(wFinding),
    ai_findings: run.review.findings.filter((f) => f.source === "ai_review").map(wFinding),
  } satisfies W.WReview);
});

route("POST", "/runs/:runId/findings/:findingId/disposition", (req) => {
  strictBody(req, ["status", "comment"]);
  const run = getRun(req, "member");
  const finding = run.review?.findings.find((f) => f.id === req.params.findingId);
  if (!finding) throw new FixtureHttpError(404, "NOT_FOUND", "Finding not found.");
  if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
    throw new FixtureHttpError(
      409,
      "INVALID_STATE_TRANSITION",
      "Findings on a finished run can't be changed.",
    );
  }
  const status = req.body.status as T.FindingStatus;
  if (!["accepted", "dismissed", "fixed"].includes(status))
    throw validation("status", "must be accepted, dismissed, or fixed");
  if (status === "dismissed" && !(typeof req.body.comment === "string" && req.body.comment.trim()))
    throw validation("comment", "is required when dismissing a finding");
  finding.status = status;
  audit(req, run.workspace_id, `finding.${status}`, "review_finding", finding.id, {
    severity: finding.severity,
    source: finding.source,
  });
  return ok({
    id: finding.id,
    status,
    disposition_by: currentUser(req).id,
    disposition_comment: typeof req.body.comment === "string" ? req.body.comment : null,
    disposition_at: iso(req.now),
  } satisfies W.WFindingDisposition);
});

route("POST", "/runs/:runId/pr-approval", (req) => {
  strictBody(req, ["decision", "comment", "patch_hash"]);
  const run = getRun(req, "member");
  requireStatus(run, ["awaiting_pr_approval"], "decide on the pull request");
  if (run.pr_approved)
    throw new FixtureHttpError(
      409,
      "ALREADY_APPROVED",
      "Pull-request creation was already approved.",
    );
  const decision = req.body.decision;
  if (decision !== "approved" && decision !== "rejected")
    throw validation("decision", "must be approved or rejected");
  if (decision === "approved") {
    if (typeof req.body.patch_hash !== "string")
      throw validation("patch_hash", "is required to approve");
    if (req.body.patch_hash !== run.diff?.patch_hash)
      throw new FixtureHttpError(409, "PATCH_CHANGED", "The patch changed since you reviewed it.");
    const blocking =
      run.review?.findings.filter(
        (f) => f.status === "open" && (f.severity === "critical" || f.severity === "high"),
      ) ?? [];
    if (blocking.length) {
      throw new FixtureHttpError(
        409,
        "BLOCKING_FINDINGS",
        `Resolve ${blocking.length} open high-severity finding(s) before approving.`,
        { finding_ids: blocking.map((f) => f.id) },
      );
    }
  }
  const comment =
    typeof req.body.comment === "string" && req.body.comment.trim()
      ? req.body.comment.trim().slice(0, 2000)
      : null;
  const user = currentUser(req);
  const approval: T.Approval = {
    id: nextId(req.state, "62000000"),
    approval_type: "pull_request",
    decision,
    comment,
    user_id: user.id,
    subject_hash: run.diff?.patch_hash ?? null,
    created_at: iso(req.now),
  };
  run.approvals.push(approval);
  audit(req, run.workspace_id, `pull_request.${decision}`, "workflow_run", run.id, {
    patch_hash: run.diff?.patch_hash,
  });
  if (decision === "approved") run.pr_approved = true;
  else finish(req.state, run, "completed_without_pr", req.now);
  return ok(
    {
      id: approval.id,
      approval_type: "pull_request",
      decision,
      subject_hash: approval.subject_hash,
      comment,
      user_id: user.id,
      created_at: approval.created_at,
    },
    201,
  );
});

route("POST", "/runs/:runId/pull-request", (req) => {
  strictBody(req, ["title", "body", "base_branch"]);
  if (!req.headers["Idempotency-Key"])
    throw new FixtureHttpError(
      422,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Send an Idempotency-Key header to create a pull request.",
    );
  const run = getRun(req, "member");
  if (run.pull_request)
    throw new FixtureHttpError(
      409,
      "PULL_REQUEST_EXISTS",
      "A pull request already exists for this run.",
    );
  requireStatus(run, ["awaiting_pr_approval"], "create a pull request");
  if (!run.pr_approved)
    throw new FixtureHttpError(
      403,
      "APPROVAL_REQUIRED",
      "An authorized approval of the current patch is required before creating a pull request.",
    );
  const title = str(req.body, "title", { min: 5, max: 256 });
  const base_branch =
    typeof req.body.base_branch === "string" && req.body.base_branch.trim()
      ? req.body.base_branch.trim()
      : (run.base_branch ?? "main");
  const task = req.state.tasks.find((t) => t.id === run.task_id)!;
  const repo = req.state.repositories.find((r) => r.id === task.repository_id)!;
  const number = 480 + req.state.runs.filter((r) => r.pull_request).length + 2;
  const at = iso(req.now);
  const pr: T.PullRequest = {
    id: nextId(req.state, "63000000"),
    pr_number: number,
    pr_url: `https://github.com/${repo.full_name}/pull/${number}`,
    head_branch: `anvaya/run-${run.id.slice(-6)}-${title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 30)
      .replace(/-$/, "")}`,
    base_branch,
    created_at: at,
  };
  run.pull_request = pr;
  run.status = "creating_pr";
  run.current_stage = "pull_request";
  run.state_version += 1;
  const push = (type: T.RunEventType, extra: Record<string, unknown>) =>
    run.events.push({
      id: `evt_${run.run_number}_${run.events.length + 1}_${run.id.slice(-6)}`,
      type,
      payload: { run_id: run.id, timestamp: at, ...extra },
    });
  push("run.status.changed", {
    from: "awaiting_pr_approval",
    status: "creating_pr",
    state_version: run.state_version,
  });
  push("pull_request.created", {
    pr_number: number,
    pr_url: pr.pr_url,
    head_branch: pr.head_branch,
  });
  run.schedule = [{ status: "completed", at: req.now + Math.min(600, stageDurationMs()) }];
  audit(req, run.workspace_id, "pull_request.created", "workflow_run", run.id, {
    pr_number: number,
    title,
  });
  return ok(
    {
      id: pr.id,
      pr_number: pr.pr_number,
      pr_url: pr.pr_url,
      head_branch: pr.head_branch,
      base_branch: pr.base_branch,
      created_at: at,
    } satisfies W.WPullRequest,
    201,
  );
});

export { tick };
