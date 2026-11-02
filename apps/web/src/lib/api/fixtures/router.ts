/**
 * DEVELOPMENT FIXTURE — route handlers emulating API_SPEC.md semantics.
 */
import type * as T from "../types";
import { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES } from "../types";
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
import { filesForRepository } from "./repo-content";
import { defaultPolicy, type FixtureRun, type FixtureState, type Scoped } from "./state";

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
  // 404 rather than 403 conceals existence of other tenants' workspaces (API_SPEC §9).
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

/** GAP-02: tenant scope for collection endpoints comes from X-Workspace-Id. */
function scope(req: FixtureRequest, min: T.WorkspaceRole = "viewer") {
  const id = req.headers["X-Workspace-Id"];
  if (!id) throw new FixtureHttpError(400, "WORKSPACE_REQUIRED", "Select a workspace first.");
  requireRole(req, id, min);
  return id;
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

function strip<X extends { workspace_id: string }>(item: X): Omit<X, "workspace_id"> {
  const { workspace_id: _ignored, ...rest } = item;
  void _ignored;
  return rest;
}

function str(
  body: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; optional?: boolean } = {},
): string {
  const v = body[key];
  if (v === undefined && opts.optional) return "";
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
    fields: { [field]: `${field.replace(/_/g, " ")} ${msg}` },
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
    actor_display: user?.display_name ?? null,
    actor_type: user ? "user" : "system",
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    request_id: req.headers["X-Request-Id"] ?? null,
    metadata_redacted: metadata,
    created_at: new Date(req.now).toISOString(),
  });
}

function paginate<X>(items: X[], query: URLSearchParams): FixtureResult {
  const limit = Math.min(Number(query.get("limit") ?? 25) || 25, 100);
  const offset = Number(query.get("cursor") ?? 0) || 0;
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? String(offset + limit) : null;
  return ok(page, 200, { next_cursor: next });
}

function workspaceView(req: FixtureRequest, ws: FixtureState["workspaces"][number]): T.Workspace {
  return { ...ws, role: membership(req, ws.id).role };
}

function taskView(state: FixtureState, task: Scoped<T.EngineeringTask>): T.EngineeringTask {
  const repo = state.repositories.find((r) => r.id === task.repository_id);
  const runs = state.runs
    .filter((r) => r.task_id === task.id)
    .sort((a, b) => b.run_number - a.run_number);
  return {
    ...strip(task),
    repository_full_name: repo?.full_name,
    latest_run: runs[0] ? runSummary(runs[0]) : null,
  };
}

function runSummary(run: FixtureRun): T.RunSummary {
  return {
    id: run.id,
    task_id: run.task_id,
    run_number: run.run_number,
    status: run.status,
    current_stage: run.current_stage,
    mode: run.mode,
    created_at: run.created_at,
    updated_at: run.updated_at,
  };
}

function runView(state: FixtureState, run: FixtureRun): T.WorkflowRun {
  const task = state.tasks.find((t) => t.id === run.task_id)!;
  const repo = state.repositories.find((r) => r.id === task.repository_id);
  return {
    ...runSummary(run),
    provider: run.provider,
    model: run.model,
    state_version: run.state_version,
    budget: run.budget,
    usage_summary: run.usage_summary,
    started_at: run.started_at,
    ended_at: run.ended_at,
    error_code: run.error_code,
    error_summary: run.error_summary,
    base_branch: run.base_branch,
    pull_request: run.pull_request,
    approvals: run.approvals,
    task: {
      id: task.id,
      title: task.title,
      repository_id: task.repository_id,
      repository_full_name: repo?.full_name,
    },
  };
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

function indexStatus(state: FixtureState, repo: Scoped<T.Repository>, now: number): T.IndexStatus {
  const files = filesForRepository(repo.full_name);
  const job = state.index_jobs[repo.id];
  let progress: T.IndexStatus["progress"] = null;
  if (job) {
    const ratio = (now - job.started_at) / job.duration_ms;
    if (ratio >= 1) {
      repo.indexing_status = repo.full_name.endsWith("ml-pipeline") ? "partial" : "ready";
      repo.latest_indexed_commit_sha = job.commit_sha;
      repo.indexed_at = new Date(job.started_at + job.duration_ms).toISOString();
      delete state.index_jobs[repo.id];
    } else {
      repo.indexing_status = ratio < 0.12 ? "queued" : "indexing";
      const phases = [
        "Fetching snapshot",
        "Classifying files",
        "Parsing syntax trees",
        "Chunking",
        "Embedding",
      ];
      progress = {
        phase: phases[Math.min(phases.length - 1, Math.floor(ratio * phases.length))]!,
        processed_files: Math.floor(files.length * ratio),
        total_files: files.length,
      };
    }
  }
  const included = files.filter((f) => !f.excluded);
  const langs = new Map<string, T.LanguageCoverage>();
  for (const f of files) {
    if (!f.language) continue;
    const entry = langs.get(f.language) ?? {
      language: f.language,
      files: 0,
      indexed_files: 0,
      parser_supported: ["typescript", "javascript", "python"].includes(f.language),
    };
    entry.files++;
    if (!f.excluded) entry.indexed_files++;
    langs.set(f.language, entry);
  }
  const exclusions = new Map<string, number>();
  for (const f of files)
    if (f.excluded) exclusions.set(f.excluded, (exclusions.get(f.excluded) ?? 0) + 1);
  const ready = repo.indexing_status === "ready" || repo.indexing_status === "partial";
  const sha = job?.commit_sha ?? repo.latest_indexed_commit_sha;
  return {
    repository_id: repo.id,
    indexing_status: repo.indexing_status,
    snapshot: sha
      ? {
          id: `snap-${sha.slice(0, 8)}`,
          commit_sha: sha,
          branch_name: repo.default_branch,
          total_files: files.length,
          indexed_files: ready ? included.length : Math.floor(included.length * 0.5),
          excluded_files: files.length - included.length,
          status: ready ? (repo.indexing_status === "partial" ? "partial" : "ready") : "processing",
          parser_version: "tree-sitter@0.25/anvaya-1",
          chunker_version: "lines-v2",
          created_at: repo.indexed_at ?? new Date(now).toISOString(),
        }
      : null,
    progress,
    languages: [...langs.values()].sort((a, b) => b.files - a.files),
    exclusions: [...exclusions.entries()].map(([reason, count]) => ({ reason, files: count })),
    limitations: repo.full_name.endsWith("ml-pipeline")
      ? [
          "Jupyter notebooks are not parsed; notebook cells are excluded from retrieval.",
          "Python call relationships are not extracted yet.",
        ]
      : ["Symbol relationships across package boundaries are not extracted yet."],
    errors: repo.full_name.endsWith("ml-pipeline")
      ? [{ path: "notebooks/exploration.ipynb", message: "Unsupported language: jupyter" }]
      : [],
    embedding_model: "nomic-embed-text@v1.5",
  };
}

function treeOf(fullName: string): T.TreeEntry[] {
  const root: T.TreeEntry[] = [];
  for (const f of filesForRepository(fullName)) {
    const parts = f.path.split("/");
    let level = root;
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;
      let entry = level.find((e) => e.name === name);
      if (!entry) {
        entry = isFile
          ? {
              path,
              name,
              type: "file",
              language: f.language,
              byte_size: f.content.length,
              is_excluded: !!f.excluded,
              exclusion_reason: f.excluded ?? null,
            }
          : { path, name, type: "directory", children: [] };
        level.push(entry);
      }
      if (!isFile) level = entry.children!;
    });
  }
  const sort = (entries: T.TreeEntry[]) => {
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
    );
    entries.forEach((e) => e.children && sort(e.children));
  };
  sort(root);
  return root;
}

function repoForRead(req: FixtureRequest) {
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!);
  indexStatus(req.state, repo, req.now);
  return repo;
}

function requireIndexed(repo: Scoped<T.Repository>) {
  if (!repo.latest_indexed_commit_sha) {
    throw new FixtureHttpError(
      409,
      "REPOSITORY_NOT_INDEXED",
      "This repository has not finished indexing yet.",
    );
  }
  return repo.latest_indexed_commit_sha;
}

// ── identity & workspaces ───────────────────────────────────────────────

route("POST", "/auth/logout", (req) => {
  req.state.session_user_id = null;
  return noContent();
});

route("GET", "/me", (req) => {
  const user = currentUser(req);
  return ok({
    user,
    memberships: req.state.memberships
      .filter((m) => m.user_id === user.id)
      .map((m) => ({ workspace_id: m.workspace_id, role: m.role })),
  } satisfies T.Me);
});

route("GET", "/workspaces", (req) => {
  const user = currentUser(req);
  const ids = req.state.memberships.filter((m) => m.user_id === user.id).map((m) => m.workspace_id);
  return ok(
    req.state.workspaces.filter((w) => ids.includes(w.id)).map((w) => workspaceView(req, w)),
  );
});

route("POST", "/workspaces", (req) => {
  const user = currentUser(req);
  const name = str(req.body, "name", { min: 2, max: 64 });
  const slug = str(req.body, "slug", { min: 2, max: 40 });
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug))
    throw validation("slug", "may contain lowercase letters, numbers, and hyphens");
  if (req.state.workspaces.some((w) => w.slug === slug)) {
    throw new FixtureHttpError(409, "SLUG_TAKEN", "That workspace URL is already taken.", {
      fields: { slug: "This URL is already taken" },
    });
  }
  const iso = new Date(req.now).toISOString();
  const ws = {
    id: nextId(req.state, "11000000"),
    name,
    slug,
    plan_key: "personal",
    created_at: iso,
  };
  req.state.workspaces.push(ws);
  req.state.memberships.push({
    workspace_id: ws.id,
    user_id: user.id,
    role: "owner",
    created_at: iso,
  });
  req.state.policies[ws.id] = defaultPolicy();
  audit(req, ws.id, "workspace.created", "workspace", ws.id);
  return ok(workspaceView(req, ws), 201);
});

route("GET", "/workspaces/:workspaceId", (req) => {
  const ws = req.state.workspaces.find((w) => w.id === req.params.workspaceId);
  if (!ws) throw new FixtureHttpError(404, "NOT_FOUND", "Workspace not found.");
  return ok(workspaceView(req, ws));
});

route("PATCH", "/workspaces/:workspaceId", (req) => {
  requireRole(req, req.params.workspaceId!, "admin");
  const ws = req.state.workspaces.find((w) => w.id === req.params.workspaceId)!;
  if (req.body.name !== undefined) ws.name = str(req.body, "name", { min: 2, max: 64 });
  audit(req, ws.id, "workspace.updated", "workspace", ws.id, { fields: Object.keys(req.body) });
  return ok(workspaceView(req, ws));
});

route("GET", "/workspaces/:workspaceId/members", (req) => {
  membership(req, req.params.workspaceId!);
  const members: T.Member[] = req.state.memberships
    .filter((m) => m.workspace_id === req.params.workspaceId)
    .map((m) => ({
      user: req.state.users.find((u) => u.id === m.user_id)!,
      role: m.role,
      created_at: m.created_at,
    }));
  return ok(members);
});

route("POST", "/workspaces/:workspaceId/invitations", (req) => {
  const wsId = req.params.workspaceId!;
  requireRole(req, wsId, "admin");
  const email = str(req.body, "email", { max: 254 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw validation("email", "must be a valid email address");
  const role = req.body.role as T.WorkspaceRole;
  if (!["admin", "member", "viewer"].includes(role))
    throw validation("role", "must be admin, member, or viewer");
  const existing = req.state.memberships.some(
    (m) =>
      m.workspace_id === wsId && req.state.users.find((u) => u.id === m.user_id)?.email === email,
  );
  if (existing)
    throw new FixtureHttpError(409, "ALREADY_MEMBER", "This person is already a member.", {
      fields: { email: "Already a member" },
    });
  const inv = {
    id: nextId(req.state, "12000000"),
    workspace_id: wsId,
    email,
    role,
    created_at: new Date(req.now).toISOString(),
  };
  req.state.invitations.push(inv);
  audit(req, wsId, "membership.invited", "invitation", inv.id, { role });
  return ok(strip(inv), 201);
});

route("PATCH", "/workspaces/:workspaceId/members/:userId", (req) => {
  const wsId = req.params.workspaceId!;
  const actor = requireRole(req, wsId, "admin");
  const target = req.state.memberships.find(
    (m) => m.workspace_id === wsId && m.user_id === req.params.userId,
  );
  if (!target) throw new FixtureHttpError(404, "NOT_FOUND", "Member not found.");
  const role = req.body.role as T.WorkspaceRole;
  if (!["owner", "admin", "member", "viewer"].includes(role))
    throw validation("role", "is invalid");
  if (target.role === "owner" && actor.role !== "owner")
    throw new FixtureHttpError(403, "FORBIDDEN", "Only owners can change an owner's role.");
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
  return ok({
    user: req.state.users.find((u) => u.id === target.user_id)!,
    role,
    created_at: target.created_at,
  });
});

route("DELETE", "/workspaces/:workspaceId/members/:userId", (req) => {
  const wsId = req.params.workspaceId!;
  requireRole(req, wsId, "admin");
  const idx = req.state.memberships.findIndex(
    (m) => m.workspace_id === wsId && m.user_id === req.params.userId,
  );
  if (idx < 0) throw new FixtureHttpError(404, "NOT_FOUND", "Member not found.");
  if (req.state.memberships[idx]!.role === "owner")
    throw new FixtureHttpError(
      409,
      "LAST_OWNER",
      "Owners cannot be removed. Transfer ownership first.",
    );
  req.state.memberships.splice(idx, 1);
  audit(req, wsId, "membership.removed", "membership", req.params.userId!);
  return noContent();
});

route("GET", "/workspaces/:workspaceId/ai-policy", (req) => {
  membership(req, req.params.workspaceId!);
  return ok(req.state.policies[req.params.workspaceId!] ?? defaultPolicy());
});

route("PATCH", "/workspaces/:workspaceId/ai-policy", (req) => {
  const wsId = req.params.workspaceId!;
  requireRole(req, wsId, "admin");
  const policy = (req.state.policies[wsId] ??= defaultPolicy());
  const body = req.body as T.UpdateAiPolicyRequest;
  if (body.cloud_inference_enabled !== undefined) {
    policy.cloud_inference_enabled = body.cloud_inference_enabled;
    policy.cloud_provider = body.cloud_inference_enabled
      ? { name: "hosted-provider", model: "hosted-large" }
      : null;
    policy.allowed_providers = body.cloud_inference_enabled
      ? ["ollama", "hosted-provider"]
      : ["ollama"];
    if (!body.cloud_inference_enabled && policy.default_mode === "cloud")
      policy.default_mode = "local";
  }
  if (body.default_mode !== undefined) {
    if (body.default_mode === "cloud" && !policy.cloud_inference_enabled) {
      throw new FixtureHttpError(
        422,
        "CLOUD_INFERENCE_DISABLED",
        "Enable cloud inference before making it the default.",
        {
          fields: { default_mode: "Cloud inference is disabled for this workspace" },
        },
      );
    }
    policy.default_mode = body.default_mode;
  }
  if (body.budgets) policy.budgets = { ...policy.budgets, ...body.budgets };
  if (body.monthly_budget_microunits !== undefined)
    policy.monthly_budget_microunits = body.monthly_budget_microunits;
  policy.updated_at = new Date(req.now).toISOString();
  policy.updated_by = req.state.session_user_id;
  audit(req, wsId, "ai_policy.updated", "ai_policy", wsId, {
    fields: Object.keys(body),
    data_handling: policy.cloud_inference_enabled ? "cloud_opt_in" : "local_only",
  });
  return ok(policy);
});

route("POST", "/ai/providers/health-check", (req) => {
  const wsId = scope(req);
  const policy = req.state.policies[wsId] ?? defaultPolicy();
  const mode = (req.body.mode as T.InferenceMode) ?? "local";
  if (mode === "cloud" && !policy.cloud_inference_enabled) {
    throw new FixtureHttpError(
      403,
      "PROVIDER_NOT_PERMITTED",
      "Cloud inference is not enabled by workspace policy.",
    );
  }
  return ok({
    provider:
      mode === "cloud"
        ? (policy.cloud_provider?.name ?? "hosted")
        : mode === "mock"
          ? "mock"
          : policy.local_provider.name,
    model:
      mode === "cloud"
        ? (policy.cloud_provider?.model ?? "")
        : mode === "mock"
          ? "mock-deterministic"
          : policy.local_provider.model,
    mode,
    status: "healthy",
    latency_ms: mode === "local" ? 184 : 42,
    message: mode === "local" ? "1 model loaded · 1 concurrent request" : null,
    checked_at: new Date(req.now).toISOString(),
  } satisfies T.ProviderHealth);
});

route("GET", "/workspaces/:workspaceId/usage", (req) => {
  const wsId = req.params.workspaceId!;
  membership(req, wsId);
  const records = req.state.usage.filter((u) => u.workspace_id === wsId);
  const byKey = new Map<string, T.UsageSummary["by_provider"][number]>();
  for (const r of records) {
    const key = `${r.provider}|${r.model}|${r.mode}`;
    const e = byKey.get(key) ?? {
      provider: r.provider,
      model: r.model,
      mode: r.mode,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_microunits: 0,
      requests: 0,
    };
    e.input_tokens += r.input_tokens;
    e.output_tokens += r.output_tokens;
    e.estimated_cost_microunits += r.cost;
    e.requests++;
    byKey.set(key, e);
  }
  const days: T.UsageSummary["daily"] = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(req.now - i * 86_400_000).toISOString().slice(0, 10);
    const day = records.filter((r) => r.at.slice(0, 10) === date);
    days.push({
      date,
      input_tokens: day.reduce((s, r) => s + r.input_tokens, 0),
      output_tokens: day.reduce((s, r) => s + r.output_tokens, 0),
      runs: new Set(day.map((r) => r.run_id).filter(Boolean)).size,
    });
  }
  const local = records.filter((r) => r.mode !== "cloud").length;
  const cost = records.reduce((s, r) => s + r.cost, 0);
  return ok({
    period_start: new Date(req.now - 13 * 86_400_000).toISOString(),
    period_end: new Date(req.now).toISOString(),
    totals: {
      runs: req.state.runs.filter((r) => r.workspace_id === wsId).length,
      questions: records.filter((r) => r.operation === "question").length,
      input_tokens: records.reduce((s, r) => s + r.input_tokens, 0),
      output_tokens: records.reduce((s, r) => s + r.output_tokens, 0),
      estimated_cost_microunits: cost,
      local_share: records.length ? local / records.length : 1,
    },
    by_provider: [...byKey.values()],
    daily: days,
    budget: {
      limit_microunits: req.state.policies[wsId]?.monthly_budget_microunits ?? null,
      used_microunits: cost,
    },
  } satisfies T.UsageSummary);
});

route("GET", "/workspaces/:workspaceId/audit-events", (req) => {
  const wsId = req.params.workspaceId!;
  requireRole(req, wsId, "admin");
  const action = req.query.get("action");
  const actor = req.query.get("actor")?.toLowerCase();
  const items = req.state.audit
    .filter((a) => a.workspace_id === wsId)
    .filter((a) => !action || a.action.startsWith(action))
    .filter((a) => !actor || (a.actor_display ?? a.actor_type).toLowerCase().includes(actor))
    .map(strip);
  return paginate(items, req.query);
});

// ── GitHub & repositories ───────────────────────────────────────────────

route("GET", "/integrations/github/installations", (req) => {
  const wsId = scope(req);
  return ok(
    req.state.installations
      .filter((i) => i.workspace_id === wsId && i.status !== "disconnected")
      .map(strip),
  );
});

route("POST", "/integrations/github/complete", (req) => {
  const wsId = scope(req, "admin");
  const externalId = Number(req.body.installation_id);
  if (!Number.isInteger(externalId) || externalId <= 0)
    throw validation("installation_id", "is invalid");
  const existing = req.state.installations.find((i) => i.external_installation_id === externalId);
  if (existing && existing.workspace_id !== wsId) {
    throw new FixtureHttpError(
      409,
      "INSTALLATION_IN_USE",
      "This GitHub installation is connected to another workspace.",
    );
  }
  if (existing) {
    existing.status = "active";
    return ok(strip(existing));
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
    created_at: new Date(req.now).toISOString(),
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
  return ok(strip(inst), 201);
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
  const inst = findScoped(req, req.state.installations, req.params.id!);
  const registered = new Set(
    req.state.repositories
      .filter((r) => r.workspace_id === inst.workspace_id && r.status !== "disconnected")
      .map((r) => r.external_repository_id),
  );
  return ok(
    req.state.available.filter(
      (a) => a.installation_id === inst.id && !registered.has(a.external_repository_id),
    ),
  );
});

route("GET", "/repositories", (req) => {
  const wsId = scope(req);
  const items = req.state.repositories
    .filter((r) => r.workspace_id === wsId && r.status !== "disconnected")
    .map((r) => {
      indexStatus(req.state, r, req.now);
      return strip(r);
    });
  return paginate(items, req.query);
});

route("POST", "/repositories", (req) => {
  const wsId = scope(req, "admin");
  const installationId = str(req.body, "installation_id");
  const externalId = Number(req.body.external_repository_id);
  const inst = req.state.installations.find(
    (i) => i.id === installationId && i.workspace_id === wsId && i.status === "active",
  );
  if (!inst) throw new FixtureHttpError(404, "NOT_FOUND", "Installation not found.");
  const avail = req.state.available.find(
    (a) => a.installation_id === inst.id && a.external_repository_id === externalId,
  );
  if (!avail)
    throw new FixtureHttpError(
      403,
      "REPOSITORY_NOT_GRANTED",
      "The GitHub App installation does not grant access to this repository.",
    );
  const existing = req.state.repositories.find(
    (r) => r.workspace_id === wsId && r.external_repository_id === externalId,
  );
  const iso = new Date(req.now).toISOString();
  if (existing) {
    existing.status = "connected";
    existing.indexing_status = "pending";
    return ok(strip(existing), 200);
  }
  const repo: Scoped<T.Repository> = {
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
    created_at: iso,
    updated_at: iso,
  };
  req.state.repositories.push(repo);
  audit(req, wsId, "repository.connected", "repository", repo.id, { full_name: repo.full_name });
  return ok(strip(repo), 201);
});

route("GET", "/repositories/:repositoryId", (req) => ok(strip(repoForRead(req))));

route("PATCH", "/repositories/:repositoryId", (req) => {
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!, "admin");
  const body = req.body as T.UpdateRepositoryRequest;
  if (body.settings?.excluded_paths) {
    const paths = body.settings.excluded_paths.map((p) => p.trim()).filter(Boolean);
    if (paths.some((p) => p.includes("..") || p.startsWith("/")))
      throw validation("excluded_paths", "must be relative paths without '..'");
    repo.settings = { ...repo.settings, excluded_paths: paths };
  }
  if (body.status) {
    repo.status = body.status;
    if (body.status === "disabled") repo.indexing_status = "disabled";
  }
  repo.updated_at = new Date(req.now).toISOString();
  audit(req, repo.workspace_id, "repository.updated", "repository", repo.id, {
    fields: Object.keys(body),
  });
  return ok(strip(repo));
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
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!, "member");
  if (repo.status !== "connected")
    throw new FixtureHttpError(
      409,
      "REPOSITORY_NOT_CONNECTED",
      "Reconnect this repository before indexing.",
    );
  if (req.state.index_jobs[repo.id]) return ok(indexStatus(req.state, repo, req.now), 202);
  const sha = repo.full_name.endsWith("ml-pipeline")
    ? "4e8a1c93b27f6d05e1a2c3b4d5e6f708192a3b4c"
    : "9f3c2a17e4b5d8061c2e7a9b4f1d3e5c7a8b9c0d";
  req.state.index_jobs[repo.id] = {
    started_at: req.now,
    duration_ms: Math.max(1500, stageDurationMs() * 5),
    commit_sha: sha,
  };
  repo.indexing_status = "queued";
  audit(req, repo.workspace_id, "repository.index_queued", "repository", repo.id);
  return ok(indexStatus(req.state, repo, req.now), 202);
});

route("GET", "/repositories/:repositoryId/index-status", (req) => {
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!);
  return ok(indexStatus(req.state, repo, req.now));
});

route("GET", "/repositories/:repositoryId/tree", (req) => {
  const repo = repoForRead(req);
  const sha = requireIndexed(repo);
  return ok({ commit_sha: sha, entries: treeOf(repo.full_name) } satisfies T.FileTree);
});

route("GET", "/repositories/:repositoryId/files/content", (req) => {
  const repo = repoForRead(req);
  const sha = requireIndexed(repo);
  const path = req.query.get("path") ?? "";
  if (path.includes("..")) throw new FixtureHttpError(400, "INVALID_PATH", "Invalid path.");
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
  return ok({
    path,
    commit_sha: req.query.get("commit_sha") || sha,
    content_hash: contentHash(file.content),
    language: file.language,
    content: file.content,
    line_count: file.content.replace(/\n$/, "").split("\n").length,
    truncated: false,
  } satisfies T.FileContent);
});

route("POST", "/repositories/:repositoryId/search", (req) => {
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
  return ok({ results } satisfies T.SearchResponse);
});

route("GET", "/repositories/:repositoryId/snapshots", (req) => {
  const repo = repoForRead(req);
  const status = indexStatus(req.state, repo, req.now);
  return ok(status.snapshot ? [status.snapshot] : []);
});

route("POST", "/repositories/:repositoryId/questions", (req) => {
  const repo = repoForRead(req);
  const sha = requireIndexed(repo);
  const question = str(req.body, "question", { min: 3, max: 2000 });
  const hits = searchFiles(filesForRepository(repo.full_name), question, sha, 4);
  const strong = hits.filter((h) => (h.semantic_score ?? 0) >= 0.6);
  const policy = req.state.policies[repo.workspace_id] ?? defaultPolicy();
  req.state.usage.push({
    workspace_id: repo.workspace_id,
    provider: "mock",
    model: "mock-deterministic",
    mode: "mock",
    operation: "question",
    input_tokens: 900 + strong.length * 450,
    output_tokens: 240,
    cost: 0,
    at: new Date(req.now).toISOString(),
    run_id: null,
  });
  void policy;
  if (strong.length === 0) {
    return ok({
      question,
      answer:
        "I couldn't find indexed evidence that answers this question, so I won't guess. Try naming a file, function, or concept that appears in the code.",
      citations: [],
      provider: "mock",
      model: "mock-deterministic",
      mode: "mock",
      limitations: [
        "No retrieved chunk met the relevance threshold.",
        "Answers are only generated from indexed evidence.",
      ],
      retrieval: {
        chunks_considered: hits.length,
        chunks_used: 0,
        token_estimate: 0,
        latency_ms: 210,
      },
    } satisfies T.QuestionAnswer);
  }
  const lead = strong[0]!;
  const lines = strong.map(
    (h, i) =>
      `- \`${h.file_path}\` lines ${h.start_line}–${h.end_line}${h.symbol_name ? ` (\`${h.symbol_name}\`)` : ""} [${i + 1}]`,
  );
  return ok({
    question,
    answer: `The most relevant logic is in \`${lead.file_path}\`${lead.symbol_name ? `, around \`${lead.symbol_name}\`` : ""} [1]. Related evidence:\n\n${lines.join("\n")}\n\nThis answer was assembled by the mock provider from retrieved snippets; it summarises where the behaviour lives rather than explaining it.`,
    citations: strong.map((h) => ({
      path: h.file_path,
      start_line: h.start_line,
      end_line: h.end_line,
      commit_sha: h.commit_sha,
      content_hash: h.content_hash,
    })),
    provider: "mock",
    model: "mock-deterministic",
    mode: "mock",
    limitations: repo.full_name.endsWith("ml-pipeline")
      ? ["Notebook files are not indexed and were not searched."]
      : [],
    retrieval: {
      chunks_considered: hits.length + 6,
      chunks_used: strong.length,
      token_estimate: strong.length * 410,
      latency_ms: 640,
    },
  } satisfies T.QuestionAnswer);
});

route("GET", "/repositories/:repositoryId/knowledge", (req) => {
  const repo = repoForRead(req);
  return ok(
    req.state.knowledge
      .filter((k) => k.repository_id === repo.id)
      .map(({ content: _c, ...k }) => (void _c, strip(k))),
  );
});

route("POST", "/repositories/:repositoryId/knowledge", (req) => {
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!, "member");
  const title = str(req.body, "title", { min: 3, max: 200 });
  const content = str(req.body, "content", { min: 10, max: 20000 });
  const source_type = req.body.source_type as T.KnowledgeSourceType;
  if (!["engineering_note", "decision", "architecture"].includes(source_type))
    throw validation("source_type", "is invalid");
  const iso = new Date(req.now).toISOString();
  const doc = {
    id: nextId(req.state, "41000000"),
    workspace_id: repo.workspace_id,
    repository_id: repo.id,
    source_type,
    external_id: null,
    title,
    content,
    content_hash: contentHash(content),
    source_url: null,
    indexed_at: null,
    created_at: iso,
  };
  req.state.knowledge.unshift(doc);
  audit(req, repo.workspace_id, "knowledge.created", "knowledge_document", doc.id);
  return ok(strip(doc), 201);
});

route("GET", "/knowledge/:documentId", (req) => {
  const doc = findScoped(req, req.state.knowledge, req.params.documentId!);
  return ok(strip(doc));
});

route("DELETE", "/knowledge/:documentId", (req) => {
  const doc = findScoped(req, req.state.knowledge, req.params.documentId!, "member");
  req.state.knowledge = req.state.knowledge.filter((k) => k.id !== doc.id);
  audit(req, doc.workspace_id, "knowledge.deleted", "knowledge_document", doc.id);
  return noContent();
});

// ── tasks & runs ────────────────────────────────────────────────────────

route("POST", "/repositories/:repositoryId/tasks", (req) => {
  const repo = findScoped(req, req.state.repositories, req.params.repositoryId!, "member");
  const title = str(req.body, "title", { min: 4, max: 200 });
  const description = str(req.body, "description", { min: 10, max: 10000 });
  const source_type = (req.body.source_type as T.TaskSourceType) ?? "manual";
  if (!["github_issue", "pull_request", "failing_check", "manual"].includes(source_type))
    throw validation("source_type", "is invalid");
  const external_number =
    req.body.external_number === undefined ? null : Number(req.body.external_number);
  if (source_type !== "manual" && (!external_number || external_number < 1))
    throw validation("external_number", "is required for GitHub sources");
  const iso = new Date(req.now).toISOString();
  const task: Scoped<T.EngineeringTask> = {
    id: nextId(req.state, "81000000"),
    workspace_id: repo.workspace_id,
    repository_id: repo.id,
    created_by: req.state.session_user_id!,
    source_type,
    external_number,
    title,
    description,
    status: "open",
    labels: [],
    created_at: iso,
    updated_at: iso,
  };
  req.state.tasks.unshift(task);
  audit(req, repo.workspace_id, "task.created", "engineering_task", task.id);
  return ok(taskView(req.state, task), 201);
});

route("GET", "/tasks", (req) => {
  const wsId = scope(req);
  const status = req.query.get("status");
  const repoId = req.query.get("repository_id");
  const items = req.state.tasks
    .filter((t) => t.workspace_id === wsId)
    .filter((t) => !status || t.status === status)
    .filter((t) => !repoId || t.repository_id === repoId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((t) => taskView(req.state, t));
  return paginate(items, req.query);
});

route("GET", "/tasks/:taskId", (req) =>
  ok(taskView(req.state, findScoped(req, req.state.tasks, req.params.taskId!))),
);

route("PATCH", "/tasks/:taskId", (req) => {
  const task = findScoped(req, req.state.tasks, req.params.taskId!, "member");
  if (req.body.title !== undefined) task.title = str(req.body, "title", { min: 4, max: 200 });
  if (req.body.description !== undefined)
    task.description = str(req.body, "description", { min: 10, max: 10000 });
  if (Array.isArray(req.body.labels))
    task.labels = (req.body.labels as unknown[])
      .filter((l): l is string => typeof l === "string")
      .slice(0, 10);
  if (req.body.status === "archived" || req.body.status === "open") task.status = req.body.status;
  task.updated_at = new Date(req.now).toISOString();
  return ok(taskView(req.state, task));
});

route("POST", "/tasks/:taskId/runs", (req) => {
  const task = findScoped(req, req.state.tasks, req.params.taskId!, "member");
  const repo = req.state.repositories.find((r) => r.id === task.repository_id)!;
  requireIndexed(repo);
  if (
    req.state.runs.some(
      (r) => r.task_id === task.id && (ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status),
    )
  ) {
    throw new FixtureHttpError(409, "RUN_ALREADY_ACTIVE", "This task already has an active run.");
  }
  const mode = (req.body.mode as T.InferenceMode) ?? "local";
  const policy = req.state.policies[task.workspace_id] ?? defaultPolicy();
  if (mode === "cloud" && !policy.cloud_inference_enabled) {
    throw new FixtureHttpError(
      403,
      "PROVIDER_NOT_PERMITTED",
      "Cloud inference is not enabled by workspace policy. No paid fallback was used.",
    );
  }
  const base_branch = str(req.body, "base_branch", { min: 1, max: 255 });
  const run = createRun(
    req.state,
    task,
    { mode, base_branch, budgets: req.body.budgets as Partial<T.RunBudgets> },
    req.now,
  );
  audit(req, task.workspace_id, "run.started", "workflow_run", run.id, { mode });
  return ok(runView(req.state, run), 202);
});

route("GET", "/tasks/:taskId/runs", (req) => {
  const task = findScoped(req, req.state.tasks, req.params.taskId!);
  return ok(
    req.state.runs
      .filter((r) => r.task_id === task.id)
      .sort((a, b) => b.run_number - a.run_number)
      .map(runSummary),
  );
});

route("GET", "/runs", (req) => {
  const wsId = scope(req);
  const statuses = req.query.getAll("status");
  const repoId = req.query.get("repository_id");
  const items: T.RunListItem[] = req.state.runs
    .filter((r) => r.workspace_id === wsId)
    .filter((r) => !statuses.length || statuses.includes(r.status))
    .map((r) => {
      const task = req.state.tasks.find((t) => t.id === r.task_id)!;
      const repo = req.state.repositories.find((x) => x.id === task.repository_id)!;
      return {
        ...runSummary(r),
        task_title: task.title,
        repository_id: repo.id,
        repository_full_name: repo.full_name,
      };
    })
    .filter((r) => !repoId || r.repository_id === repoId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return paginate(items, req.query);
});

route("GET", "/runs/:runId", (req) => ok(runView(req.state, getRun(req))));
route("GET", "/runs/:runId/steps", (req) => ok(getRun(req).steps));
route("GET", "/runs/:runId/artifacts", (req) => {
  const run = getRun(req);
  const artifacts: T.RunArtifact[] = [];
  if (run.diff)
    artifacts.push({
      id: `${run.id}-patch`,
      kind: "patch",
      name: "changes.patch",
      byte_size: run.diff.unified_diff.length,
      created_at: run.updated_at,
    });
  for (const v of run.verification?.results ?? []) {
    if (v.status !== "skipped")
      artifacts.push({
        id: `${v.id}-log`,
        kind: "stdout",
        name: `${v.profile_id}.log`,
        byte_size: (v.output_excerpt ?? "").length,
        created_at: v.created_at,
      });
  }
  return ok(artifacts);
});

route("POST", "/runs/:runId/cancel", (req) => {
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
    "Cancelled by a workspace member.",
  );
  audit(req, run.workspace_id, "run.cancelled", "workflow_run", run.id);
  return ok(runView(req.state, run));
});

route("POST", "/runs/:runId/retry", (req) => {
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
  const next = createRun(
    req.state,
    task,
    { mode: run.mode, base_branch: run.base_branch ?? "main", budgets: run.budget },
    req.now,
  );
  audit(req, run.workspace_id, "run.retried", "workflow_run", next.id, { previous_run_id: run.id });
  return ok(runView(req.state, next), 202);
});

route("GET", "/runs/:runId/plan", (req) => {
  const run = getRun(req);
  if (!run.plan)
    throw new FixtureHttpError(404, "PLAN_NOT_READY", "The plan has not been proposed yet.");
  return ok(run.plan);
});

route("PATCH", "/runs/:runId/plan", (req) => {
  const run = getRun(req, "member");
  requireStatus(run, ["awaiting_plan_approval"], "edit the plan");
  const plan = req.body.plan as T.EngineeringPlan | undefined;
  if (!plan || typeof plan.objective !== "string" || plan.objective.trim().length < 5)
    throw validation("objective", "must be at least 5 characters");
  if (!Array.isArray(plan.steps) || plan.steps.length === 0)
    throw validation("steps", "must contain at least one step");
  if (plan.files_to_modify.length > run.budget.max_changed_files!) {
    throw validation(
      "files_to_modify",
      `cannot exceed the run's ${run.budget.max_changed_files} changed-file budget`,
    );
  }
  run.plan = {
    ...run.plan!,
    plan,
    plan_hash: contentHash(JSON.stringify(plan)),
    version: run.plan!.version + 1,
    state: "edited",
    updated_at: new Date(req.now).toISOString(),
  };
  audit(req, run.workspace_id, "plan.edited", "workflow_run", run.id, {
    version: run.plan.version,
  });
  return ok(run.plan);
});

route("POST", "/runs/:runId/plan-approval", (req) => {
  const run = getRun(req, "member");
  requireStatus(run, ["awaiting_plan_approval"], "decide on the plan");
  const decision = req.body.decision;
  if (decision !== "approved" && decision !== "rejected")
    throw validation("decision", "must be approved or rejected");
  const comment =
    typeof req.body.comment === "string" ? req.body.comment.trim().slice(0, 2000) : null;
  if (decision === "rejected" && !comment)
    throw validation("comment", "is required when rejecting");
  const user = currentUser(req);
  const approval: T.Approval = {
    id: nextId(req.state, "61000000"),
    approval_type: "plan",
    decision,
    comment,
    user_id: user.id,
    created_at: new Date(req.now).toISOString(),
  };
  run.approvals.push(approval);
  run.plan = { ...run.plan!, state: decision, decided_by: user, decision_comment: comment };
  audit(req, run.workspace_id, `plan.${decision}`, "workflow_run", run.id, {
    plan_hash: run.plan.plan_hash,
  });
  if (decision === "rejected")
    finish(req.state, run, "rejected", req.now, "PLAN_REJECTED", comment ?? undefined);
  else schedule(run, PHASE_TWO, req.now);
  return ok(approval, 201);
});

route("GET", "/runs/:runId/diff", (req) => {
  const run = getRun(req);
  if (!run.diff)
    throw new FixtureHttpError(404, "DIFF_NOT_READY", "No patch has been proposed yet.");
  return ok(run.diff);
});

route("GET", "/runs/:runId/verification", (req) => {
  const run = getRun(req);
  if (!run.verification)
    throw new FixtureHttpError(404, "VERIFICATION_NOT_READY", "Verification has not run yet.");
  return ok(run.verification);
});

route("GET", "/runs/:runId/review", (req) => {
  const run = getRun(req);
  if (!run.review) throw new FixtureHttpError(404, "REVIEW_NOT_READY", "Review has not run yet.");
  return ok(run.review);
});

route("POST", "/runs/:runId/findings/:findingId/disposition", (req) => {
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
  const map = { accept: "accepted", dismiss: "dismissed", fix: "fixed" } as const;
  const d = req.body.disposition as keyof typeof map;
  if (!map[d]) throw validation("disposition", "must be accept, dismiss, or fix");
  if (d === "dismiss" && !(typeof req.body.comment === "string" && req.body.comment.trim())) {
    throw validation("comment", "is required when dismissing a finding");
  }
  finding.status = map[d];
  audit(req, run.workspace_id, `finding.${map[d]}`, "review_finding", finding.id, {
    severity: finding.severity,
    source: finding.source,
  });
  return ok(finding);
});

route("POST", "/runs/:runId/pr-approval", (req) => {
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
  const blocking =
    run.review?.findings.filter(
      (f) => f.status === "open" && (f.severity === "critical" || f.severity === "high"),
    ) ?? [];
  if (decision === "approved" && blocking.length) {
    throw new FixtureHttpError(
      409,
      "BLOCKING_FINDINGS",
      `Resolve ${blocking.length} open high-severity finding(s) before approving.`,
      {
        finding_ids: blocking.map((f) => f.id),
      },
    );
  }
  const comment =
    typeof req.body.comment === "string" ? req.body.comment.trim().slice(0, 2000) : null;
  const approval: T.Approval = {
    id: nextId(req.state, "62000000"),
    approval_type: "pull_request",
    decision,
    comment,
    user_id: currentUser(req).id,
    created_at: new Date(req.now).toISOString(),
  };
  run.approvals.push(approval);
  audit(req, run.workspace_id, `pull_request.${decision}`, "workflow_run", run.id, {
    patch_hash: run.diff?.patch_hash,
  });
  if (decision === "approved") run.pr_approved = true;
  else finish(req.state, run, "completed_without_pr", req.now);
  return ok(approval, 201);
});

route("POST", "/runs/:runId/pull-request", (req) => {
  const run = getRun(req, "member");
  requireStatus(run, ["awaiting_pr_approval"], "create a pull request");
  if (!run.pr_approved)
    throw new FixtureHttpError(
      403,
      "APPROVAL_REQUIRED",
      "An authorized approval is required before creating a pull request.",
    );
  const title = str(req.body, "title", { min: 5, max: 256 });
  const body = str(req.body, "body", { min: 10, max: 60000 });
  const base_branch = str(req.body, "base_branch", { min: 1, max: 255 });
  void body;
  const task = req.state.tasks.find((t) => t.id === run.task_id)!;
  const repo = req.state.repositories.find((r) => r.id === task.repository_id)!;
  const number = 480 + req.state.runs.filter((r) => r.pull_request).length + 2;
  const iso = new Date(req.now).toISOString();
  run.pull_request = {
    id: nextId(req.state, "63000000"),
    provider: "github",
    pr_number: number,
    pr_url: `https://github.com/${repo.full_name}/pull/${number}`,
    head_branch: `anvaya/run-${run.id.slice(-6)}-${title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 30)
      .replace(/-$/, "")}`,
    base_branch,
    created_at: iso,
  };
  run.status = "creating_pr";
  run.current_stage = "creating_pr";
  run.state_version += 1;
  run.events.push({
    id: `evt_${run.run_number}_${run.events.length + 1}_${run.id.slice(-6)}`,
    type: "run.status.changed",
    payload: { run_id: run.id, timestamp: iso, status: "creating_pr" },
  });
  run.events.push({
    id: `evt_${run.run_number}_${run.events.length + 1}_${run.id.slice(-6)}`,
    type: "pull_request.created",
    payload: { run_id: run.id, timestamp: iso, pr_number: number, pr_url: run.pull_request.pr_url },
  });
  run.schedule = [{ status: "completed", at: req.now + Math.min(600, stageDurationMs()) }];
  audit(req, run.workspace_id, "pull_request.created", "workflow_run", run.id, {
    pr_number: number,
    title,
  });
  return ok(run.pull_request, 201);
});

export { tick };
