-- 0010_templates_and_code_intelligence.sql
-- Work package B (releases/V1.md): workflow templates, call graph and
-- change-impact / test-selection support.
--
-- Numbered 0010 (not 0006) so it cannot collide with migrations added in
-- parallel by other work packages; the migrator orders by file name and does
-- not require contiguous numbers.

-- ---------------------------------------------------------------------------
-- Workspace-defined workflow templates (admin-managed, audited).
-- Built-in templates live in application code and have no rows here.
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  -- 'change' runs the full governed workflow; 'migration_plan' stops after the approved plan.
  workflow text NOT NULL CHECK (workflow IN ('change', 'migration_plan')),
  -- Prefill for the create-task form: { title_prefix, description_template, labels }.
  task_defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Budget ceilings (subset of the run budget); can only lower workspace limits.
  budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Verification profile ids the template allows; NULL = every applicable profile.
  allowed_profiles jsonb,
  -- Admin-authored planning guidance, sent to the planner as workspace policy (never repository content).
  planning_guidance jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
CREATE INDEX idx_workflow_templates_org ON workflow_templates(organization_id, status, key);

-- Tasks record the template they were created from as an immutable snapshot,
-- so later template edits never change the policy of an existing task.
ALTER TABLE engineering_tasks ADD COLUMN template_key text;
ALTER TABLE engineering_tasks ADD COLUMN template jsonb;
ALTER TABLE engineering_tasks ADD CONSTRAINT engineering_tasks_template_consistent
  CHECK ((template_key IS NULL) = (template IS NULL));

-- ---------------------------------------------------------------------------
-- Call graph and impact analysis read relationships by target and by type.
-- ---------------------------------------------------------------------------
CREATE INDEX idx_relationships_target ON symbol_relationships(target_symbol_id) WHERE target_symbol_id IS NOT NULL;
CREATE INDEX idx_relationships_snapshot_type ON symbol_relationships(snapshot_id, relationship_type);

-- ---------------------------------------------------------------------------
-- Heuristic test selection applied to a verification run (NULL = full profile).
-- Records which test files were selected and why, next to the deterministic result.
-- ---------------------------------------------------------------------------
ALTER TABLE verification_runs ADD COLUMN test_selection jsonb;
