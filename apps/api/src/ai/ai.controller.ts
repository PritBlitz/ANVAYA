import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { UuidParamPipe, ZodPipe } from '../common/http.js';
import { RateLimit } from '../common/rate-limit.js';
import { type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import { AccessService } from '../workspaces/access.service.js';
import { AiClient } from './ai-client.js';
import { aiErrorToApp, AiPolicyService, updateAiPolicyBody } from './ai-policy.service.js';
import { askBody, QuestionsService } from './questions.service.js';
import { UsageService } from './usage.service.js';

export const healthCheckBody = z.object({ workspace_id: z.uuid(), mode: z.enum(['local', 'cloud', 'mock']).optional() }).strict();
export const usageQuery = z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() });

@Controller()
export class AiController {
  constructor(
    private readonly policy: AiPolicyService,
    private readonly questions: QuestionsService,
    private readonly usage: UsageService,
    private readonly access: AccessService,
    private readonly ai: AiClient,
  ) {}

  @Get('workspaces/:workspaceId/ai-policy')
  getPolicy(@CurrentUser() user: AuthUser, @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string) {
    return this.policy.get(user.id, workspaceId);
  }

  @Patch('workspaces/:workspaceId/ai-policy')
  updatePolicy(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string,
    @Body(new ZodPipe(updateAiPolicyBody)) body: z.infer<typeof updateAiPolicyBody>,
  ) {
    return this.policy.update(user.id, workspaceId, body);
  }

  /** Checks a provider the workspace policy permits. Never returns secrets. */
  @Post('ai/providers/health-check')
  @HttpCode(200)
  @RateLimit({ bucket: 'ai-health', max: 30, windowSeconds: 60 })
  async healthCheck(@CurrentUser() user: AuthUser, @Body(new ZodPipe(healthCheckBody)) body: z.infer<typeof healthCheckBody>) {
    await this.access.requireWorkspace(user.id, body.workspace_id, 'member');
    const policy = await this.policy.load(body.workspace_id);
    const resolved = this.policy.resolve(policy, body.mode);
    try {
      const h = await this.ai.health(resolved.mode, resolved.provider ?? undefined);
      return { mode: resolved.mode, provider: h.provider, available: h.available, models: h.models, detail: h.detail ?? null, checked_at: new Date().toISOString() };
    } catch (err) {
      throw aiErrorToApp(err);
    }
  }

  @Get('workspaces/:workspaceId/usage')
  usageSummary(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string,
    @Query(new ZodPipe(usageQuery)) q: z.infer<typeof usageQuery>,
  ) {
    const to = q.to ? new Date(q.to) : null;
    const from = q.from ? new Date(q.from) : new Date((to ?? new Date()).getTime() - 30 * 86400 * 1000);
    return this.usage.summary(user.id, workspaceId, from, to);
  }

  @Post('repositories/:repositoryId/questions')
  @HttpCode(200)
  @RateLimit({ bucket: 'ai', max: 30, windowSeconds: 60 })
  ask(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) repositoryId: string, @Body(new ZodPipe(askBody)) body: z.infer<typeof askBody>) {
    return this.questions.ask(user.id, repositoryId, body);
  }
}
