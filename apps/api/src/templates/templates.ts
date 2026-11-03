import { z } from 'zod';
import type { JsonObject } from '../database/types.js';
import { PROFILE_IDS } from '../execution/profiles.js';
import { type RunBudget, runBudgetSchema } from '../runs/run.schemas.js';

/**
 * Workflow templates (ROADMAP §2 "team and enterprise"; releases/V1.md work package B).
 *
 * A template is application/workspace policy, never repository content:
 * - it prefills the create-task form (title prefix, description scaffold, labels);
 * - it can only lower run budgets below the workspace ceilings;
 * - it can restrict which server-defined verification profiles run;
 * - it adds planning guidance that the planner receives as trusted policy
 *   (the AI service's system rules still take precedence over it);
 * - `migration_plan` templates stop the run once the plan is approved: nothing is executed.
 *
 * Built-in templates live here; workspace templates are rows in `workflow_templates`.
 * A task stores an immutable snapshot of the template it was created from.
 */

export const TEMPLATE_WORKFLOWS = ['change', 'migration_plan'] as const;
export type TemplateWorkflow = (typeof TEMPLATE_WORKFLOWS)[number];

const guidanceItem = z.string().trim().min(1).max(300);
const label = z.string().trim().min(1).max(50);

export const taskDefaultsSchema = z
  .object({
    title_prefix: z.string().trim().max(60).nullable().default(null),
    description_template: z.string().max(4000).nullable().default(null),
    labels: z.array(label).max(10).default([]),
  })
  .strict();

export const templateBudgetSchema = runBudgetSchema.partial();

export const templateKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, 'lowercase letters, digits and underscores; 2–40 characters, starting with a letter');

export interface TemplateDefinition {
  key: string;
  name: string;
  description: string;
  workflow: TemplateWorkflow;
  task_defaults: z.infer<typeof taskDefaultsSchema>;
  budget: Partial<RunBudget>;
  /** Verification profile ids the template allows; null = every applicable profile. */
  allowed_profiles: string[] | null;
  planning_guidance: string[];
}

export const BUILTIN_TEMPLATES: readonly TemplateDefinition[] = [
  {
    key: 'bug_fix',
    name: 'Bug fix',
    description: 'Find the root cause of a defect and fix it with a regression test.',
    workflow: 'change',
    task_defaults: {
      title_prefix: 'Fix: ',
      description_template: '## Observed behaviour\n\n## Expected behaviour\n\n## Steps to reproduce\n',
      labels: ['bug'],
    },
    budget: { max_changed_files: 5, max_repair_attempts: 2 },
    allowed_profiles: null,
    planning_guidance: [
      'Identify the root cause before proposing a change, and cite the evidence that shows it.',
      'Keep the change minimal and limited to the defect; no unrelated refactoring.',
      'Include a regression test that fails before the fix and passes after it, where the repository has a test framework.',
    ],
  },
  {
    key: 'add_tests',
    name: 'Add tests',
    description: 'Add or extend tests for existing behaviour without changing it.',
    workflow: 'change',
    task_defaults: { title_prefix: 'Add tests: ', description_template: '## Behaviour to cover\n\n## Known edge cases\n', labels: ['tests'] },
    budget: { max_changed_files: 6, max_repair_attempts: 2 },
    allowed_profiles: null,
    planning_guidance: [
      'Add or extend tests only. Do not change production code; if a test cannot be written without a change, list that as a risk instead.',
      "Follow the repository's existing test framework, file layout and naming conventions.",
      'Cover the behaviour named in the task, including edge cases and failure paths.',
    ],
  },
  {
    key: 'refactor',
    name: 'Refactor',
    description: 'Restructure code while preserving its observable behaviour.',
    workflow: 'change',
    task_defaults: { title_prefix: 'Refactor: ', description_template: '## Current structure\n\n## Target structure\n\n## Behaviour that must not change\n', labels: ['refactor'] },
    budget: { max_changed_files: 8, max_repair_attempts: 1 },
    allowed_profiles: null,
    planning_guidance: [
      'Preserve externally observable behaviour; list any behaviour change as a risk.',
      'Name the existing tests that cover the code being restructured; they are the safety net.',
      'Order the steps so that each one leaves the code in a working state.',
    ],
  },
  {
    key: 'dependency_upgrade',
    name: 'Dependency upgrade',
    description: 'Upgrade a dependency and adapt the code that uses its changed APIs.',
    workflow: 'change',
    task_defaults: { title_prefix: 'Upgrade ', description_template: '## Dependency and target version\n\n## Reason for the upgrade\n', labels: ['dependencies'] },
    budget: { max_changed_files: 6, max_repair_attempts: 2 },
    allowed_profiles: null,
    planning_guidance: [
      'Identify every manifest and lockfile that pins the dependency, and the code that uses its changed APIs.',
      'List possible breaking changes as risks; do not state changelog details that are not in the evidence.',
      'Plan verification that exercises the code paths that use the dependency.',
    ],
  },
  {
    key: 'migration_plan',
    name: 'Migration plan',
    description: 'Plan-only: an evidence-backed migration plan with ordered steps, risks and rollback. Nothing is executed.',
    workflow: 'migration_plan',
    task_defaults: { title_prefix: 'Migration plan: ', description_template: '## What is being migrated\n\n## From → to\n\n## Constraints (downtime, data, compatibility)\n', labels: ['migration'] },
    budget: { max_repair_attempts: 0 },
    allowed_profiles: [],
    planning_guidance: [
      'This workflow produces a plan only; no code is changed or executed.',
      'Order the steps so the system stays deployable after each one, and give every step a rollback.',
      'List the affected areas with the evidence that shows them, and state what the evidence does not cover.',
    ],
  },
];

export const BUILTIN_KEYS: ReadonlySet<string> = new Set(BUILTIN_TEMPLATES.map((t) => t.key));

export function builtinTemplate(key: string): TemplateDefinition | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.key === key);
}

const profileId = z.enum(PROFILE_IDS as [string, ...string[]]);

export const createTemplateBody = z
  .object({
    key: templateKey.refine((k) => !BUILTIN_KEYS.has(k), 'this key is reserved by a built-in template'),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(''),
    workflow: z.enum(TEMPLATE_WORKFLOWS),
    task_defaults: taskDefaultsSchema.default({ title_prefix: null, description_template: null, labels: [] }),
    budget: templateBudgetSchema.default({}),
    allowed_profiles: z.array(profileId).max(PROFILE_IDS.length).nullable().default(null),
    planning_guidance: z.array(guidanceItem).max(8).default([]),
  })
  .strict();

export const updateTemplateBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    workflow: z.enum(TEMPLATE_WORKFLOWS).optional(),
    task_defaults: taskDefaultsSchema.optional(),
    budget: templateBudgetSchema.optional(),
    allowed_profiles: z.array(profileId).max(PROFILE_IDS.length).nullable().optional(),
    planning_guidance: z.array(guidanceItem).max(8).optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'at least one field is required');

export const listTemplatesQuery = z.object({ include_archived: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });

/** Immutable copy stored on the task (`engineering_tasks.template`). */
export interface TemplateSnapshot extends TemplateDefinition {
  source: 'builtin' | 'workspace';
  template_id: string | null;
  version: number;
}

const snapshotSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  workflow: z.enum(TEMPLATE_WORKFLOWS),
  task_defaults: taskDefaultsSchema,
  budget: templateBudgetSchema,
  allowed_profiles: z.array(z.string()).nullable(),
  planning_guidance: z.array(z.string()),
  source: z.enum(['builtin', 'workspace']),
  template_id: z.string().nullable(),
  version: z.number().int(),
});

/** Reads a stored snapshot; unknown or malformed content means "no template". */
export function parseSnapshot(value: unknown): TemplateSnapshot | null {
  const parsed = snapshotSchema.safeParse(value);
  return parsed.success ? (parsed.data) : null;
}

export function toSnapshotJson(s: TemplateSnapshot): JsonObject {
  return { ...s };
}

/** Lowers each budget field to the template ceiling; never raises one (server policy wins). */
export function applyTemplateBudget(budget: RunBudget, template: Pick<TemplateDefinition, 'budget'> | null): RunBudget {
  if (!template) return budget;
  const out = { ...budget };
  for (const k of Object.keys(out) as Array<keyof RunBudget>) {
    const ceiling = template.budget[k];
    if (typeof ceiling === 'number') out[k] = Math.min(out[k], ceiling);
  }
  return out;
}

/** Intersects auto-detected/configured profiles with what the template allows. */
export function filterProfilesByTemplate<P extends { id: string }>(profiles: P[], template: Pick<TemplateDefinition, 'allowed_profiles' | 'name'> | null): { allowed: P[]; excluded: Array<{ profile_id: string; reason: string }> } {
  if (!template || template.allowed_profiles === null) return { allowed: profiles, excluded: [] };
  const allow = new Set(template.allowed_profiles);
  return {
    allowed: profiles.filter((p) => allow.has(p.id)),
    excluded: profiles.filter((p) => !allow.has(p.id)).map((p) => ({ profile_id: p.id, reason: `Not allowed by the '${template.name}' template` })),
  };
}

/** Trusted planner context for a template: policy text owned by the application or a workspace admin. */
export function planningContext(template: TemplateSnapshot | null): JsonObject | null {
  if (!template) return null;
  return {
    key: template.key,
    name: template.name,
    workflow: template.workflow,
    source: template.source === 'builtin' ? 'application' : 'workspace_admin',
    guidance: template.planning_guidance,
  };
}

/** True for runs started from a plan-only (migration plan) template; read from the run's own checkpoint. */
export function isPlanOnly(run: { checkpoint: JsonObject }): boolean {
  const t = run.checkpoint.template;
  return typeof t === 'object' && t !== null && (t as { workflow?: unknown }).workflow === 'migration_plan';
}
