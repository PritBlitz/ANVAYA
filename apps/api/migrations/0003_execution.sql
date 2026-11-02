-- 0003_execution.sql — execution plane, verification and review bookkeeping.

ALTER TABLE patches
  ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  ADD COLUMN files_object_key text,
  ADD COLUMN summary text,
  ADD COLUMN validation jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX uq_patches_run_attempt ON patches(run_id, attempt);

ALTER TABLE verification_runs
  ADD COLUMN patch_id uuid REFERENCES patches(id) ON DELETE SET NULL,
  ADD COLUMN attempt integer NOT NULL DEFAULT 1,
  ADD COLUMN output_truncated boolean NOT NULL DEFAULT false,
  ADD COLUMN image text;
CREATE INDEX idx_verification_patch ON verification_runs(patch_id);

ALTER TABLE review_findings
  ADD COLUMN patch_id uuid REFERENCES patches(id) ON DELETE SET NULL,
  ADD COLUMN disposition_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN disposition_comment text,
  ADD COLUMN disposition_at timestamptz;
