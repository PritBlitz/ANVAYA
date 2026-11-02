-- 0001_initial_schema.sql
-- Canonical schema from DATABASE.md §4/§5 plus documented additive deviations
-- (see docs/backend/DATABASE_NOTES.md). Never edit after it has been applied;
-- add a new migration instead (the migrator enforces this with checksums).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE OR REPLACE FUNCTION anvaya_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Identity and tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text UNIQUE NOT NULL,
  email text UNIQUE NOT NULL,
  display_name text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  slug text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  created_by uuid REFERENCES users(id),
  plan_key text NOT NULL DEFAULT 'personal',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

-- Addition: server-side sessions. Only SHA-256 hashes of tokens are stored.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX idx_sessions_user ON sessions(user_id, created_at DESC);

-- Addition: workspace invitations (API_SPEC §2 POST /invitations).
CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','member','viewer')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_invitations_org ON workspace_invitations(organization_id, created_at DESC);
CREATE UNIQUE INDEX uq_invitations_pending_email
  ON workspace_invitations(organization_id, lower(email)) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Git integrations
-- ---------------------------------------------------------------------------
CREATE TABLE git_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('github')),
  external_installation_id bigint NOT NULL UNIQUE,
  account_login text NOT NULL,
  account_type text,
  granted_permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','disconnected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);

CREATE TABLE repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id uuid REFERENCES git_installations(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'github',
  external_repository_id bigint NOT NULL UNIQUE,
  owner text NOT NULL,
  name text NOT NULL,
  full_name text NOT NULL,
  default_branch text,
  visibility text CHECK (visibility IN ('public','private','internal')),
  status text NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected','disabled','disconnected')),
  indexing_status text NOT NULL DEFAULT 'pending'
    CHECK (indexing_status IN ('pending','queued','indexing','ready','partial','failed','disabled')),
  latest_indexed_commit_sha text,
  indexed_at timestamptz,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, full_name),
  UNIQUE (id, organization_id)
);

-- Addition: webhook delivery log for idempotency and replay protection.
CREATE TABLE webhook_deliveries (
  delivery_id text PRIMARY KEY,
  provider text NOT NULL DEFAULT 'github',
  event text NOT NULL,
  action text,
  external_installation_id bigint,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')),
  error_summary text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries(received_at DESC);

-- ---------------------------------------------------------------------------
-- Repository and index
-- ---------------------------------------------------------------------------
CREATE TABLE repository_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  branch_name text,
  archive_object_key text,
  archive_hash text,
  total_files integer NOT NULL DEFAULT 0,
  indexed_files integer NOT NULL DEFAULT 0,
  excluded_files integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('queued','processing','ready','partial','failed')),
  parser_version text,
  chunker_version text,
  -- Additions: progress/failure visibility and reuse lineage.
  failed_files integer NOT NULL DEFAULT 0,
  reused_files integer NOT NULL DEFAULT 0,
  embedding_model text,
  embedding_dimension integer,
  base_snapshot_id uuid REFERENCES repository_snapshots(id) ON DELETE SET NULL,
  language_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_summary text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, commit_sha)
);

CREATE TABLE repository_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path text NOT NULL,
  blob_sha text,
  content_hash text NOT NULL,
  language text,
  file_type text,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  line_count integer,
  is_excluded boolean NOT NULL DEFAULT false,
  exclusion_reason text,
  -- Addition: parse outcome so coverage is honest (FR-REP-009).
  parse_status text NOT NULL DEFAULT 'not_parsed'
    CHECK (parse_status IN ('parsed','unsupported_language','parse_error','not_parsed','excluded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, path)
);

CREATE TABLE code_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_file_id uuid NOT NULL REFERENCES repository_files(id) ON DELETE CASCADE,
  -- Additions: denormalized scope so tenant/repo/snapshot filters run before ranking.
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  start_line integer NOT NULL,
  end_line integer NOT NULL,
  symbol_name text,
  chunk_kind text,
  content text NOT NULL,
  content_hash text NOT NULL,
  language text,
  -- Deviation: nullable so a chunk stays lexically searchable if embedding fails.
  embedding vector(768),
  embedding_model text,
  embedding_version text,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, coalesce(symbol_name, '') || ' ' ||
      regexp_replace(content, '([a-z])([A-Z])|[_./\\-]', '\1 \2', 'g'))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_line > 0 AND end_line >= start_line),
  CHECK (embedding IS NULL OR (embedding_model IS NOT NULL AND embedding_version IS NOT NULL)),
  UNIQUE (repository_file_id, chunk_index)
);

CREATE TABLE symbols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
  repository_file_id uuid NOT NULL REFERENCES repository_files(id) ON DELETE CASCADE,
  symbol_key text NOT NULL,
  name text NOT NULL,
  qualified_name text,
  kind text NOT NULL,
  start_line integer NOT NULL,
  end_line integer NOT NULL,
  language text,
  signature text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, symbol_key)
);

CREATE TABLE symbol_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
  source_symbol_id uuid NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  target_symbol_id uuid REFERENCES symbols(id) ON DELETE SET NULL,
  relationship_type text NOT NULL,
  target_external_name text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repository_id uuid REFERENCES repositories(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('readme','architecture','decision','issue','pull_request','engineering_note')),
  external_id text,
  title text NOT NULL,
  content_object_key text,
  content_hash text NOT NULL,
  source_url text,
  indexed_at timestamptz,
  -- Addition: author for user-created notes.
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tasks and workflow runs
-- ---------------------------------------------------------------------------
CREATE TABLE engineering_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  source_type text NOT NULL CHECK (source_type IN ('github_issue','pull_request','failing_check','manual')),
  external_number integer,
  title text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','active','completed','failed','cancelled','archived')),
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  -- Composite FK: a task can never reference another tenant's repository.
  FOREIGN KEY (repository_id, organization_id) REFERENCES repositories(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  run_number integer NOT NULL,
  status text NOT NULL CHECK (status IN (
    'queued','retrieving_context','investigating','planning','awaiting_plan_approval',
    'preparing_workspace','implementing','verifying','reviewing','awaiting_pr_approval',
    'creating_pr','completed','failed','cancelled','timed_out','rejected','completed_without_pr')),
  current_stage text,
  provider text,
  model text,
  mode text NOT NULL DEFAULT 'local' CHECK (mode IN ('local','cloud','mock')),
  state_version integer NOT NULL DEFAULT 1,
  budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  error_code text,
  error_summary text,
  -- Additions: scope, durable checkpoint, cancellation signal.
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  snapshot_id uuid REFERENCES repository_snapshots(id) ON DELETE SET NULL,
  base_branch text,
  created_by uuid NOT NULL REFERENCES users(id),
  retry_of_run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, run_number),
  FOREIGN KEY (task_id, organization_id) REFERENCES engineering_tasks(id, organization_id) ON DELETE CASCADE
);

-- Addition: auditable state transitions (ARCHITECTURE §6).
CREATE TABLE run_state_transitions (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  state_version integer NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user','system','worker')),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_run_transitions_run ON run_state_transitions(run_id, id);

-- Addition: durable event log / outbox; SSE ids are this table's ids.
CREATE TABLE run_events (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_run_events_run ON run_events(run_id, id);

-- Addition: versioned plans; approvals bind to content_hash.
CREATE TABLE run_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  source text NOT NULL CHECK (source IN ('agent','user_edit')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, version)
);

CREATE TABLE agent_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  sequence_number integer NOT NULL,
  agent_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','skipped','cancelled')),
  prompt_version text,
  input_redacted jsonb,
  output_redacted jsonb,
  provider text,
  model text,
  input_tokens integer,
  output_tokens integer,
  duration_ms bigint,
  started_at timestamptz,
  ended_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence_number)
);

CREATE TABLE tool_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_step_id uuid NOT NULL REFERENCES agent_steps(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('started','succeeded','failed','cancelled')),
  input_redacted jsonb,
  output_redacted jsonb,
  duration_ms bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  patch_object_key text NOT NULL,
  patch_hash text NOT NULL,
  base_commit_sha text NOT NULL,
  changed_files integer NOT NULL DEFAULT 0,
  additions integer NOT NULL DEFAULT 0,
  deletions integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('proposed','validated','applied','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  profile_id text NOT NULL,
  command_display text NOT NULL,
  status text NOT NULL CHECK (status IN ('passed','failed','timed_out','skipped','error')),
  exit_code integer,
  duration_ms bigint,
  stdout_object_key text,
  stderr_object_key text,
  report_object_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE review_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('ai_review','static_analysis','security_scanner','test')),
  severity text NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  file_path text,
  start_line integer,
  end_line integer,
  title text NOT NULL,
  description text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','accepted','dismissed','fixed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  approval_type text NOT NULL CHECK (approval_type IN ('plan','pull_request','other')),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  comment text,
  -- Addition: approvals are bound to the exact plan/patch hash (SECURITY §8).
  subject_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid UNIQUE NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_pr_id bigint,
  pr_number integer NOT NULL,
  pr_url text NOT NULL,
  head_branch text NOT NULL,
  base_branch text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Usage, audit, idempotency
-- ---------------------------------------------------------------------------
CREATE TABLE usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  operation text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_microunits bigint,
  duration_ms bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user','system','worker','provider')),
  action text NOT NULL,
  resource_type text,
  resource_id text,
  request_id text,
  metadata_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Audit rows are append-only. The only permitted update is the FK-driven
-- nulling of organization_id / actor_user_id when the referenced row is deleted.
CREATE OR REPLACE FUNCTION anvaya_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_events is append-only';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
     OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.metadata_redacted IS DISTINCT FROM OLD.metadata_redacted
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.organization_id IS NOT NULL AND NEW.organization_id IS DISTINCT FROM OLD.organization_id)
     OR (NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id) THEN
    RAISE EXCEPTION 'audit_events is append-only';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION anvaya_audit_append_only();

-- Addition: idempotency records (API_SPEC §1).
CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 255),
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress','completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (user_id, endpoint, idempotency_key)
);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION anvaya_set_updated_at();
CREATE TRIGGER trg_orgs_updated BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION anvaya_set_updated_at();
CREATE TRIGGER trg_installations_updated BEFORE UPDATE ON git_installations FOR EACH ROW EXECUTE FUNCTION anvaya_set_updated_at();
CREATE TRIGGER trg_repositories_updated BEFORE UPDATE ON repositories FOR EACH ROW EXECUTE FUNCTION anvaya_set_updated_at();
CREATE TRIGGER trg_tasks_updated BEFORE UPDATE ON engineering_tasks FOR EACH ROW EXECUTE FUNCTION anvaya_set_updated_at();
CREATE TRIGGER trg_runs_updated BEFORE UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION anvaya_set_updated_at();

-- ---------------------------------------------------------------------------
-- Required indexes (DATABASE.md §5) + additions
-- ---------------------------------------------------------------------------
CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_repositories_org ON repositories(organization_id);
CREATE INDEX idx_snapshots_repo_created ON repository_snapshots(repository_id, created_at DESC);
CREATE INDEX idx_files_repo_path ON repository_files(repository_id, path);
CREATE INDEX idx_chunks_file ON code_chunks(repository_file_id);
CREATE INDEX idx_symbols_snapshot_name ON symbols(snapshot_id, name);
CREATE INDEX idx_tasks_org_status ON engineering_tasks(organization_id, status);
CREATE INDEX idx_runs_task_created ON workflow_runs(task_id, created_at DESC);
CREATE INDEX idx_runs_org_status ON workflow_runs(organization_id, status);
CREATE INDEX idx_steps_run_sequence ON agent_steps(run_id, sequence_number);
CREATE INDEX idx_tool_steps ON tool_executions(agent_step_id);
CREATE INDEX idx_verification_run ON verification_runs(run_id, created_at);
CREATE INDEX idx_findings_run_severity ON review_findings(run_id, severity);
CREATE INDEX idx_usage_org_created ON usage_records(organization_id, created_at DESC);
CREATE INDEX idx_audit_org_created ON audit_events(organization_id, created_at DESC);

CREATE INDEX idx_installations_org ON git_installations(organization_id);
CREATE INDEX idx_files_snapshot ON repository_files(snapshot_id, path);
CREATE INDEX idx_chunks_snapshot ON code_chunks(snapshot_id);
CREATE INDEX idx_chunks_search ON code_chunks USING gin (search_vector);
CREATE INDEX idx_symbols_file ON symbols(repository_file_id);
CREATE INDEX idx_relationships_source ON symbol_relationships(source_symbol_id);
CREATE INDEX idx_knowledge_repo ON knowledge_documents(repository_id, created_at DESC);
CREATE INDEX idx_tasks_repo_created ON engineering_tasks(repository_id, created_at DESC);
CREATE INDEX idx_tasks_org_created ON engineering_tasks(organization_id, created_at DESC, id DESC);
CREATE INDEX idx_approvals_run ON approvals(run_id, created_at);
CREATE INDEX idx_patches_run ON patches(run_id, created_at DESC);
CREATE INDEX idx_audit_org_action ON audit_events(organization_id, action, created_at DESC);
