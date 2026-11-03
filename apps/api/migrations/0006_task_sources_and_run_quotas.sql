-- 0006_task_sources_and_run_quotas.sql — pull-request and failing-check tasks
-- (FR-WF-001, FR-GIT-006) and workspace run quotas (FR-OBS-004).
--
-- engineering_tasks.source_type already allows 'pull_request' and 'failing_check'
-- (0001). A check run id exceeds int4, so it is kept as text in external_id;
-- source_context holds the bounded, redacted metadata imported from GitHub
-- (branches, changed files, check name/conclusion, annotation excerpts). It is
-- untrusted repository content and is only ever rendered as data.

ALTER TABLE engineering_tasks
  ADD COLUMN external_id text,
  ADD COLUMN source_url text,
  ADD COLUMN source_context jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE engineering_tasks
  ADD CONSTRAINT engineering_tasks_external_id_len CHECK (external_id IS NULL OR length(external_id) <= 64),
  ADD CONSTRAINT engineering_tasks_source_url_len CHECK (source_url IS NULL OR length(source_url) <= 2048),
  ADD CONSTRAINT engineering_tasks_source_context_size CHECK (pg_column_size(source_context) <= 131072);

-- Daily run quota: count of a workspace's runs created since UTC midnight.
CREATE INDEX IF NOT EXISTS idx_runs_org_created ON workflow_runs(organization_id, created_at DESC);
