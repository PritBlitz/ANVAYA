/**
 * Wire → UI model mapping (anti-corruption layer).
 *
 * Every response from the control plane passes through one of these pure functions, so
 * a backend shape change is absorbed here instead of in screens. Each mapper is
 * unit-tested and exercised end-to-end by the fixture adapter, which speaks the wire
 * format too.
 */
import { parseUnifiedDiff } from "@/lib/diff";
import type * as T from "./types";
import type * as W from "./wire";

const PARSER_LANGUAGES_FALLBACK = ["typescript", "javascript", "python"];

// ── identity ─────────────────────────────────────────────────────────────

export function toMe(w: W.WMe): T.Me {
  return {
    user: {
      id: w.user.id,
      email: w.user.email,
      display_name: w.user.display_name,
      avatar_url: w.user.avatar_url,
    },
    memberships: w.memberships.map((m) => ({ workspace_id: m.workspace_id, role: m.role })),
  };
}

export function toWorkspace(w: W.WWorkspace): T.Workspace {
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    plan_key: w.plan_key,
    role: w.role,
    created_at: w.created_at,
  };
}

/** Run budget ceilings: workspace limits over the server defaults. */
export function runBudgetLimits(
  w: Pick<W.WWorkspace, "settings"> | null | undefined,
): T.RunBudgets {
  return { ...DEFAULT_LIMITS, ...(w?.settings.run_budget_limits ?? {}) };
}
const DEFAULT_LIMITS: T.RunBudgets = {
  max_steps: 8,
  max_input_tokens: 6000,
  max_output_tokens: 1024,
  max_duration_seconds: 900,
  max_changed_files: 8,
  max_repair_attempts: 1,
};

export function toMember(w: W.WMember): T.Member {
  return {
    user: { id: w.user_id, email: w.email, display_name: w.display_name, avatar_url: w.avatar_url },
    role: w.role,
    created_at: w.joined_at,
  };
}

export function toInvitation(w: W.WInvitation): T.Invitation {
  return {
    id: w.id,
    email: w.email,
    role: w.role,
    status: w.status,
    expires_at: w.expires_at ?? null,
    created_at: w.created_at,
    ...(w.accept_url ? { accept_url: w.accept_url } : {}),
  };
}

export function toAuditEvent(w: W.WAuditEvent): T.AuditEvent {
  return {
    id: w.id,
    actor_user_id: w.actor_user_id,
    actor_display: w.actor_email,
    actor_type: w.actor_type,
    action: w.action,
    resource_type: w.resource_type,
    resource_id: w.resource_id,
    request_id: w.request_id,
    metadata_redacted: w.metadata ?? {},
    created_at: w.created_at,
  };
}

// ── GitHub & repositories ────────────────────────────────────────────────

export function toInstallation(w: W.WInstallation): T.GitInstallation {
  return {
    id: w.id,
    provider: "github",
    external_installation_id: w.external_installation_id,
    account_login: w.account_login,
    account_type: w.account_type,
    granted_permissions: w.granted_permissions ?? {},
    status: w.status,
    created_at: w.created_at,
  };
}

export function toAvailableRepository(
  w: W.WAvailableRepository,
  installationId: string,
): T.AvailableRepository {
  const [owner = "", ...rest] = w.full_name.split("/");
  return {
    external_repository_id: w.external_repository_id,
    full_name: w.full_name,
    owner,
    name: rest.join("/") || w.full_name,
    default_branch: w.default_branch,
    visibility: w.private ? "private" : "public",
    installation_id: installationId,
  };
}

/** Selectable repositories: not yet connected and not archived. */
export function selectableRepositories(
  page: W.WAvailableRepositoriesPage,
  installationId: string,
): T.AvailableRepository[] {
  return page.repositories
    .filter((r) => r.connected_repository_id === null && !r.archived)
    .map((r) => toAvailableRepository(r, installationId));
}

export function toRepository(w: W.WRepository): T.Repository {
  return {
    id: w.id,
    installation_id: w.installation_id,
    provider: "github",
    external_repository_id: w.external_repository_id,
    owner: w.owner,
    name: w.name,
    full_name: w.full_name,
    default_branch: w.default_branch,
    visibility: w.visibility,
    status: w.status,
    indexing_status: w.indexing_status,
    latest_indexed_commit_sha: w.latest_indexed_commit_sha,
    indexed_at: w.indexed_at,
    settings: {
      exclude_paths: w.settings?.exclude_paths ?? [],
      verification_profiles: w.settings?.verification_profiles ?? [],
    },
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

const STAGE_LABEL: Record<string, string> = {
  queued: "Waiting for an indexing worker",
  fetching: "Fetching snapshot",
  fetching_snapshot: "Fetching snapshot",
  classifying: "Classifying files",
  processing_files: "Parsing and chunking files",
  parsing: "Parsing syntax trees",
  chunking: "Chunking",
  embedding: "Embedding",
  finalizing: "Finalizing",
};

export function toIndexStatus(w: W.WIndexStatus): T.IndexStatus {
  const cov = w.coverage;
  const parsers = w.supported_parsers?.length ? w.supported_parsers : PARSER_LANGUAGES_FALLBACK;
  const job = w.active_job;
  const total = job?.progress?.files_total;
  const processed = job?.progress?.files_processed;
  const snap = w.latest_snapshot;
  const errors: T.IndexStatus["errors"] = [];
  if (
    w.last_job?.error_summary &&
    (w.indexing_status === "failed" || w.indexing_status === "partial")
  ) {
    errors.push({ path: null, message: w.last_job.error_summary });
  }
  return {
    repository_id: w.repository_id,
    indexing_status: w.indexing_status,
    active: !!job,
    snapshot: snap
      ? {
          id: snap.id,
          commit_sha: snap.commit_sha,
          branch_name: snap.branch_name,
          total_files: cov?.total_files ?? 0,
          indexed_files: cov?.indexed_files ?? 0,
          excluded_files: cov?.excluded_files ?? 0,
          status: snap.status,
          parser_version: snap.parser_version,
          chunker_version: snap.chunker_version,
          created_at: snap.completed_at ?? "",
        }
      : null,
    progress: job
      ? {
          phase: STAGE_LABEL[job.stage ?? job.status] ?? humanizeStage(job.stage ?? job.status),
          processed_files: processed ?? 0,
          total_files: total ?? 0,
        }
      : null,
    languages: Object.entries(cov?.languages ?? {})
      .map(([language, v]) => ({
        language,
        files: v.files,
        indexed_files: v.parsed,
        parser_supported: parsers.includes(language),
      }))
      .sort((a, b) => b.files - a.files),
    exclusions: Object.entries(cov?.excluded_by_reason ?? {})
      .filter(([, n]) => n > 0)
      .map(([reason, files]) => ({ reason, files })),
    limitations: snap?.limitations ? splitLimitations(snap.limitations) : [],
    errors,
    embedding_model: snap?.embedding_model ?? null,
  };
}

/** One limitation per line; a single sentence may itself contain semicolons. */
function splitLimitations(text: string): string[] {
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function humanizeStage(stage: string): string {
  const s = stage.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function toTree(w: W.WTree): T.FileTree {
  return {
    commit_sha: w.commit_sha,
    path: w.path ?? "",
    truncated: !!w.truncated,
    entries: w.entries
      .map((e): T.TreeEntry =>
        e.type === "directory"
          ? { type: "directory", name: e.name, path: e.path, file_count: e.file_count }
          : {
              type: "file",
              name: e.name,
              path: e.path,
              language: e.language,
              byte_size: e.byte_size,
              line_count: e.line_count,
              is_excluded: e.excluded,
              exclusion_reason: e.exclusion_reason,
            },
      )
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
      ),
  };
}

export function toFileContent(w: W.WFile): T.FileContent {
  return {
    path: w.path,
    commit_sha: w.commit_sha,
    content_hash: w.content_hash,
    language: w.language,
    content: w.content,
    line_count: w.line_count,
    start_line: w.start_line,
    end_line: w.end_line,
    truncated: !!w.truncated,
  };
}

export function toSearchResponse(w: W.WSearch): T.SearchResponse {
  return {
    results: w.results.map((r) => ({
      file_path: r.file_path,
      start_line: r.start_line,
      end_line: r.end_line,
      commit_sha: r.commit_sha,
      content_hash: r.content_hash,
      snippet: r.snippet,
      lexical_score: r.lexical_score,
      semantic_score: r.semantic_score,
      language: r.language,
      symbol_name: r.symbol_name,
    })),
  };
}

export function toQuestionAnswer(question: string, w: W.WQuestionAnswer): T.QuestionAnswer {
  return {
    question,
    answer: w.answer,
    insufficient_evidence: !!w.insufficient_evidence,
    citations: w.citations.map((c) => ({
      path: c.path,
      start_line: c.start_line,
      end_line: c.end_line,
      commit_sha: c.commit_sha,
      content_hash: c.content_hash,
    })),
    provider: w.provider,
    model: w.model,
    mode: w.mode,
    limitations: w.limitations ?? [],
    data_disclosure: w.data_disclosure ?? null,
    retrieval: {
      chunks_considered:
        typeof w.retrieval?.result_count === "number" ? w.retrieval.result_count : null,
      chunks_used: w.citations.length,
      token_estimate: w.usage?.input_tokens ?? null,
      latency_ms: w.usage?.duration_ms ?? null,
    },
  };
}

export function toKnowledge(w: W.WKnowledge): T.KnowledgeDocument {
  return {
    id: w.id,
    repository_id: w.repository_id,
    source_type: w.source_type,
    external_id: w.external_id ?? null,
    title: w.title,
    content_hash: w.content_hash,
    source_url: w.source_url,
    indexed_at: w.indexed_at,
    created_at: w.created_at,
    ...(w.content !== undefined ? { content: w.content } : {}),
  };
}

// ── AI & usage ───────────────────────────────────────────────────────────

export function toProviderHealth(w: W.WProviderHealth): T.ProviderHealth {
  return { ...w, models: w.models ?? [] };
}

export function modeOfProvider(provider: string): T.InferenceMode {
  if (provider === "mock") return "mock";
  if (provider === "ollama") return "local";
  return "cloud";
}

export function toUsage(w: W.WUsage): T.UsageSummary {
  const totalRequests = w.totals.requests;
  const nonHosted = w.local_vs_hosted.local + w.local_vs_hosted.mock;
  return {
    period_start: w.period.from,
    period_end: w.period.to,
    totals: { ...w.totals, local_share: totalRequests ? nonHosted / totalRequests : 1 },
    requests_by_mode: w.local_vs_hosted,
    by_provider: w.by_provider.map((p) => ({ ...p, mode: modeOfProvider(p.provider) })),
    by_operation: w.by_operation,
    daily: w.daily ?? null,
  };
}

// ── tasks & runs ─────────────────────────────────────────────────────────

function toRunSummary(w: W.WRunSummary, taskId: string): T.RunSummary {
  return {
    id: w.id,
    task_id: w.task_id ?? taskId,
    run_number: w.run_number,
    status: w.status as T.RunStatus,
    current_stage: w.current_stage,
    mode: w.mode ?? "local",
    created_at: w.created_at,
    updated_at: w.updated_at ?? w.created_at,
  };
}

export function toTask(w: W.WTask): T.EngineeringTask {
  return {
    id: w.id,
    repository_id: w.repository_id,
    repository_full_name: w.repository_full_name,
    created_by: w.created_by,
    source_type: w.source_type,
    external_number: w.external_number,
    title: w.title,
    description: w.description,
    status: w.status,
    labels: w.labels ?? [],
    // null = never run; undefined = not provided by this endpoint.
    latest_run:
      w.latest_run === undefined
        ? undefined
        : w.latest_run
          ? toRunSummary(w.latest_run, w.id)
          : null,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

export function toApproval(
  w: W.WApproval,
  fallbackType: T.Approval["approval_type"] = "plan",
): T.Approval {
  return {
    id: w.id ?? null,
    approval_type: w.approval_type ?? fallbackType,
    decision: w.decision,
    comment: w.comment,
    user_id: w.user_id,
    subject_hash: w.subject_hash ?? null,
    created_at: w.created_at,
  };
}

export function toPullRequest(w: W.WPullRequest): T.PullRequest {
  return {
    id: w.id,
    pr_number: w.pr_number,
    pr_url: w.pr_url,
    head_branch: w.head_branch,
    base_branch: w.base_branch,
    created_at: w.created_at ?? null,
  };
}

export function toRun(w: W.WRun): T.WorkflowRun {
  return {
    ...toRunSummary(w, w.task_id),
    mode: w.mode,
    provider: w.provider,
    model: w.model,
    state_version: w.state_version,
    budget: w.budget ?? {},
    usage_summary: {
      input_tokens: w.usage_summary?.input_tokens,
      output_tokens: w.usage_summary?.output_tokens,
      steps: w.usage_summary?.agent_steps,
      repair_attempts: w.usage_summary?.repair_attempts,
      estimated_cost_microunits: w.usage_summary?.estimated_cost_microunits,
    },
    started_at: w.started_at,
    ended_at: w.ended_at,
    error_code: w.error_code,
    error_summary: w.error_summary,
    base_branch: w.base_branch,
    plan_hash: w.plan_hash ?? null,
    retry_of_run_id: w.retry_of_run_id,
    data_disclosure: w.data_disclosure ?? null,
    task: {
      id: w.task_id,
      title: w.task_title ?? null,
      repository_id: w.repository_id,
      repository_full_name: w.repository_full_name ?? null,
    },
    pull_request: w.pull_request ? toPullRequest(w.pull_request) : null,
    approvals: (w.approvals ?? []).map((a) => toApproval(a)),
  };
}

export function toRunListItem(w: W.WRunListItem): T.RunListItem {
  return {
    ...toRunSummary(w, w.task_id),
    mode: w.mode,
    task_title: w.task_title,
    repository_id: w.repository_id,
    repository_full_name: w.repository_full_name,
  };
}

export function toStep(w: W.WStep): T.AgentStep {
  return {
    id: w.id,
    sequence_number: w.sequence_number,
    agent_type: w.agent_type,
    status: w.status,
    prompt_version: w.prompt_version,
    provider: w.provider,
    model: w.model,
    input_tokens: w.input_tokens,
    output_tokens: w.output_tokens,
    duration_ms: w.duration_ms,
    started_at: w.started_at,
    ended_at: w.ended_at,
    error_code: w.error_code,
    output_redacted: w.output,
    tools: (w.tool_calls ?? []).map((t, i) => ({
      id: `${w.id}:${i}`,
      tool_name: t.tool_name,
      status: (["started", "succeeded", "failed", "cancelled"].includes(t.status)
        ? t.status
        : "succeeded") as T.ToolExecutionStatus,
      input_redacted: t.input,
      output_redacted: t.output,
      duration_ms: t.duration_ms,
      created_at: w.started_at ?? "",
    })),
  };
}

export function toArtifacts(w: W.WArtifacts): T.RunArtifact[] {
  return [
    ...(w.patches ?? []).map((p) => ({
      id: p.id,
      kind: "patch",
      name: `${(p.patch_hash ?? p.id).replace(/^sha256:/, "").slice(0, 12)}.patch`,
      byte_size: p.byte_size ?? null,
      created_at: p.created_at,
      download_url: p.download_url ?? null,
    })),
    ...(w.verification_logs ?? []).map((l) => ({
      id: l.id,
      kind: "log",
      name: l.name ?? `${l.profile_id ?? "verification"}.log`,
      byte_size: l.byte_size ?? null,
      created_at: l.created_at,
      download_url: l.download_url ?? null,
    })),
  ];
}

export function toInvestigation(w: W.WInvestigation): T.Investigation {
  return {
    summary: w.summary ?? "",
    hypotheses: w.hypotheses ?? [],
    unknowns: w.unknowns ?? [],
    candidate_files: w.candidate_files ?? [],
    findings: (w.findings ?? []).map((f) => {
      const evidence = f.evidence ?? [];
      return {
        claim: f.claim,
        kind: f.kind,
        evidence,
        unresolved_evidence: evidence.length > 0 ? 0 : (f.evidence_ids?.length ?? 0),
      };
    }),
  };
}

export function toRunPlan(w: W.WPlan): T.RunPlan {
  const approval = w.approval ? toApproval(w.approval, "plan") : null;
  return {
    run_id: w.run_id,
    plan: w.plan,
    investigation: w.investigation ? toInvestigation(w.investigation) : null,
    plan_hash: w.plan_hash,
    version: w.version,
    source: w.source,
    editable: w.editable,
    state: approval ? approval.decision : w.source === "user_edit" ? "edited" : "proposed",
    updated_at: w.created_at,
    approval,
  };
}

const ACTION_STATUS: Record<string, T.ChangedFileStatus> = {
  create: "added",
  add: "added",
  added: "added",
  delete: "deleted",
  deleted: "deleted",
  rename: "renamed",
  renamed: "renamed",
};

export function toRunDiff(w: W.WDiff): T.RunDiff {
  const parsed = new Map(parseUnifiedDiff(w.diff ?? "").map((f) => [f.path, f]));
  return {
    patch_id: w.patch_id ?? null,
    patch_hash: w.patch_hash,
    attempt: w.attempt ?? 1,
    base_commit_sha: w.base_commit_sha,
    summary: w.summary ?? null,
    additions: w.additions,
    deletions: w.deletions,
    unified_diff: w.diff ?? "",
    truncated: !!w.diff_truncated,
    changed_files: w.changed_files.map((c) => ({
      path: c.path,
      status: ACTION_STATUS[c.action] ?? "modified",
      additions: parsed.get(c.path)?.additions ?? 0,
      deletions: parsed.get(c.path)?.deletions ?? 0,
      explanation: c.explanation ?? null,
    })),
  };
}

export function toVerification(w: W.WVerification): T.VerificationReport {
  const unavailable = w.unavailable ?? [];
  return {
    results: w.results.map((r, i) => ({
      id: r.id ?? `${r.profile_id}:${r.attempt ?? 1}:${i}`,
      profile_id: r.profile_id,
      command_display: r.command_display,
      status: r.status,
      exit_code: r.exit_code,
      duration_ms: r.duration_ms,
      output_excerpt:
        [r.stdout_excerpt, r.stderr_excerpt]
          .filter((x): x is string => !!x && x.trim().length > 0)
          .join("\n") || null,
      output_truncated: !!r.output_truncated,
      attempt: r.attempt,
      created_at: r.created_at ?? null,
    })),
    unavailable,
    unavailable_count: Math.max(w.summary?.unavailable ?? 0, unavailable.length),
    ai_summary: null,
  };
}

function findingEvidence(w: W.WFinding): T.ReviewFinding["evidence"] {
  const ev = w.evidence;
  const out: T.ReviewFinding["evidence"] = {};
  if (Array.isArray(ev)) out.items = ev.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
  else if (typeof ev === "string") out.items = [ev];
  else if (ev && typeof ev === "object") {
    const o = ev as Record<string, unknown>;
    if (Array.isArray(o.items)) out.items = o.items.map(String);
    else if (Array.isArray(o.evidence)) out.items = o.evidence.map(String);
    if (typeof o.rationale === "string") out.rationale = o.rationale;
    if (typeof o.suggested_action === "string") out.suggested_action = o.suggested_action;
    if (typeof o.rule_id === "string") out.rule_id = o.rule_id;
  }
  if (w.suggested_action) out.suggested_action = w.suggested_action;
  return out;
}

function findingConfidence(w: W.WFinding): T.ReviewFinding["confidence"] {
  if (w.confidence) return w.confidence;
  const c = (w.evidence as { confidence?: unknown } | null)?.confidence;
  return c === "low" || c === "medium" || c === "high" ? c : null;
}

export function toFinding(w: W.WFinding): T.ReviewFinding {
  return {
    id: w.id,
    source: w.source,
    severity: w.severity,
    file_path: w.file_path,
    start_line: w.start_line,
    end_line: w.end_line,
    title: w.title,
    description: w.description,
    evidence: findingEvidence(w),
    confidence: w.source === "ai_review" ? findingConfidence(w) : null,
    status: w.status,
    created_at: w.created_at ?? null,
  };
}

export function toReview(w: W.WReview): T.ReviewReport {
  return {
    summary: w.summary,
    findings: [...(w.deterministic_findings ?? []), ...(w.ai_findings ?? [])].map(toFinding),
  };
}

// ── field errors ─────────────────────────────────────────────────────────

/**
 * Validation errors arrive as `details.issues: [{ path, message }]`. Map them to a
 * flat field → message record keyed by the last path segment (e.g. "plan.objective"
 * → "objective"). Also accepts a pre-flattened `details.fields` record.
 */
export function fieldErrorsFromDetails(details: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const fields = details.fields;
  if (fields && typeof fields === "object") {
    for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
      else if (Array.isArray(value) && typeof value[0] === "string") out[key] = value[0];
    }
  }
  const issues = details.issues;
  if (Array.isArray(issues)) {
    for (const issue of issues as W.WValidationIssue[]) {
      if (!issue || typeof issue.message !== "string") continue;
      const segments = (
        Array.isArray(issue.path) ? issue.path : String(issue.path ?? "").split(".")
      ).filter((s) => typeof s === "string" && s.length > 0) as string[];
      const key = segments[segments.length - 1];
      if (key && !(key in out)) out[key] = issue.message;
      const full = segments.join(".");
      if (full && !(full in out)) out[full] = issue.message;
    }
  }
  return out;
}
