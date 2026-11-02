-- 0002_webhook_replay_and_jobs.sql
-- Replay protection: the webhook HMAC covers only the body, not the delivery-id
-- header, so a captured payload could be replayed under a new delivery id.
-- Deduplicate on payload hash as well.
CREATE INDEX idx_webhook_deliveries_payload_hash ON webhook_deliveries(payload_hash, received_at DESC);

-- Durable record of indexing jobs so status survives Redis loss and failures are visible.
CREATE TABLE indexing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  snapshot_id uuid REFERENCES repository_snapshots(id) ON DELETE SET NULL,
  trigger text NOT NULL CHECK (trigger IN ('manual','push','initial','retry')),
  requested_ref text,
  commit_sha text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled')),
  stage text,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  error_summary text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_indexing_jobs_repo_created ON indexing_jobs(repository_id, created_at DESC);
-- At most one active indexing job per repository.
CREATE UNIQUE INDEX uq_indexing_jobs_active ON indexing_jobs(repository_id) WHERE status IN ('queued','running');
CREATE TRIGGER trg_indexing_jobs_updated BEFORE UPDATE ON indexing_jobs FOR EACH ROW EXECUTE FUNCTION anvaya_set_updated_at();
