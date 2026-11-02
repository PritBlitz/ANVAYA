import { z } from 'zod';

export const roleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export const invitableRoleSchema = z.enum(['admin', 'member', 'viewer']);

const slugSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/, 'lowercase letters, digits and inner hyphens only');

export const retentionSettingsSchema = z
  .object({
    snapshot_days: z.number().int().min(1).max(3650).optional(),
    run_artifact_days: z.number().int().min(1).max(3650).optional(),
    log_days: z.number().int().min(1).max(3650).optional(),
  })
  .strict();

/** Workspace-wide run budget ceilings. Client-requested budgets are clamped to these. */
export const runBudgetLimitsSchema = z
  .object({
    max_steps: z.number().int().min(1).max(32).optional(),
    max_input_tokens: z.number().int().min(512).max(200_000).optional(),
    max_output_tokens: z.number().int().min(128).max(32_000).optional(),
    max_duration_seconds: z.number().int().min(30).max(7200).optional(),
    max_changed_files: z.number().int().min(1).max(100).optional(),
    max_repair_attempts: z.number().int().min(0).max(5).optional(),
  })
  .strict();

export const workspaceSettingsSchema = z
  .object({
    retention: retentionSettingsSchema.optional(),
    run_budget_limits: runBudgetLimitsSchema.optional(),
  })
  .strict();

export const createWorkspaceBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: slugSchema.optional(),
  })
  .strict();

export const updateWorkspaceBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    settings: workspaceSettingsSchema.optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.settings !== undefined, 'at least one field is required');

export const inviteBody = z
  .object({
    email: z.email().max(320),
    role: invitableRoleSchema,
  })
  .strict();

export const acceptInvitationBody = z.object({ token: z.string().min(20).max(128) }).strict();

export const changeRoleBody = z.object({ role: roleSchema }).strict();

export const workspaceView = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  plan_key: z.string(),
  role: roleSchema,
  settings: workspaceSettingsSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const memberView = z.object({
  user_id: z.uuid(),
  email: z.string(),
  display_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  role: roleSchema,
  joined_at: z.iso.datetime(),
});

export const invitationView = z.object({
  id: z.uuid(),
  email: z.string(),
  role: invitableRoleSchema,
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  expires_at: z.iso.datetime(),
  created_at: z.iso.datetime(),
});

export const createdInvitationView = invitationView.extend({
  /** Returned exactly once. Share out-of-band; only its hash is stored. */
  token: z.string(),
  accept_url: z.string(),
});

export type CreateWorkspaceBody = z.infer<typeof createWorkspaceBody>;
export type UpdateWorkspaceBody = z.infer<typeof updateWorkspaceBody>;
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
