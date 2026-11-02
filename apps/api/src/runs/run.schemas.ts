import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../common/crypto.js';
import { paginationQuery } from '../common/http.js';
import { pathPattern } from '../repositories/repositories.schemas.js';

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

export const createTaskBody = z
  .object({
    source_type: z.enum(['manual', 'github_issue']),
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().min(1).max(20_000).optional(),
    external_number: z.number().int().positive().optional(),
    labels: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.source_type === 'manual' && (!b.title || !b.description)) ctx.addIssue({ code: 'custom', path: ['title'], message: 'title and description are required for manual tasks' });
    if (b.source_type === 'github_issue' && !b.external_number) ctx.addIssue({ code: 'custom', path: ['external_number'], message: 'required for github_issue tasks' });
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

export const listTasksQuery = paginationQuery.extend({
  workspace_id: z.uuid(),
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
