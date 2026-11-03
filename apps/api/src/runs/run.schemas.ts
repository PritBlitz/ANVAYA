import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../common/crypto.js';
import { paginationQuery } from '../common/http.js';
import type { RunStatus } from '../database/types.js';
import { pathPattern } from '../repositories/repositories.schemas.js';
import { TRANSITIONS } from './state-machine.js';

const shortText = z.string().trim().min(1).max(500);
const relPath = pathPattern.refine((p) => !p.includes('*'), 'must be a file path, not a pattern');

/** Engineering plan (AI_WORKFLOW §4.2). Used for model output and for human edits. */
export const planSchema = z
  .object({
    objective: shortText,
    assumptions: z.array(shortText).max(10).default([]),
    steps: z
      .array(
        z
          .object({
            id: z.string().regex(/^step-\d{1,3}$/),
            description: shortText,
            files: z.array(relPath).max(16).default([]),
            verification: z.array(shortText).max(8).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    files_to_modify: z.array(relPath).max(32).default([]),
    tests: z.array(shortText).max(12).default([]),
    risks: z.array(shortText).max(10).default([]),
    out_of_scope: z.array(shortText).max(10).default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ids = new Set<string>();
    for (const s of p.steps) {
      if (ids.has(s.id)) ctx.addIssue({ code: 'custom', path: ['steps'], message: `duplicate step id ${s.id}` });
      ids.add(s.id);
    }
  });
export type Plan = z.infer<typeof planSchema>;

export function planHash(plan: Plan): string {
  return `sha256:${sha256Hex(canonicalJson(plan))}`;
}

export const investigationSchema = z.object({
  summary: z.string().min(1).max(4000),
  findings: z.array(z.object({ claim: z.string().max(500), evidence_ids: z.array(z.string()).max(8), kind: z.enum(['observed', 'inferred']) })).max(12),
  hypotheses: z.array(z.string().max(500)).max(8),
  unknowns: z.array(z.string().max(500)).max(8),
  candidate_files: z.array(z.string().max(500)).max(16),
});
export type Investigation = z.infer<typeof investigationSchema>;

export const runBudgetSchema = z
  .object({
    max_steps: z.number().int().min(1).max(32),
    max_input_tokens: z.number().int().min(512).max(200_000),
    max_output_tokens: z.number().int().min(128).max(32_000),
    max_duration_seconds: z.number().int().min(30).max(7200),
    max_changed_files: z.number().int().min(1).max(100),
    max_repair_attempts: z.number().int().min(0).max(5),
  })
  .strict();
export type RunBudget = z.infer<typeof runBudgetSchema>;

/** Operational defaults for constrained local development (AI_WORKFLOW §9). */
export const DEFAULT_RUN_BUDGET: RunBudget = {
  max_steps: 8,
  max_input_tokens: 6000,
  max_output_tokens: 1024,
  max_duration_seconds: 900,
  max_changed_files: 8,
  max_repair_attempts: 1,
};

export const TASK_SOURCE_TYPES = ['manual', 'github_issue', 'pull_request', 'failing_check'] as const;

export const createTaskBody = z
  .object({
    source_type: z.enum(TASK_SOURCE_TYPES),
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().min(1).max(20_000).optional(),
    /** Issue number (`github_issue`) or pull request number (`pull_request`). */
    external_number: z.number().int().positive().max(2_147_483_647).optional(),
    /** GitHub check run id (`failing_check`). */
    check_run_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    /** `pull_request` only: also import the first review comments as untrusted context. */
    include_review_comments: z.boolean().optional(),
    labels: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.source_type === 'manual' && (!b.title || !b.description)) ctx.addIssue({ code: 'custom', path: ['title'], message: 'title and description are required for manual tasks' });
    if ((b.source_type === 'github_issue' || b.source_type === 'pull_request') && !b.external_number) {
      ctx.addIssue({ code: 'custom', path: ['external_number'], message: `required for ${b.source_type} tasks` });
    }
    if (b.source_type === 'failing_check' && b.external_number !== undefined) ctx.addIssue({ code: 'custom', path: ['external_number'], message: 'use check_run_id for failing_check tasks' });
    if (b.source_type === 'failing_check' && !b.check_run_id) ctx.addIssue({ code: 'custom', path: ['check_run_id'], message: 'required for failing_check tasks' });
    if (b.source_type !== 'failing_check' && b.check_run_id !== undefined) ctx.addIssue({ code: 'custom', path: ['check_run_id'], message: 'only accepted for failing_check tasks' });
    if (b.source_type !== 'pull_request' && b.include_review_comments !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['include_review_comments'], message: 'only accepted for pull_request tasks' });
    }
  });

// Response shapes of imported task context (task-sources.ts). Untrusted content: render as text.
const prContextSchema = z
  .object({
    state: z.string(),
    draft: z.boolean(),
    merged: z.boolean(),
    head_branch: z.string(),
    head_sha: z.string(),
    base_branch: z.string(),
    base_sha: z.string(),
    changed_files: z.array(z.object({ path: z.string(), status: z.string(), additions: z.number().int(), deletions: z.number().int() })),
    changed_files_total: z.number().int(),
    changed_files_truncated: z.boolean(),
    review_comments: z.array(z.object({ path: z.string().nullable(), line: z.number().int().nullable(), author: z.string().nullable(), body: z.string() })),
    review_comments_truncated: z.boolean(),
  })
  .strict();
const checkContextSchema = z
  .object({
    check_name: z.string(),
    app: z.string().nullable(),
    conclusion: z.string(),
    head_sha: z.string(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    pull_request_numbers: z.array(z.number().int()),
    output_title: z.string().nullable(),
    annotations: z.array(
      z.object({ path: z.string(), start_line: z.number().int().nullable(), end_line: z.number().int().nullable(), level: z.string().nullable(), title: z.string().nullable(), message: z.string() }),
    ),
    annotations_total: z.number().int(),
    annotations_truncated: z.boolean(),
  })
  .strict();
/** `source_context`: pull-request metadata, failing-check metadata, or `{}` (manual and issue tasks). */
export const taskSourceContextSchema = z.union([prContextSchema, checkContextSchema, z.object({}).strict()]);

export const failingCheckView = z.object({
  ref: z.string(),
  check_runs: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      conclusion: z.string(),
      head_sha: z.string(),
      html_url: z.string().nullable(),
      completed_at: z.string().nullable(),
      app: z.string().nullable(),
    }),
  ),
});

/** `GET /repositories/:id/failing-checks`: a branch name or a commit SHA; defaults to the default branch. */
export const failingChecksQuery = z.object({
  ref: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._/-]+$/)
    .refine((b) => !b.includes('..') && !b.startsWith('/') && !b.endsWith('/'))
    .optional(),
});

export const updateTaskBody = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().min(1).max(20_000).optional(),
    labels: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    status: z.enum(['open', 'archived']).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'at least one field is required');

const runStatusEnum = z.enum(Object.keys(TRANSITIONS) as [RunStatus, ...RunStatus[]]);

/** `GET /runs` (GAP-05): `status` may repeat (`?status=a&status=b`). */
export const listRunsQuery = paginationQuery.extend({
  workspace_id: z.uuid().optional(),
  repository_id: z.uuid().optional(),
  task_id: z.uuid().optional(),
  status: z
    .union([runStatusEnum, z.array(runStatusEnum).max(20)])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
});

export const listTasksQuery = paginationQuery.extend({
  workspace_id: z.uuid().optional(),
  repository_id: z.uuid().optional(),
  status: z.enum(['open', 'active', 'completed', 'failed', 'cancelled', 'archived']).optional(),
});

export const startRunBody = z
  .object({
    mode: z.enum(['local', 'cloud', 'mock']).optional(),
    base_branch: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9._/-]+$/)
      .refine((b) => !b.includes('..'))
      .optional(),
    budgets: runBudgetSchema.partial().optional(),
  })
  .strict();

export const planApprovalBody = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    comment: z.string().max(2000).optional(),
    /** Hash of the plan version the human reviewed. Required to approve. */
    plan_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  })
  .strict()
  .refine((b) => b.decision === 'rejected' || b.plan_hash !== undefined, { message: 'plan_hash is required to approve', path: ['plan_hash'] });

export const editPlanBody = z
  .object({
    plan: z.unknown(),
    /** Optimistic concurrency: the hash of the version being edited. */
    base_plan_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();
