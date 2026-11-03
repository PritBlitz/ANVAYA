import { z } from 'zod';
import { paginationQuery } from '../common/http.js';
import { PROFILE_IDS } from '../execution/profiles.js';

/** Relative path patterns: `dir/`, `*.ext`, `dir/**`, `path/file.ts`. No absolute paths or traversal. */
export const pathPattern = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..') && !/[\0\\]/.test(p), 'must be a relative path pattern without traversal');

export const repositorySettingsSchema = z
  .object({
    exclude_paths: z.array(pathPattern).max(100).optional(),
    max_file_bytes: z.number().int().min(1024).max(2 * 1024 * 1024).optional(),
    auto_index_on_push: z.boolean().optional(),
    /** Server-defined profile ids; empty = auto-detect. Arbitrary commands are never accepted. */
    verification_profiles: z.array(z.enum(PROFILE_IDS as [string, ...string[]])).max(8).optional(),
    /**
     * 'narrow' runs only the heuristically selected test files for profiles that support test
     * selection (node-test, python-pytest). Default 'off': every profile runs in full.
     */
    test_selection: z.enum(['off', 'narrow']).optional(),
  })
  .strict();
export type RepositorySettings = z.infer<typeof repositorySettingsSchema>;

export const DEFAULT_REPOSITORY_SETTINGS: Required<RepositorySettings> = {
  exclude_paths: [],
  max_file_bytes: 512 * 1024,
  auto_index_on_push: true,
  verification_profiles: [],
  test_selection: 'off',
};

export const createRepositoryBody = z
  .object({
    /** Optional when the `X-Workspace-Id` header is sent. */
    workspace_id: z.uuid().optional(),
    installation_id: z.uuid(),
    external_repository_id: z.number().int().positive(),
    /** Queue an initial index immediately (default true). */
    index: z.boolean().default(true),
  })
  .strict();

export const updateRepositoryBody = z
  .object({
    settings: repositorySettingsSchema.optional(),
    status: z.enum(['connected', 'disabled']).optional(),
  })
  .strict()
  .refine((v) => v.settings !== undefined || v.status !== undefined, 'at least one field is required');

export const listRepositoriesQuery = paginationQuery.extend({
  workspace_id: z.uuid().optional(),
  status: z.enum(['connected', 'disabled', 'disconnected']).optional(),
});

export const queueIndexBody = z
  .object({
    /** Branch name or full commit SHA; defaults to the default branch. */
    ref: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9._/-]+$/)
      .refine((r) => !r.includes('..'), 'invalid ref')
      .optional(),
  })
  .strict();
