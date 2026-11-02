import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { UuidParamPipe, ZodPipe } from '../common/http.js';
import { RateLimit } from '../common/rate-limit.js';
import { type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import { IntegrationsService } from './integrations.service.js';

export const workspaceQuery = z.object({ workspace_id: z.uuid() });

export const completeInstallationBody = z
  .object({
    workspace_id: z.uuid(),
    installation_id: z.coerce.number().int().positive(),
    state: z.string().min(16).max(128),
    code: z.string().min(1).max(512),
    setup_action: z.enum(['install', 'update', 'request']).optional(),
  })
  .strict();

export const availableReposQuery = z.object({ page: z.coerce.number().int().min(1).max(100).default(1) });

@Controller('integrations/github')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  /** PROPOSAL: returns the GitHub App install URL with a bound single-use state. */
  @Get('install-url')
  installUrl(@CurrentUser() user: AuthUser, @Query(new ZodPipe(workspaceQuery)) q: z.infer<typeof workspaceQuery>) {
    return this.integrations.installUrl(user.id, q.workspace_id);
  }

  @Post('complete')
  @HttpCode(200)
  @RateLimit({ bucket: 'gh-complete', max: 20, windowSeconds: 600 })
  complete(@CurrentUser() user: AuthUser, @Body(new ZodPipe(completeInstallationBody)) body: z.infer<typeof completeInstallationBody>) {
    return this.integrations.complete(user.id, body.workspace_id, body.installation_id, body.state, body.code);
  }

  @Get('installations')
  list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(workspaceQuery)) q: z.infer<typeof workspaceQuery>) {
    return this.integrations.list(user.id, q.workspace_id);
  }

  /** PROPOSAL: repositories granted by an installation, for the selection UI (FR-GIT-002). */
  @Get('installations/:id/repositories')
  available(
    @CurrentUser() user: AuthUser,
    @Param('id', new UuidParamPipe('Installation')) id: string,
    @Query(new ZodPipe(availableReposQuery)) q: z.infer<typeof availableReposQuery>,
  ) {
    return this.integrations.availableRepositories(user.id, id, q.page);
  }

  @Delete('installations/:id')
  @HttpCode(204)
  async disconnect(@CurrentUser() user: AuthUser, @Param('id', new UuidParamPipe('Installation')) id: string): Promise<void> {
    await this.integrations.disconnect(user.id, id);
  }
}
