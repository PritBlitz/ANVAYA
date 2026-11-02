import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Idempotent } from '../common/idempotency.js';
import { paginationQuery, UuidParamPipe, ZodPipe } from '../common/http.js';
import { RateLimit } from '../common/rate-limit.js';
import { type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import {
  acceptInvitationBody,
  changeRoleBody,
  createWorkspaceBody,
  inviteBody,
  updateWorkspaceBody,
} from './workspaces.schemas.js';
import { WorkspacesService } from './workspaces.service.js';
import type { z } from 'zod';

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.workspaces.listForUser(user.id);
  }

  @Post()
  @Idempotent()
  @RateLimit({ bucket: 'workspace-create', max: 20, windowSeconds: 3600 })
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(createWorkspaceBody)) body: z.infer<typeof createWorkspaceBody>) {
    return this.workspaces.create(user.id, body);
  }

  @Get(':workspaceId')
  get(@CurrentUser() user: AuthUser, @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string) {
    return this.workspaces.get(user.id, workspaceId);
  }

  @Patch(':workspaceId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string,
    @Body(new ZodPipe(updateWorkspaceBody)) body: z.infer<typeof updateWorkspaceBody>,
  ) {
    return this.workspaces.update(user.id, workspaceId, body);
  }

  @Get(':workspaceId/members')
  members(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string,
    @Query(new ZodPipe(paginationQuery)) q: z.infer<typeof paginationQuery>,
  ) {
    return this.workspaces.listMembers(user.id, workspaceId, q.limit, q.cursor);
  }

  @Patch(':workspaceId/members/:userId')
  changeRole(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string,
    @Param('userId', new UuidParamPipe('Member')) userId: string,
    @Body(new ZodPipe(changeRoleBody)) body: z.infer<typeof changeRoleBody>,
  ) {
    return this.workspaces.changeRole(user.id, workspaceId, userId, body.role);
  }

  @Delete(':workspaceId/members/:userId')
  @HttpCode(204)
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string,
    @Param('userId', new UuidParamPipe('Member')) userId: string,
  ): Promise<void> {
    await this.workspaces.removeMember(user.id, workspaceId, userId);
  }

  @Post(':workspaceId/invitations')
  @Idempotent()
  @RateLimit({ bucket: 'invite', max: 50, windowSeconds: 3600 })
  invite(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string,
    @Body(new ZodPipe(inviteBody)) body: z.infer<typeof inviteBody>,
  ) {
    return this.workspaces.invite(user.id, workspaceId, body.email, body.role);
  }

  @Get(':workspaceId/invitations')
  invitations(@CurrentUser() user: AuthUser, @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string) {
    return this.workspaces.listInvitations(user.id, workspaceId);
  }

  @Delete(':workspaceId/invitations/:invitationId')
  @HttpCode(204)
  async revokeInvitation(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string,
    @Param('invitationId', new UuidParamPipe('Invitation')) invitationId: string,
  ): Promise<void> {
    await this.workspaces.revokeInvitation(user.id, workspaceId, invitationId);
  }
}

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Post('accept')
  @HttpCode(200)
  @RateLimit({ bucket: 'invite-accept', max: 20, windowSeconds: 600 })
  accept(@CurrentUser() user: AuthUser, @Body(new ZodPipe(acceptInvitationBody)) body: z.infer<typeof acceptInvitationBody>) {
    return this.workspaces.acceptInvitation(user.id, user.email, body.token);
  }
}
