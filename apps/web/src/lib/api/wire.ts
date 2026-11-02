/**
 * Wire format of the Anvaya control-plane API, exactly as the NestJS backend sends and
 * accepts it. Sources (backend repo): apps/api/openapi.json (request bodies),
 * docs/backend/API_CONTRACT_NOTES.md, and the `*View` mappers in apps/api/src.
 *
 * The UI never consumes these types directly: `mappers.ts` converts them to the UI
 * models in `types.ts`. Keep this file a faithful mirror of the backend; when the
 * backend publishes response schemas in OpenAPI, generate this file instead.
 *
 * Fields marked `R1`…`R5` were added by the backend at the frontend's request (c2f3813).
 * Mappers still treat them as optional so older API builds degrade gracefully.
 */

type ISO = string;
type UUID = string;
export type WMode = "local" | "cloud" | "mock";
export type WRole = "owner" | "admin" | "member" | "viewer";

// ── envelopes ────────────────────────────────────────────────────────────

export interface WMeta {
  request_id?: string;
  page?: { next_cursor: string | null; has_more: boolean };
}

export interface WValidationIssue {
  path: (string | number)[] | string;
  message: string;
  code?: string;
}

// ── auth & identity ──────────────────────────────────────────────────────

export interface WProviders {
  github: boolean;
  dev: boolean;
}

export interface WDevLogin {
  user: WUser;
  csrf_token: string;
  expires_at: ISO;
}

export interface WUser {
  id: UUID;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at?: ISO;
}

export interface WMe {
  user: WUser;
  memberships: {
    workspace_id: UUID;
    workspace_name: string;
    workspace_slug: string;
    role: WRole;
  }[];
}

export interface WRunBudget {
  max_steps: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_duration_seconds: number;
  max_changed_files: number;
  max_repair_attempts: number;
}

export interface WWorkspace {
  id: UUID;
  name: string;
  slug: string;
  plan_key: string;
  role: WRole;
  settings: {
    retention?: { snapshot_days?: number; run_artifact_days?: number; log_days?: number };
    run_budget_limits?: Partial<WRunBudget>;
  };
  created_at: ISO;
  updated_at: ISO;
}

export interface WMember {
  user_id: UUID;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  role: WRole;
  joined_at: ISO;
}

export interface WInvitation {
  id: UUID;
  email: string;
  role: Exclude<WRole, "owner">;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: ISO;
  created_at: ISO;
  /** Only on creation. */
  token?: string;
  accept_url?: string;
}

export interface WAuditEvent {
  id: UUID;
  actor_type: "user" | "system" | "worker" | "provider";
  actor_user_id: UUID | null;
  actor_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  created_at: ISO;
}

// ── GitHub & repositories ────────────────────────────────────────────────

export interface WInstallation {
  id: UUID;
  workspace_id: UUID;
  provider: "github";
  external_installation_id: number;
  account_login: string;
  account_type: string | null;
  granted_permissions: Record<string, string>;
  status: "active" | "suspended" | "disconnected";
  created_at: ISO;
  updated_at: ISO;
}

export interface WInstallUrl {
  url: string;
  state: string;
  expires_in_seconds: number;
}

export interface WAvailableRepository {
  external_repository_id: number;
  full_name: string;
  owner?: string;
  name: string;
  default_branch: string | null;
  visibility?: "public" | "private" | "internal" | null;
  private?: boolean;
  connected?: boolean;
}

export interface WRepositorySettings {
  exclude_paths?: string[];
  max_file_bytes?: number;
  auto_index_on_push?: boolean;
  verification_profiles?: string[];
}

export interface WRepository {
  id: UUID;
  workspace_id: UUID;
  installation_id: UUID | null;
  provider: "github";
  external_repository_id: number;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string | null;
  visibility: "public" | "private" | "internal" | null;
  status: "connected" | "disabled" | "disconnected";
  indexing_status: "pending" | "queued" | "indexing" | "ready" | "partial" | "failed" | "disabled";
  latest_indexed_commit_sha: string | null;
  indexed_at: ISO | null;
  settings: WRepositorySettings;
  created_at: ISO;
  updated_at: ISO;
}

export interface WIndexJob {
  id: UUID;
  status: string;
  stage: string | null;
  trigger: string;
  commit_sha: string | null;
  progress: {
    files_total?: number;
    files_processed?: number;
    files_reused?: number;
    chunks_embedded?: number;
  } & Record<string, unknown>;
  attempts: number;
  error_code: string | null;
  error_summary: string | null;
  created_at: ISO;
  started_at: ISO | null;
  ended_at: ISO | null;
}

export interface WIndexStatus {
  repository_id: UUID;
  indexing_status: WRepository["indexing_status"];
  latest_snapshot: {
    id: UUID;
    commit_sha: string;
    branch_name: string | null;
    status: "queued" | "processing" | "ready" | "partial" | "failed";
    parser_version: string | null;
    chunker_version: string | null;
    embedding_model: string | null;
    /** Free-text limitations (or null). */
    limitations: string | null;
    completed_at: ISO | null;
  } | null;
  coverage: {
    total_files: number;
    indexed_files: number;
    excluded_files: number;
    failed_files: number;
    reused_files: number;
    excluded_by_reason: Record<string, number>;
    parse_status: Record<string, number>;
    languages: Record<string, { files: number; parsed: number }>;
    chunks: number;
    embedded_chunks: number;
  } | null;
  active_job: WIndexJob | null;
  last_job: WIndexJob | null;
  supported_parsers: string[];
}

export type WTreeEntry =
  | { type: "directory"; name: string; path: string; file_count?: number }
  | {
      type: "file";
      name: string;
      path: string;
      language: string | null;
      parse_status?: string | null;
      excluded: boolean;
      exclusion_reason: string | null;
      byte_size: number | null;
      line_count: number | null;
    };

export interface WTree {
  snapshot_id: UUID;
  commit_sha: string;
  path: string;
  entries: WTreeEntry[];
  truncated: boolean;
}

export interface WFile {
  path: string;
  commit_sha: string;
  content_hash: string;
  language: string | null;
  line_count: number;
  start_line?: number;
  end_line?: number;
  truncated: boolean;
  content: string;
  parse_status?: string | null;
}

export interface WSearchResult {
  chunk_id?: UUID;
  file_path: string;
  start_line: number;
  end_line: number;
  commit_sha: string;
  content_hash: string;
  chunk_hash?: string;
  language: string | null;
  symbol_name: string | null;
  snippet: string;
  lexical_score: number | null;
  semantic_score: number | null;
  score?: number | null;
}

export interface WSearch {
  results: WSearchResult[];
  retrieval?: Record<string, unknown>;
}

export interface WCitation {
  evidence_id?: string;
  path: string;
  start_line: number;
  end_line: number;
  commit_sha: string;
  content_hash: string;
  symbol?: string | null;
  supports?: string | null;
}

export interface WQuestionAnswer {
  answer: string;
  insufficient_evidence: boolean;
  citations: WCitation[];
  limitations: string[];
  provider: string | null;
  model: string | null;
  mode: WMode;
  prompt_version?: string | null;
  data_disclosure: { provider: string; data_categories: string[] } | null;
  retrieval?: { result_count?: number; evidence_included?: string[] } & Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    duration_ms?: number;
    schema_repair_attempted?: boolean;
  };
}

export interface WKnowledge {
  id: UUID;
  repository_id: UUID | null;
  source_type:
    "readme" | "architecture" | "decision" | "issue" | "pull_request" | "engineering_note";
  external_id?: string | null;
  title: string;
  content_hash: string;
  source_url: string | null;
  indexed_at: ISO | null;
  created_at: ISO;
  content?: string;
}

// ── AI policy & usage ────────────────────────────────────────────────────

export type WDataCategory =
  "source_code" | "documentation" | "issue_text" | "diffs" | "test_output";

export interface WAiPolicy {
  default_mode: WMode;
  allowed_modes: WMode[];
  cloud: {
    enabled: boolean;
    provider: string | null;
    model: string | null;
    data_categories: WDataCategory[];
  };
  limits: { max_input_tokens: number; max_output_tokens: number; request_timeout_seconds: number };
}

export interface WProviderHealth {
  mode: WMode;
  provider: string | null;
  available: boolean;
  models: string[];
  detail: string | null;
  checked_at: ISO;
}

export interface WUsageAgg {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_microunits: number | null;
  avg_duration_ms: number;
}

export interface WUsage {
  workspace_id: UUID;
  period: { from: ISO; to: ISO | null };
  totals: WUsageAgg;
  local_vs_hosted: { local: number; mock: number; hosted: number };
  by_provider: (WUsageAgg & { provider: string; model: string })[];
  by_operation: (WUsageAgg & { operation: string })[];
  /** R3 */
  daily?: {
    date: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_microunits: number | null;
  }[];
}

// ── tasks & runs ─────────────────────────────────────────────────────────

export interface WRunSummary {
  id: UUID;
  run_number: number;
  status: string;
  current_stage: string | null;
  created_at: ISO;
  mode?: WMode;
  updated_at?: ISO;
  task_id?: UUID;
}

export interface WTask {
  id: UUID;
  workspace_id: UUID;
  repository_id: UUID;
  created_by: UUID;
  source_type: "manual" | "github_issue" | "pull_request" | "failing_check";
  external_number: number | null;
  title: string;
  description: string;
  status: "open" | "active" | "completed" | "failed" | "cancelled" | "archived";
  labels: string[];
  created_at: ISO;
  updated_at: ISO;
  /** On GET /tasks/:id; R2 asks for it on list items too. */
  latest_run?: WRunSummary | null;
  /** R2 */
  repository_full_name?: string;
}

export interface WApproval {
  id?: UUID;
  approval_type?: "plan" | "pull_request";
  decision: "approved" | "rejected";
  subject_hash?: string | null;
  comment: string | null;
  user_id: UUID;
  created_at: ISO;
}

export interface WPullRequest {
  id: UUID;
  pr_number: number;
  pr_url: string;
  head_branch: string;
  base_branch: string;
  created_at?: ISO;
}

export interface WRun {
  id: UUID;
  task_id: UUID;
  workspace_id: UUID;
  repository_id: UUID;
  run_number: number;
  status: string;
  current_stage: string | null;
  mode: WMode;
  provider: string | null;
  model: string | null;
  base_branch: string | null;
  snapshot_id: UUID | null;
  state_version: number;
  budget: Partial<WRunBudget>;
  usage_summary: {
    input_tokens?: number;
    output_tokens?: number;
    model_calls?: number;
    agent_steps?: number;
    repair_attempts?: number;
    estimated_cost_microunits?: number;
  };
  retry_of_run_id: UUID | null;
  error_code: string | null;
  error_summary: string | null;
  cancel_requested_at: ISO | null;
  started_at: ISO | null;
  ended_at: ISO | null;
  created_at: ISO;
  updated_at: ISO;
  plan_hash?: string | null;
  plan_version?: number | null;
  data_disclosure?: { provider: string; data_categories: string[] } | null;
  /** GAP-19 */
  approvals?: WApproval[];
  /** R1 */
  task_title?: string;
  repository_full_name?: string;
  pull_request?: WPullRequest | null;
}

export interface WRunListItem extends WRun {
  task_title: string;
  repository_full_name: string;
}

export interface WStep {
  id: UUID;
  sequence_number: number;
  agent_type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
  prompt_version: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  error_code: string | null;
  input?: unknown;
  output?: unknown;
  started_at: ISO | null;
  ended_at: ISO | null;
  tool_calls?: {
    tool_name: string;
    status: string;
    input?: unknown;
    output?: unknown;
    duration_ms: number | null;
  }[];
}

export interface WArtifacts {
  patches: {
    id: UUID;
    patch_hash?: string;
    byte_size?: number | null;
    created_at: ISO;
    download_url?: string | null;
  }[];
  verification_logs: {
    id: UUID;
    profile_id?: string;
    name?: string;
    byte_size?: number | null;
    created_at: ISO;
    download_url?: string | null;
  }[];
}

export interface WPlanDoc {
  objective: string;
  assumptions: string[];
  steps: { id: string; description: string; files: string[]; verification: string[] }[];
  files_to_modify: string[];
  tests: string[];
  risks: string[];
  out_of_scope: string[];
}

export interface WInvestigation {
  summary: string;
  findings: {
    claim: string;
    evidence: { path: string; start_line: number; end_line: number; commit_sha: string }[];
    kind: "observed" | "inferred";
  }[];
  hypotheses: string[];
  unknowns: string[];
  candidate_files: string[];
}

export interface WPlan {
  run_id: UUID;
  version: number;
  plan_hash: string;
  source: "agent" | "user_edit";
  created_by: UUID | null;
  created_at: ISO;
  editable: boolean;
  plan: WPlanDoc;
  investigation: WInvestigation | null;
  approval: WApproval | null;
}

export interface WDiff {
  patch_id: UUID;
  patch_hash: string;
  attempt: number;
  base_commit_sha: string;
  summary: string | null;
  additions: number;
  deletions: number;
  changed_files: {
    path: string;
    action: "create" | "modify" | "delete" | string;
    explanation?: string | null;
  }[];
  diff: string;
  diff_truncated: boolean;
  attempts?: unknown[];
}

export interface WVerificationResult {
  id?: UUID;
  profile_id: string;
  command_display: string;
  image?: string | null;
  status: "passed" | "failed" | "timed_out" | "skipped" | "error";
  exit_code: number | null;
  duration_ms: number | null;
  output_truncated?: boolean;
  stdout_excerpt?: string | null;
  stderr_excerpt?: string | null;
  attempt?: number;
  patch_id?: UUID;
  created_at?: ISO;
}

export interface WVerification {
  deterministic: true;
  current_patch_id: UUID | null;
  summary: {
    passed: number;
    failed: number;
    timed_out: number;
    skipped: number;
    unavailable: number;
  };
  results: WVerificationResult[];
  /** R4 */
  unavailable?: { profile_id: string; reason: string; kind?: "unsupported" | "sandbox_error" }[];
}

export interface WFinding {
  id: UUID;
  source: "ai_review" | "security_scanner" | "static_analysis" | "test";
  severity: "info" | "low" | "medium" | "high" | "critical";
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  title: string;
  description: string;
  evidence: unknown;
  status: "open" | "accepted" | "dismissed" | "fixed";
  /** R5 */
  confidence?: "low" | "medium" | "high" | null;
  suggested_action?: string | null;
  created_at?: ISO;
}

export interface WReview {
  summary: string | null;
  deterministic_findings: WFinding[];
  ai_findings: WFinding[];
}
