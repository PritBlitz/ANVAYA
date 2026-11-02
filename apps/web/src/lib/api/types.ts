/**
 * Anvaya public API contract — frontend view.
 *
 * Source of truth: docs/API_SPEC.md (endpoints, envelopes, events) and docs/DATABASE.md
 * (field names and enumerations). Field names are snake_case exactly as they appear on
 * the wire; the frontend never renames them.
 *
 * Wherever API_SPEC.md does not define a shape, the type is derived from DATABASE.md and
 * tagged `GAP-xx`. Every gap is listed in docs/frontend/API_INTEGRATION.md so the backend
 * session can confirm or correct it. These types should migrate to `packages/contracts`
 * once that shared package exists (CLAUDE.md §3).
 */

export type UUID = string;
export type ISODateTime = string;

// ── Envelopes (API_SPEC §1) ──────────────────────────────────────────────

export interface ResponseMeta {
  request_id?: string;
  /** Cursor pagination (API_SPEC §1). GAP-09: location of next_cursor is assumed. */
  next_cursor?: string | null;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta?: ResponseMeta;
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  error: ErrorBody;
  meta?: ResponseMeta;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface PageParams {
  limit?: number;
  cursor?: string;
}

// ── Identity and workspaces (API_SPEC §2, DATABASE users/organizations/memberships) ──

export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export interface User {
  id: UUID;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
}

/** GAP-12: API says "workspace", DATABASE.md says "organization". Same entity. */
export interface Workspace {
  id: UUID;
  name: string;
  slug: string;
  plan_key: string;
  role: WorkspaceRole; // caller's role, GAP-09
  created_at: ISODateTime;
}

export interface Membership {
  workspace_id: UUID;
  role: WorkspaceRole;
}

export interface Me {
  user: User;
  memberships: Membership[];
}

export interface Member {
  user: User;
  role: WorkspaceRole;
  created_at: ISODateTime;
}

export interface CreateWorkspaceRequest {
  name: string;
  slug: string;
}

export interface UpdateWorkspaceRequest {
  name?: string;
}

export interface InviteMemberRequest {
  email: string;
  role: Exclude<WorkspaceRole, "owner">;
}

export interface Invitation {
  id: UUID;
  email: string;
  role: WorkspaceRole;
  created_at: ISODateTime;
}

// ── Git integrations and repositories (API_SPEC §3) ──────────────────────

export type InstallationStatus = "active" | "suspended" | "disconnected";

export interface GitInstallation {
  id: UUID;
  provider: "github";
  external_installation_id: number;
  account_login: string;
  account_type: string | null;
  granted_permissions: Record<string, string>;
  status: InstallationStatus;
  created_at: ISODateTime;
}

export interface CompleteInstallationRequest {
  installation_id: number;
  setup_action?: string;
  state?: string;
}

/** GAP-03: repositories visible to an installation that are not yet registered. */
export interface AvailableRepository {
  external_repository_id: number;
  full_name: string;
  owner: string;
  name: string;
  default_branch: string | null;
  visibility: RepositoryVisibility;
  installation_id: UUID;
}

export type RepositoryVisibility = "public" | "private" | "internal";
export type RepositoryStatus = "connected" | "disabled" | "disconnected";
export const INDEXING_STATUSES = [
  "pending",
  "queued",
  "indexing",
  "ready",
  "partial",
  "failed",
  "disabled",
] as const;
export type IndexingStatus = (typeof INDEXING_STATUSES)[number];

export interface RepositorySettings {
  excluded_paths?: string[];
}

export interface Repository {
  id: UUID;
  installation_id: UUID | null;
  provider: "github";
  external_repository_id: number;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string | null;
  visibility: RepositoryVisibility | null;
  status: RepositoryStatus;
  indexing_status: IndexingStatus;
  latest_indexed_commit_sha: string | null;
  indexed_at: ISODateTime | null;
  settings: RepositorySettings;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface RegisterRepositoryRequest {
  installation_id: UUID;
  external_repository_id: number;
}

export interface UpdateRepositoryRequest {
  settings?: RepositorySettings;
  status?: Extract<RepositoryStatus, "connected" | "disabled">;
}

export type SnapshotStatus = "queued" | "processing" | "ready" | "partial" | "failed";

export interface RepositorySnapshot {
  id: UUID;
  commit_sha: string;
  branch_name: string | null;
  total_files: number;
  indexed_files: number;
  excluded_files: number;
  status: SnapshotStatus;
  parser_version: string | null;
  chunker_version: string | null;
  created_at: ISODateTime;
}

export interface LanguageCoverage {
  language: string;
  files: number;
  indexed_files: number;
  /** Whether a syntax-aware parser exists for this language (FR-REP-009). */
  parser_supported: boolean;
}

export interface ExclusionSummary {
  reason: string; // e.g. "binary", "dependency", "generated", "secret", "configured", "size_limit"
  files: number;
}

/** GAP-09: shape of GET /repositories/:id/index-status. */
export interface IndexStatus {
  repository_id: UUID;
  indexing_status: IndexingStatus;
  snapshot: RepositorySnapshot | null;
  progress: { phase: string; processed_files: number; total_files: number } | null;
  languages: LanguageCoverage[];
  exclusions: ExclusionSummary[];
  limitations: string[];
  errors: { path: string | null; message: string }[];
  embedding_model: string | null;
}

export interface TreeEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  language?: string | null;
  byte_size?: number;
  is_excluded?: boolean;
  exclusion_reason?: string | null;
  children?: TreeEntry[];
}

export interface FileTree {
  commit_sha: string;
  entries: TreeEntry[];
}

/** GAP-04: proposed GET /repositories/:id/files/content?path=&commit_sha= */
export interface FileContent {
  path: string;
  commit_sha: string;
  content_hash: string;
  language: string | null;
  content: string;
  line_count: number;
  truncated: boolean;
}

export interface SearchFilters {
  languages?: string[];
  paths?: string[];
}

export interface SearchRequest {
  query: string;
  snapshot: "latest" | string;
  top_k: number;
  filters?: SearchFilters;
}

export interface SearchResult {
  file_path: string;
  start_line: number;
  end_line: number;
  commit_sha: string;
  content_hash: string;
  snippet: string;
  lexical_score: number | null;
  semantic_score: number | null;
  language?: string | null;
  symbol_name?: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
}

// ── Repository Q&A and knowledge (API_SPEC §4) ───────────────────────────

export type InferenceMode = "local" | "cloud" | "mock";

export interface Citation {
  path: string;
  start_line: number;
  end_line: number;
  commit_sha: string;
  content_hash: string;
}

export interface AskQuestionRequest {
  question: string;
  snapshot?: "latest" | string;
}

/** GAP-06: API_SPEC lists required content but not field names. */
export interface QuestionAnswer {
  id?: UUID;
  question: string;
  answer: string;
  citations: Citation[];
  provider: string;
  model: string;
  mode: InferenceMode;
  limitations: string[];
  retrieval: {
    chunks_considered: number;
    chunks_used: number;
    token_estimate: number | null;
    latency_ms: number | null;
  };
}

export const KNOWLEDGE_SOURCE_TYPES = [
  "readme",
  "architecture",
  "decision",
  "issue",
  "pull_request",
  "engineering_note",
] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

export interface KnowledgeDocument {
  id: UUID;
  repository_id: UUID | null;
  source_type: KnowledgeSourceType;
  external_id: string | null;
  title: string;
  content_hash: string;
  source_url: string | null;
  indexed_at: ISODateTime | null;
  created_at: ISODateTime;
  /** Present on GET /knowledge/:id only. GAP-09 */
  content?: string;
}

export interface CreateKnowledgeRequest {
  source_type: Extract<KnowledgeSourceType, "engineering_note" | "decision" | "architecture">;
  title: string;
  content: string;
}

// ── Tasks and runs (API_SPEC §5) ─────────────────────────────────────────

export const TASK_SOURCE_TYPES = [
  "github_issue",
  "pull_request",
  "failing_check",
  "manual",
] as const;
export type TaskSourceType = (typeof TASK_SOURCE_TYPES)[number];
export const TASK_STATUSES = [
  "open",
  "active",
  "completed",
  "failed",
  "cancelled",
  "archived",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface EngineeringTask {
  id: UUID;
  repository_id: UUID;
  repository_full_name?: string; // GAP-09: convenient for lists
  created_by: UUID;
  source_type: TaskSourceType;
  external_number: number | null;
  title: string;
  description: string;
  status: TaskStatus;
  labels: string[];
  latest_run?: RunSummary | null; // GAP-09
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface CreateTaskRequest {
  source_type: TaskSourceType;
  title: string;
  description: string;
  external_number?: number;
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  labels?: string[];
  status?: Extract<TaskStatus, "open" | "archived">;
}

export interface TaskListParams extends PageParams {
  repository_id?: UUID;
  status?: TaskStatus;
}

/** ARCHITECTURE.md §6 workflow state machine. */
export const ACTIVE_RUN_STATUSES = [
  "queued",
  "retrieving_context",
  "investigating",
  "planning",
  "awaiting_plan_approval",
  "preparing_workspace",
  "implementing",
  "verifying",
  "reviewing",
  "awaiting_pr_approval",
  "creating_pr",
] as const;
export const TERMINAL_RUN_STATUSES = [
  "completed",
  "completed_without_pr",
  "failed",
  "cancelled",
  "timed_out",
  "rejected",
] as const;
export type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number];
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];
export type RunStatus = ActiveRunStatus | TerminalRunStatus;

export interface RunBudgets {
  max_steps: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_duration_seconds: number;
  max_changed_files: number;
  max_repair_attempts: number;
}

export interface RunUsageSummary {
  input_tokens?: number;
  output_tokens?: number;
  steps?: number;
  repair_attempts?: number;
  estimated_cost_microunits?: number;
  duration_ms?: number;
}

export interface RunSummary {
  id: UUID;
  task_id: UUID;
  run_number: number;
  status: RunStatus;
  current_stage: string | null;
  mode: InferenceMode;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface WorkflowRun extends RunSummary {
  provider: string | null;
  model: string | null;
  state_version: number;
  budget: Partial<RunBudgets>;
  usage_summary: RunUsageSummary;
  started_at: ISODateTime | null;
  ended_at: ISODateTime | null;
  error_code: string | null;
  error_summary: string | null;
  /** GAP-09: denormalised context for the run workspace header. */
  task?: Pick<EngineeringTask, "id" | "title" | "repository_id" | "repository_full_name">;
  base_branch?: string | null;
  pull_request?: PullRequest | null;
  /** GAP-19: approvals recorded on this run, needed to render the PR gate after reload. */
  approvals?: Approval[];
}

export interface StartRunRequest {
  mode: InferenceMode;
  base_branch: string;
  budgets?: Partial<RunBudgets>;
}

/** GAP-05: proposed workspace-wide run list, used by Runs and Reviews. */
export interface RunListParams extends PageParams {
  status?: RunStatus[];
  repository_id?: UUID;
}

export interface RunListItem extends RunSummary {
  task_title: string;
  repository_id: UUID;
  repository_full_name: string;
}

export type AgentStepStatus =
  "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
export type ToolExecutionStatus = "started" | "succeeded" | "failed" | "cancelled";

export interface ToolExecution {
  id: UUID;
  tool_name: string;
  status: ToolExecutionStatus;
  input_redacted: unknown;
  output_redacted: unknown;
  duration_ms: number | null;
  created_at: ISODateTime;
}

export interface AgentStep {
  id: UUID;
  sequence_number: number;
  agent_type: string;
  status: AgentStepStatus;
  prompt_version: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  started_at: ISODateTime | null;
  ended_at: ISODateTime | null;
  error_code: string | null;
  output_redacted?: unknown;
  tools?: ToolExecution[];
}

export interface RunArtifact {
  id: UUID;
  kind: string; // "patch" | "stdout" | "stderr" | "report" | …
  name: string;
  byte_size: number | null;
  created_at: ISODateTime;
  download_url?: string | null;
}

// ── Investigation and plan (AI_WORKFLOW §4) ──────────────────────────────

export interface EvidenceRef {
  path: string;
  start_line: number;
  end_line: number;
  commit_sha: string;
}

export interface InvestigationFinding {
  claim: string;
  evidence: EvidenceRef[];
  kind: "observed" | "inferred";
}

export interface Investigation {
  summary: string;
  findings: InvestigationFinding[];
  hypotheses: string[];
  unknowns: string[];
  candidate_files: string[];
}

export interface PlanStep {
  id: string;
  description: string;
  files: string[];
  verification: string[];
}

export interface EngineeringPlan {
  objective: string;
  assumptions: string[];
  steps: PlanStep[];
  files_to_modify: string[];
  tests: string[];
  risks: string[];
  out_of_scope: string[];
}

export type PlanState = "proposed" | "edited" | "approved" | "rejected";

/** GAP-07: GET /runs/:id/plan response wrapper. */
export interface RunPlan {
  run_id: UUID;
  plan: EngineeringPlan;
  investigation: Investigation | null;
  plan_hash: string;
  version: number;
  state: PlanState;
  updated_at: ISODateTime;
  decided_by?: User | null;
  decision_comment?: string | null;
}

export type ApprovalDecision = "approved" | "rejected";

export interface ApprovalRequest {
  decision: ApprovalDecision;
  comment?: string;
}

export interface Approval {
  id: UUID;
  approval_type: "plan" | "pull_request" | "other";
  decision: ApprovalDecision;
  comment: string | null;
  user_id: UUID;
  created_at: ISODateTime;
}

// ── Diff, verification, review, PR (API_SPEC §6) ─────────────────────────

export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  previous_path?: string | null;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
}

/** GAP-18: GET /runs/:id/diff */
export interface RunDiff {
  patch_hash: string;
  base_commit_sha: string;
  patch_status: "proposed" | "validated" | "applied" | "rejected";
  changed_files: ChangedFile[];
  additions: number;
  deletions: number;
  unified_diff: string;
}

export type VerificationStatus = "passed" | "failed" | "timed_out" | "skipped" | "error";

export interface VerificationResult {
  id: UUID;
  profile_id: string;
  command_display: string;
  status: VerificationStatus;
  exit_code: number | null;
  duration_ms: number | null;
  /** Bounded, redacted output tail. */
  output_excerpt?: string | null;
  created_at: ISODateTime;
}

export interface VerificationReport {
  results: VerificationResult[];
  /** Profiles configured but unavailable for this repository (FR-VER-005). */
  unavailable: { profile_id: string; reason: string }[];
  /** AI-written explanation of failures. Never determines pass/fail. */
  ai_summary?: string | null;
}

export const FINDING_SOURCES = [
  "ai_review",
  "static_analysis",
  "security_scanner",
  "test",
] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];
export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type FindingStatus = "open" | "accepted" | "dismissed" | "fixed";

export interface ReviewFinding {
  id: UUID;
  source: FindingSource;
  severity: Severity;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  title: string;
  description: string;
  evidence: {
    items?: string[];
    rationale?: string;
    suggested_action?: string;
    rule_id?: string;
  };
  confidence?: "low" | "medium" | "high" | null;
  status: FindingStatus;
  created_at: ISODateTime;
}

export interface ReviewReport {
  findings: ReviewFinding[];
  summary?: string | null;
}

export type FindingDispositionDecision = "accept" | "dismiss" | "fix";

export interface FindingDispositionRequest {
  disposition: FindingDispositionDecision;
  comment?: string;
}

export interface CreatePullRequestRequest {
  title: string;
  body: string;
  base_branch: string;
}

export interface PullRequest {
  id: UUID;
  provider: "github";
  pr_number: number;
  pr_url: string;
  head_branch: string;
  base_branch: string;
  created_at: ISODateTime;
}

// ── AI policy, usage, audit (API_SPEC §7) ────────────────────────────────

/** GAP-16: shape of the provider policy. */
export interface AiPolicy {
  default_mode: InferenceMode;
  cloud_inference_enabled: boolean;
  allowed_providers: string[];
  local_provider: { name: string; model: string; embedding_model: string };
  cloud_provider: { name: string; model: string } | null;
  data_categories_disclosed: string[];
  budgets: RunBudgets;
  monthly_budget_microunits: number | null;
  updated_at: ISODateTime;
  updated_by: UUID | null;
}

export type UpdateAiPolicyRequest = Partial<
  Pick<
    AiPolicy,
    "default_mode" | "cloud_inference_enabled" | "budgets" | "monthly_budget_microunits"
  >
>;

export interface ProviderHealth {
  provider: string;
  model: string;
  mode: InferenceMode;
  status: "healthy" | "degraded" | "unavailable";
  latency_ms: number | null;
  message: string | null;
  checked_at: ISODateTime;
}

/** GAP-16 */
export interface UsageSummary {
  period_start: ISODateTime;
  period_end: ISODateTime;
  totals: {
    runs: number;
    questions: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_microunits: number;
    local_share: number; // 0..1
  };
  by_provider: {
    provider: string;
    model: string;
    mode: InferenceMode;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_microunits: number;
    requests: number;
  }[];
  daily: { date: string; input_tokens: number; output_tokens: number; runs: number }[];
  budget: { limit_microunits: number | null; used_microunits: number };
}

export interface AuditEvent {
  id: UUID;
  actor_user_id: UUID | null;
  actor_display: string | null; // GAP-09
  actor_type: "user" | "system" | "worker" | "provider";
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  request_id: string | null;
  metadata_redacted: Record<string, unknown>;
  created_at: ISODateTime;
}

export interface AuditListParams extends PageParams {
  action?: string;
  actor?: string;
  since?: ISODateTime;
}

// ── SSE run events (API_SPEC §8) ─────────────────────────────────────────

export const RUN_EVENT_TYPES = [
  "run.created",
  "run.status.changed",
  "run.stage.changed",
  "retrieval.completed",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "tool.started",
  "tool.completed",
  "patch.proposed",
  "sandbox.started",
  "verification.completed",
  "review.finding.created",
  "approval.required",
  "pull_request.created",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/**
 * Every event carries run_id + timestamp (API_SPEC §8 example). Additional fields are
 * GAP-10 and treated as optional so the UI degrades gracefully.
 */
export interface RunEventPayload {
  run_id: UUID;
  timestamp: ISODateTime;
  status?: RunStatus;
  stage?: string;
  agent_type?: string;
  tool_name?: string;
  approval_type?: "plan" | "pull_request";
  message?: string;
  error_code?: string;
  [key: string]: unknown;
}

export interface RunEvent {
  id: string;
  type: RunEventType;
  payload: RunEventPayload;
}
