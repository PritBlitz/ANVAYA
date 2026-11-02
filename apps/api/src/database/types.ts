import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** Timestamps: read as Date, written as Date or ISO string, defaulted by the DB. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** jsonb: read as parsed value, written as a JSON string (see `json()`). */
type Json<T> = ColumnType<T, string | undefined, string>;
type NullableJson<T> = ColumnType<T | null, string | null | undefined, string | null>;

export type JsonObject = Record<string, unknown>;

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export interface UsersTable {
  id: Generated<string>;
  auth_subject: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  created_by: string | null;
  plan_key: Generated<string>;
  settings: Json<JsonObject>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MembershipsTable {
  organization_id: string;
  user_id: string;
  role: Role;
  created_at: Generated<Date>;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  csrf_token_hash: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  expires_at: Timestamp;
  revoked_at: NullableTimestamp;
}

export interface WorkspaceInvitationsTable {
  id: Generated<string>;
  organization_id: string;
  email: string;
  role: Exclude<Role, 'owner'>;
  token_hash: string;
  invited_by: string;
  status: Generated<'pending' | 'accepted' | 'revoked' | 'expired'>;
  expires_at: Timestamp;
  accepted_by: string | null;
  accepted_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface GitInstallationsTable {
  id: Generated<string>;
  organization_id: string;
  provider: 'github';
  external_installation_id: number;
  account_login: string;
  account_type: string | null;
  granted_permissions: Json<Record<string, string>>;
  status: Generated<'active' | 'suspended' | 'disconnected'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type RepositoryIndexingStatus = 'pending' | 'queued' | 'indexing' | 'ready' | 'partial' | 'failed' | 'disabled';

export interface RepositoriesTable {
  id: Generated<string>;
  organization_id: string;
  installation_id: string | null;
  provider: Generated<string>;
  external_repository_id: number;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string | null;
  visibility: 'public' | 'private' | 'internal' | null;
  status: Generated<'connected' | 'disabled' | 'disconnected'>;
  indexing_status: Generated<RepositoryIndexingStatus>;
  latest_indexed_commit_sha: string | null;
  indexed_at: NullableTimestamp;
  settings: Json<JsonObject>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WebhookDeliveriesTable {
  delivery_id: string;
  provider: Generated<string>;
  event: string;
  action: string | null;
  external_installation_id: number | null;
  payload_hash: string;
  status: Generated<'received' | 'processed' | 'ignored' | 'failed'>;
  error_summary: string | null;
  received_at: Generated<Date>;
  processed_at: NullableTimestamp;
}

export type SnapshotStatus = 'queued' | 'processing' | 'ready' | 'partial' | 'failed';

export interface RepositorySnapshotsTable {
  id: Generated<string>;
  repository_id: string;
  commit_sha: string;
  branch_name: string | null;
  archive_object_key: string | null;
  archive_hash: string | null;
  total_files: Generated<number>;
  indexed_files: Generated<number>;
  excluded_files: Generated<number>;
  status: SnapshotStatus;
  parser_version: string | null;
  chunker_version: string | null;
  failed_files: Generated<number>;
  reused_files: Generated<number>;
  embedding_model: string | null;
  embedding_dimension: number | null;
  base_snapshot_id: string | null;
  language_stats: Json<Record<string, { files: number; parsed: number }>>;
  error_summary: string | null;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export type ParseStatus = 'parsed' | 'unsupported_language' | 'parse_error' | 'not_parsed' | 'excluded';

export interface RepositoryFilesTable {
  id: Generated<string>;
  snapshot_id: string;
  repository_id: string;
  path: string;
  blob_sha: string | null;
  content_hash: string;
  language: string | null;
  file_type: string | null;
  byte_size: number;
  line_count: number | null;
  is_excluded: Generated<boolean>;
  exclusion_reason: string | null;
  parse_status: Generated<ParseStatus>;
  created_at: Generated<Date>;
}

export interface CodeChunksTable {
  id: Generated<string>;
  repository_file_id: string;
  repository_id: string;
  snapshot_id: string;
  chunk_index: number;
  start_line: number;
  end_line: number;
  symbol_name: string | null;
  chunk_kind: string | null;
  content: string;
  content_hash: string;
  language: string | null;
  /** pgvector literal, e.g. '[0.1,0.2,...]'. */
  embedding: string | null;
  embedding_model: string | null;
  embedding_version: string | null;
  search_vector: ColumnType<string, never, never>;
  created_at: Generated<Date>;
}

export interface KnowledgeChunksTable {
  id: Generated<string>;
  document_id: string;
  organization_id: string;
  repository_id: string;
  chunk_index: number;
  start_line: number;
  end_line: number;
  content: string;
  content_hash: string;
  /** pgvector literal, e.g. '[0.1,0.2,...]'. */
  embedding: string | null;
  embedding_model: string | null;
  embedding_version: string | null;
  search_vector: ColumnType<string, never, never>;
  created_at: Generated<Date>;
}

export interface RepositoryQuestionsTable {
  id: Generated<string>;
  organization_id: string;
  repository_id: string;
  user_id: string;
  question: string;
  answer: string;
  insufficient_evidence: boolean;
  citations: Json<unknown[]>;
  limitations: Json<string[]>;
  provider: string | null;
  model: string | null;
  mode: string | null;
  commit_sha: string | null;
  created_at: Generated<Date>;
}

export interface SymbolsTable {
  id: Generated<string>;
  repository_id: string;
  snapshot_id: string;
  repository_file_id: string;
  symbol_key: string;
  name: string;
  qualified_name: string | null;
  kind: string;
  start_line: number;
  end_line: number;
  language: string | null;
  signature: string | null;
  created_at: Generated<Date>;
}

export interface SymbolRelationshipsTable {
  id: Generated<string>;
  snapshot_id: string;
  source_symbol_id: string;
  target_symbol_id: string | null;
  relationship_type: string;
  target_external_name: string | null;
  evidence: Json<JsonObject>;
  created_at: Generated<Date>;
}

export type KnowledgeSourceType = 'readme' | 'architecture' | 'decision' | 'issue' | 'pull_request' | 'engineering_note';

export interface KnowledgeDocumentsTable {
  id: Generated<string>;
  organization_id: string;
  repository_id: string | null;
  source_type: KnowledgeSourceType;
  external_id: string | null;
  title: string;
  content_object_key: string | null;
  content_hash: string;
  source_url: string | null;
  indexed_at: NullableTimestamp;
  created_by: string | null;
  created_at: Generated<Date>;
}

export type TaskStatus = 'open' | 'active' | 'completed' | 'failed' | 'cancelled' | 'archived';
export type TaskSourceType = 'github_issue' | 'pull_request' | 'failing_check' | 'manual';

export interface EngineeringTasksTable {
  id: Generated<string>;
  organization_id: string;
  repository_id: string;
  created_by: string;
  source_type: TaskSourceType;
  external_number: number | null;
  title: string;
  description: string;
  status: Generated<TaskStatus>;
  labels: Json<string[]>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export const RUN_ACTIVE_STATUSES = [
  'queued',
  'retrieving_context',
  'investigating',
  'planning',
  'awaiting_plan_approval',
  'preparing_workspace',
  'implementing',
  'verifying',
  'reviewing',
  'awaiting_pr_approval',
  'creating_pr',
] as const;
export const RUN_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'timed_out', 'rejected', 'completed_without_pr'] as const;
export type RunStatus = (typeof RUN_ACTIVE_STATUSES)[number] | (typeof RUN_TERMINAL_STATUSES)[number];
export type RunMode = 'local' | 'cloud' | 'mock';

export interface WorkflowRunsTable {
  id: Generated<string>;
  organization_id: string;
  task_id: string;
  run_number: number;
  status: RunStatus;
  current_stage: string | null;
  provider: string | null;
  model: string | null;
  mode: RunMode;
  state_version: Generated<number>;
  budget: Json<JsonObject>;
  usage_summary: Json<JsonObject>;
  started_at: NullableTimestamp;
  ended_at: NullableTimestamp;
  error_code: string | null;
  error_summary: string | null;
  repository_id: string;
  snapshot_id: string | null;
  base_branch: string | null;
  created_by: string;
  retry_of_run_id: string | null;
  checkpoint: Json<JsonObject>;
  cancel_requested_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RunStateTransitionsTable {
  id: Generated<number>;
  run_id: string;
  from_status: string | null;
  to_status: string;
  state_version: number;
  actor_type: 'user' | 'system' | 'worker';
  actor_user_id: string | null;
  reason: string | null;
  created_at: Generated<Date>;
}

export interface RunEventsTable {
  id: Generated<number>;
  run_id: string;
  organization_id: string;
  event_type: string;
  payload: Json<JsonObject>;
  created_at: Generated<Date>;
}

export interface RunPlansTable {
  id: Generated<string>;
  run_id: string;
  version: number;
  content: Json<JsonObject>;
  content_hash: string;
  source: 'agent' | 'user_edit';
  created_by: string | null;
  created_at: Generated<Date>;
}

export type AgentStepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface AgentStepsTable {
  id: Generated<string>;
  run_id: string;
  sequence_number: number;
  agent_type: string;
  status: AgentStepStatus;
  prompt_version: string | null;
  input_redacted: NullableJson<JsonObject>;
  output_redacted: NullableJson<JsonObject>;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  started_at: NullableTimestamp;
  ended_at: NullableTimestamp;
  error_code: string | null;
  created_at: Generated<Date>;
}

export interface ToolExecutionsTable {
  id: Generated<string>;
  agent_step_id: string;
  tool_name: string;
  status: 'started' | 'succeeded' | 'failed' | 'cancelled';
  input_redacted: NullableJson<JsonObject>;
  output_redacted: NullableJson<JsonObject>;
  duration_ms: number | null;
  created_at: Generated<Date>;
}

export interface PatchesTable {
  id: Generated<string>;
  run_id: string;
  patch_object_key: string;
  patch_hash: string;
  base_commit_sha: string;
  changed_files: Generated<number>;
  additions: Generated<number>;
  deletions: Generated<number>;
  status: 'proposed' | 'validated' | 'applied' | 'rejected';
  attempt: Generated<number>;
  files_object_key: string | null;
  summary: string | null;
  validation: Json<JsonObject>;
  created_at: Generated<Date>;
}

export interface VerificationRunsTable {
  id: Generated<string>;
  run_id: string;
  profile_id: string;
  command_display: string;
  status: 'passed' | 'failed' | 'timed_out' | 'skipped' | 'error';
  exit_code: number | null;
  duration_ms: number | null;
  stdout_object_key: string | null;
  stderr_object_key: string | null;
  report_object_key: string | null;
  patch_id: string | null;
  attempt: Generated<number>;
  output_truncated: Generated<boolean>;
  image: string | null;
  created_at: Generated<Date>;
}

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface ReviewFindingsTable {
  id: Generated<string>;
  run_id: string;
  source: 'ai_review' | 'static_analysis' | 'security_scanner' | 'test';
  severity: FindingSeverity;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  title: string;
  description: string;
  evidence: Json<JsonObject>;
  status: Generated<'open' | 'accepted' | 'dismissed' | 'fixed'>;
  patch_id: string | null;
  disposition_by: string | null;
  disposition_comment: string | null;
  disposition_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface ApprovalsTable {
  id: Generated<string>;
  run_id: string;
  user_id: string;
  approval_type: 'plan' | 'pull_request' | 'other';
  decision: 'approved' | 'rejected';
  comment: string | null;
  subject_hash: string;
  created_at: Generated<Date>;
}

export interface PullRequestsTable {
  id: Generated<string>;
  run_id: string;
  provider: string;
  external_pr_id: number | null;
  pr_number: number;
  pr_url: string;
  head_branch: string;
  base_branch: string;
  created_at: Generated<Date>;
}

export interface UsageRecordsTable {
  id: Generated<string>;
  organization_id: string;
  run_id: string | null;
  provider: string;
  model: string;
  operation: string;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_microunits: number | null;
  duration_ms: number | null;
  created_at: Generated<Date>;
}

export interface AuditEventsTable {
  id: Generated<string>;
  organization_id: string | null;
  actor_user_id: string | null;
  actor_type: 'user' | 'system' | 'worker' | 'provider';
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  request_id: string | null;
  metadata_redacted: Json<JsonObject>;
  created_at: Generated<Date>;
}

export interface IdempotencyKeysTable {
  id: Generated<string>;
  user_id: string;
  organization_id: string | null;
  endpoint: string;
  idempotency_key: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: NullableJson<unknown>;
  created_at: Generated<Date>;
  expires_at: Timestamp;
}

export type IndexingJobStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';

export interface IndexingJobsTable {
  id: Generated<string>;
  organization_id: string;
  repository_id: string;
  snapshot_id: string | null;
  trigger: 'manual' | 'push' | 'initial' | 'retry';
  requested_ref: string | null;
  commit_sha: string | null;
  status: Generated<IndexingJobStatus>;
  stage: string | null;
  progress: Json<JsonObject>;
  attempts: Generated<number>;
  error_code: string | null;
  error_summary: string | null;
  requested_by: string | null;
  started_at: NullableTimestamp;
  ended_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  indexing_jobs: IndexingJobsTable;
  users: UsersTable;
  organizations: OrganizationsTable;
  memberships: MembershipsTable;
  sessions: SessionsTable;
  workspace_invitations: WorkspaceInvitationsTable;
  git_installations: GitInstallationsTable;
  repositories: RepositoriesTable;
  webhook_deliveries: WebhookDeliveriesTable;
  repository_snapshots: RepositorySnapshotsTable;
  repository_files: RepositoryFilesTable;
  code_chunks: CodeChunksTable;
  symbols: SymbolsTable;
  symbol_relationships: SymbolRelationshipsTable;
  knowledge_documents: KnowledgeDocumentsTable;
  knowledge_chunks: KnowledgeChunksTable;
  repository_questions: RepositoryQuestionsTable;
  engineering_tasks: EngineeringTasksTable;
  workflow_runs: WorkflowRunsTable;
  run_state_transitions: RunStateTransitionsTable;
  run_events: RunEventsTable;
  run_plans: RunPlansTable;
  agent_steps: AgentStepsTable;
  tool_executions: ToolExecutionsTable;
  patches: PatchesTable;
  verification_runs: VerificationRunsTable;
  review_findings: ReviewFindingsTable;
  approvals: ApprovalsTable;
  pull_requests: PullRequestsTable;
  usage_records: UsageRecordsTable;
  audit_events: AuditEventsTable;
  idempotency_keys: IdempotencyKeysTable;
}

export type User = Selectable<UsersTable>;
export type Organization = Selectable<OrganizationsTable>;
export type Repository = Selectable<RepositoriesTable>;
export type GitInstallation = Selectable<GitInstallationsTable>;
export type Snapshot = Selectable<RepositorySnapshotsTable>;
export type EngineeringTask = Selectable<EngineeringTasksTable>;
export type WorkflowRun = Selectable<WorkflowRunsTable>;
export type NewAuditEvent = Insertable<AuditEventsTable>;
export type RepositoryUpdate = Updateable<RepositoriesTable>;

/** Serialize a value for a jsonb column. Always use this; `pg` turns JS arrays into PG arrays. */
export function json(value: unknown): string {
  return JSON.stringify(value);
}
