import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { UuidParamPipe, ZodPipe } from '../common/http.js';
import { Idempotent } from '../common/idempotency.js';
import { type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import { createTemplateBody, listTemplatesQuery, updateTemplateBody } from './templates.js';
import { TemplatesService } from './templates.service.js';

/** Workflow templates: any member can read; only admins create, change or archive (audited). */
@Controller('workspaces/:workspaceId/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string, @Query(new ZodPipe(listTemplatesQuery)) q: z.infer<typeof listTemplatesQuery>) {
    return this.templates.list(user.id, workspaceId, q.include_archived);
  }

  @Post()
  @Idempotent()
  create(@CurrentUser() user: AuthUser, @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string, @Body(new ZodPipe(createTemplateBody)) body: z.infer<typeof createTemplateBody>) {
    return this.templates.create(user.id, workspaceId, body);
  }

  @Patch(':templateId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string,
    @Param('templateId', new UuidParamPipe('Template')) templateId: string,
    @Body(new ZodPipe(updateTemplateBody)) body: z.infer<typeof updateTemplateBody>,
  ) {
    return this.templates.update(user.id, workspaceId, templateId, body);
  }

  @Delete(':templateId')
  @HttpCode(204)
  async archive(@CurrentUser() user: AuthUser, @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string, @Param('templateId', new UuidParamPipe('Template')) templateId: string): Promise<void> {
    await this.templates.archive(user.id, workspaceId, templateId);
  }
}
