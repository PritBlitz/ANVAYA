import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AppError, Errors } from '../common/errors.js';
import { DatabaseService } from '../database/database.service.js';
import { json, type RunMode } from '../database/types.js';
import { AccessService } from '../workspaces/access.service.js';
import { AiServiceError } from './ai-client.js';

export const DATA_CATEGORIES = ['source_code', 'documentation', 'issue_text', 'diffs', 'test_output'] as const;

export const aiPolicySchema = z
  .object({
    default_mode: z.enum(['local', 'mock', 'cloud']),
    allowed_modes: z.array(z.enum(['local', 'mock', 'cloud'])).min(1).max(3),
    cloud: z
      .object({
        enabled: z.boolean(),
        provider: z.string().max(50).nullable(),
        model: z.string().max(100).nullable(),
        /** Data categories the workspace has agreed may be sent to the hosted provider (FR-AI-008). */
        data_categories: z.array(z.enum(DATA_CATEGORIES)).max(DATA_CATEGORIES.length),
      })
      .strict(),
    limits: z
      .object({
        max_input_tokens: z.number().int().min(1024).max(200_000),
        max_output_tokens: z.number().int().min(128).max(32_000),
        request_timeout_seconds: z.number().int().min(10).max(1800),
      })
      .strict(),
  })
  .strict();
export type AiPolicy = z.infer<typeof aiPolicySchema>;

/** Local-first, no cloud. CPU-friendly limits (AI_WORKFLOW §9). */
export const DEFAULT_AI_POLICY: AiPolicy = {
  default_mode: 'local',
  allowed_modes: ['local', 'mock'],
  cloud: { enabled: false, provider: null, model: null, data_categories: [] },
  limits: { max_input_tokens: 6000, max_output_tokens: 1024, request_timeout_seconds: 300 },
};

export const updateAiPolicyBody = z
  .object({
    default_mode: z.enum(['local', 'mock', 'cloud']).optional(),
    allowed_modes: z.array(z.enum(['local', 'mock', 'cloud'])).min(1).max(3).optional(),
    cloud: aiPolicySchema.shape.cloud.partial().optional(),
    limits: aiPolicySchema.shape.limits.partial().optional(),
    /** Must be true when enabling cloud inference: the admin acknowledges the data disclosure. */
    acknowledge_data_disclosure: z.boolean().optional(),
  })
  .strict();

export function effectivePolicy(settings: Record<string, unknown>): AiPolicy {
  const parsed = aiPolicySchema.safeParse(settings.ai_policy);
  return parsed.success ? parsed.data : DEFAULT_AI_POLICY;
}

export interface ResolvedMode {
  mode: RunMode;
  provider: string | null;
  model: string | null;
  disclosure: { provider: string | null; data_categories: string[] } | null;
}

/**
 * Workspace provider policy (FR-AI-003/004/008, ARCHITECTURE §7 routing).
 * Resolution is explicit: the requested (or default) mode must be allowed, and
 * cloud requires opt-in. There is no automatic substitution of another mode.
 */
@Injectable()
export class AiPolicyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async load(organizationId: string): Promise<AiPolicy> {
    const org = await this.database.db.selectFrom('organizations').select('settings').where('id', '=', organizationId).executeTakeFirstOrThrow();
    return effectivePolicy(org.settings);
  }

  resolve(policy: AiPolicy, requested?: RunMode | null): ResolvedMode {
    const mode = requested ?? policy.default_mode;
    if (!policy.allowed_modes.includes(mode)) throw Errors.forbidden(`Inference mode '${mode}' is not allowed by this workspace's AI policy.`);
    if (mode === 'cloud') {
      if (!policy.cloud.enabled || !policy.cloud.provider) throw Errors.forbidden('Cloud inference is not enabled for this workspace.');
      return { mode, provider: policy.cloud.provider, model: policy.cloud.model, disclosure: { provider: policy.cloud.provider, data_categories: policy.cloud.data_categories } };
    }
    return { mode, provider: null, model: null, disclosure: null };
  }

  async get(userId: string, workspaceId: string): Promise<AiPolicy> {
    await this.access.requireWorkspace(userId, workspaceId);
    return this.load(workspaceId);
  }

  async update(userId: string, workspaceId: string, body: z.infer<typeof updateAiPolicyBody>): Promise<AiPolicy> {
    return this.database.transaction(async (tx) => {
      await this.access.requireWorkspace(userId, workspaceId, 'admin', tx);
      const org = await tx.selectFrom('organizations').select('settings').where('id', '=', workspaceId).forUpdate().executeTakeFirstOrThrow();
      const current = effectivePolicy(org.settings);
      const next: AiPolicy = {
        default_mode: body.default_mode ?? current.default_mode,
        allowed_modes: body.allowed_modes ?? current.allowed_modes,
        cloud: { ...current.cloud, ...body.cloud },
        limits: { ...current.limits, ...body.limits },
      };
      const parsed = aiPolicySchema.safeParse(next);
      if (!parsed.success) throw Errors.validation({ issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })) });
      if (!next.allowed_modes.includes(next.default_mode)) throw Errors.unprocessable('INVALID_POLICY', 'default_mode must be one of allowed_modes.');
      const cloudAllowed = next.allowed_modes.includes('cloud');
      if (cloudAllowed && (!next.cloud.enabled || !next.cloud.provider)) {
        throw Errors.unprocessable('INVALID_POLICY', 'Allowing cloud mode requires cloud.enabled and a cloud.provider.');
      }
      const enablingCloud = next.cloud.enabled && !current.cloud.enabled;
      if (enablingCloud && body.acknowledge_data_disclosure !== true) {
        throw Errors.unprocessable('DATA_DISCLOSURE_REQUIRED', 'Enabling cloud inference requires acknowledge_data_disclosure: true.', {
          provider: next.cloud.provider,
          data_categories: next.cloud.data_categories,
        });
      }
      await tx
        .updateTable('organizations')
        .set({ settings: json({ ...org.settings, ai_policy: next }) })
        .where('id', '=', workspaceId)
        .execute();
      // Record actor, time, policy and data-handling mode (API_SPEC §7).
      await this.audit.record(
        {
          organizationId: workspaceId,
          actorUserId: userId,
          action: enablingCloud ? 'ai_policy.cloud_enabled' : 'ai_policy.updated',
          resourceType: 'ai_policy',
          resourceId: workspaceId,
          metadata: { before: current, after: next, data_disclosure_acknowledged: body.acknowledge_data_disclosure === true },
        },
        tx,
      );
      return next;
    });
  }
}

/** Maps AI service errors to public API errors without leaking provider payloads. */
export function aiErrorToApp(err: unknown): Error {
  if (!(err instanceof AiServiceError)) return err as Error;
  switch (err.code) {
    case 'PROVIDER_TIMEOUT':
    case 'AI_TIMEOUT':
      return Errors.upstreamTimeout('PROVIDER_TIMEOUT', 'The model provider timed out.');
    case 'BUDGET_EXCEEDED':
      return Errors.budgetExceeded('The request exceeds the configured token budget.');
    case 'INVALID_MODEL_OUTPUT':
      return Errors.upstream('INVALID_MODEL_OUTPUT', 'The model did not produce a valid structured answer.');
    case 'PROVIDER_REFUSED':
      return Errors.unprocessable('PROVIDER_REFUSED', 'The hosted model declined this request. No other model was tried.', typeof err.details.category === 'string' ? { category: err.details.category } : {});
    case 'PROVIDER_RATE_LIMITED':
      return new AppError(429, 'PROVIDER_RATE_LIMITED', 'The hosted provider is rate limiting requests. Retry later.', {
        retry_after_seconds: typeof err.details.retry_after_seconds === 'number' ? err.details.retry_after_seconds : 30,
      });
    case 'PROVIDER_BAD_REQUEST':
      return Errors.upstream('PROVIDER_BAD_REQUEST', 'The hosted provider rejected the request.');
    case 'PROVIDER_NOT_CONFIGURED':
    case 'MODEL_NOT_AVAILABLE':
    case 'PROVIDER_UNAVAILABLE':
    case 'AI_SERVICE_UNAVAILABLE':
      return Errors.unavailable(err.code, 'The selected model provider is unavailable. No fallback provider was used.');
    default:
      return Errors.upstream('AI_SERVICE_ERROR', 'The AI service failed to process the request.');
  }
}
