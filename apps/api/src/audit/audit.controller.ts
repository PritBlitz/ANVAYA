import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor, paginationQuery, toPage, UuidParamPipe, ZodPipe } from '../common/http.js';
import { DatabaseService } from '../database/database.service.js';
import { beforeCursor, cursorUs } from '../database/keyset.js';
import { type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import { AccessService } from '../workspaces/access.service.js';

export const auditQuery = paginationQuery.extend({
  action: z.string().max(100).optional(),
  actor_user_id: z.uuid().optional(),
  resource_type: z.string().max(50).optional(),
  resource_id: z.string().max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/** Audit history, searchable by time, actor, action and resource (FR-OBS-005). Admins only. */
@Controller('workspaces/:workspaceId/audit-events')
export class AuditController {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string,
    @Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>,
  ) {
    await this.access.requireWorkspace(user.id, workspaceId, 'admin');
    const cursor = decodeCursor(q.cursor);
    let query = this.database.db
      .selectFrom('audit_events as a')
      .leftJoin('users as u', 'u.id', 'a.actor_user_id')
      .select([
        'a.id',
        'a.actor_type',
        'a.actor_user_id',
        'u.email as actor_email',
        'a.action',
        'a.resource_type',
        'a.resource_id',
        'a.request_id',
        'a.metadata_redacted',
        'a.created_at',
        cursorUs('a.created_at').as('cursor_us'),
      ])
      .where('a.organization_id', '=', workspaceId);
    if (q.action) query = query.where('a.action', '=', q.action);
    if (q.actor_user_id) query = query.where('a.actor_user_id', '=', q.actor_user_id);
    if (q.resource_type) query = query.where('a.resource_type', '=', q.resource_type);
    if (q.resource_id) query = query.where('a.resource_id', '=', q.resource_id);
    if (q.from) query = query.where('a.created_at', '>=', new Date(q.from));
    if (q.to) query = query.where('a.created_at', '<', new Date(q.to));
    if (cursor) query = query.where(beforeCursor('a.created_at', 'a.id', cursor));
    const rows = await query.orderBy('a.created_at', 'desc').orderBy('a.id', 'desc').limit(q.limit + 1).execute();
    return toPage(rows, q.limit, (r) => ({
      id: r.id,
      actor_type: r.actor_type,
      actor_user_id: r.actor_user_id,
      actor_email: r.actor_email,
      action: r.action,
      resource_type: r.resource_type,
      resource_id: r.resource_id,
      request_id: r.request_id,
      metadata: r.metadata_redacted,
      created_at: r.created_at.toISOString(),
    }));
  }
}
