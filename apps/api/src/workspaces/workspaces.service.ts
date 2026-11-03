import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { randomToken, sha256Hex } from '../common/crypto.js';
import { Errors } from '../common/errors.js';
import { decodeCursor, type Page, toPage } from '../common/http.js';
import { AuditService } from '../audit/audit.service.js';
import { AppConfig } from '../config/config.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { beforeCursor, cursorUs } from '../database/keyset.js';
import { json, type Organization, type Role } from '../database/types.js';
import { AccessService, roleAtLeast } from './access.service.js';
import {
  type CreateWorkspaceBody,
  retentionSettingsSchema,
  runBudgetLimitsSchema,
  type RunQuotas,
  runQuotasSchema,
  type UpdateWorkspaceBody,
  type WorkspaceSettings,
} from './workspaces.schemas.js';

const INVITATION_TTL_DAYS = 7;

function pgErrorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length > 0 ? base : 'workspace';
}

/** Projects stored settings onto the public schema, dropping internal keys (e.g. ai_policy) and malformed values. */
export function workspaceSettingsView(settings: Record<string, unknown>): WorkspaceSettings {
  const out: WorkspaceSettings = {};
  const retention = retentionSettingsSchema.safeParse(settings.retention);
  if (retention.success) out.retention = retention.data;
  const limits = runBudgetLimitsSchema.safeParse(settings.run_budget_limits);
  if (limits.success) out.run_budget_limits = limits.data;
  const quotas = storedRunQuotas(settings);
  if (Object.keys(quotas).length > 0) out.run_quotas = quotas;
  return out;
}

/** The workspace's configured quotas; malformed or null entries count as unlimited. */
export function storedRunQuotas(settings: Record<string, unknown>): RunQuotas {
  const parsed = runQuotasSchema.safeParse(settings.run_quotas);
  if (!parsed.success) return {};
  const out: RunQuotas = {};
  for (const [k, v] of Object.entries(parsed.data) as Array<[keyof RunQuotas, number | null | undefined]>) if (typeof v === 'number') out[k] = v;
  return out;
}

export function toWorkspaceView(org: Organization, role: Role) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan_key: org.plan_key,
    role,
    settings: workspaceSettingsView(org.settings),
    created_at: org.created_at.toISOString(),
    updated_at: org.updated_at.toISOString(),
  };
}

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  async listForUser(userId: string) {
    const rows = await this.database.db
      .selectFrom('organizations as o')
      .innerJoin('memberships as m', 'm.organization_id', 'o.id')
      .selectAll('o')
      .select('m.role as member_role')
      .where('m.user_id', '=', userId)
      .orderBy('o.created_at', 'asc')
      .limit(200)
      .execute();
    return rows.map(({ member_role, ...org }) => toWorkspaceView(org, member_role));
  }

  async create(userId: string, body: CreateWorkspaceBody) {
    const explicitSlug = body.slug !== undefined;
    const baseSlug = body.slug ?? slugify(body.name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug.slice(0, 40)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
      try {
        return await this.database.transaction(async (tx) => {
          const org = await tx
            .insertInto('organizations')
            .values({ name: body.name, slug, created_by: userId, settings: json({}) })
            .returningAll()
            .executeTakeFirstOrThrow();
          await tx.insertInto('memberships').values({ organization_id: org.id, user_id: userId, role: 'owner' }).execute();
          await this.audit.record({ organizationId: org.id, actorUserId: userId, action: 'workspace.created', resourceType: 'workspace', resourceId: org.id, metadata: { slug } }, tx);
          return toWorkspaceView(org, 'owner');
        });
      } catch (err) {
        if (pgErrorCode(err) === '23505') {
          if (explicitSlug) throw Errors.conflict('SLUG_TAKEN', 'This workspace slug is already in use.');
          continue;
        }
        throw err;
      }
    }
    throw Errors.conflict('SLUG_TAKEN', 'Could not allocate a unique workspace slug; please provide one.');
  }

  async get(userId: string, workspaceId: string) {
    const { role } = await this.access.requireWorkspace(userId, workspaceId);
    const org = await this.database.db.selectFrom('organizations').selectAll().where('id', '=', workspaceId).executeTakeFirstOrThrow();
    return toWorkspaceView(org, role);
  }

  async update(userId: string, workspaceId: string, body: UpdateWorkspaceBody) {
    return this.database.transaction(async (tx) => {
      const { role } = await this.access.requireWorkspace(userId, workspaceId, 'admin', tx);
      const current = await tx.selectFrom('organizations').selectAll().where('id', '=', workspaceId).forUpdate().executeTakeFirstOrThrow();
      const settings = { ...current.settings };
      if (body.settings?.retention) settings.retention = { ...(settings.retention as object | undefined), ...body.settings.retention };
      if (body.settings?.run_budget_limits) {
        settings.run_budget_limits = { ...(settings.run_budget_limits as object | undefined), ...body.settings.run_budget_limits };
      }
      let quotaChange: { from: RunQuotas; to: RunQuotas } | null = null;
      if (body.settings?.run_quotas) {
        const from = storedRunQuotas(current.settings);
        const to: RunQuotas = { ...from };
        for (const [k, v] of Object.entries(body.settings.run_quotas) as Array<[keyof RunQuotas, number | null | undefined]>) {
          if (v === null) delete to[k];
          else if (v !== undefined) to[k] = v;
        }
        settings.run_quotas = to;
        quotaChange = { from, to };
      }
      const org = await tx
        .updateTable('organizations')
        .set({ ...(body.name ? { name: body.name } : {}), settings: json(settings) })
        .where('id', '=', workspaceId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(
        { organizationId: workspaceId, actorUserId: userId, action: 'workspace.updated', resourceType: 'workspace', resourceId: workspaceId, metadata: { fields: Object.keys(body) } },
        tx,
      );
      if (quotaChange) {
        await this.audit.record(
          { organizationId: workspaceId, actorUserId: userId, action: 'workspace.quotas_updated', resourceType: 'workspace', resourceId: workspaceId, metadata: { from: quotaChange.from, to: quotaChange.to } },
          tx,
        );
      }
      return toWorkspaceView(org, role);
    });
  }

  async listMembers(userId: string, workspaceId: string, limit: number, cursorRaw?: string): Promise<Page<unknown>> {
    await this.access.requireWorkspace(userId, workspaceId);
    const cursor = decodeCursor(cursorRaw);
    let q = this.database.db
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.email', 'u.display_name', 'u.avatar_url', 'm.role', 'm.created_at', cursorUs('m.created_at').as('cursor_us')])
      .where('m.organization_id', '=', workspaceId);
    if (cursor) q = q.where(beforeCursor('m.created_at', 'u.id', cursor));
    const rows = await q.orderBy('m.created_at', 'desc').orderBy('u.id', 'desc').limit(limit + 1).execute();
    return toPage(rows, limit, (r) => ({
      user_id: r.id,
      email: r.email,
      display_name: r.display_name,
      avatar_url: r.avatar_url,
      role: r.role,
      joined_at: r.created_at.toISOString(),
    }));
  }

  private async lockMembers(tx: Tx, workspaceId: string) {
    // Serialize membership changes per workspace so last-owner checks are race-free.
    await tx.selectFrom('organizations').select('id').where('id', '=', workspaceId).forUpdate().executeTakeFirstOrThrow();
  }

  private async ownerCount(tx: Tx, workspaceId: string): Promise<number> {
    const row = await tx
      .selectFrom('memberships')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('organization_id', '=', workspaceId)
      .where('role', '=', 'owner')
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /**
   * Role rules: admins manage members/viewers and may grant member/viewer/admin;
   * only owners may grant or revoke owner, or modify admins/owners. The last
   * owner can never be demoted or removed.
   */
  async changeRole(actorId: string, workspaceId: string, targetUserId: string, newRole: Role) {
    return this.database.transaction(async (tx) => {
      const { role: actorRole } = await this.access.requireWorkspace(actorId, workspaceId, 'admin', tx);
      await this.lockMembers(tx, workspaceId);
      const target = await this.access.membership(targetUserId, workspaceId, tx);
      if (!target) throw Errors.notFound('Member');
      if (target === newRole) return this.memberView(tx, workspaceId, targetUserId);
      const touchesPrivileged = roleAtLeast(target, 'admin') || newRole === 'owner';
      if (touchesPrivileged && actorRole !== 'owner') throw Errors.forbidden('Only owners can change admin or owner roles.');
      if (target === 'owner' && (await this.ownerCount(tx, workspaceId)) <= 1) {
        throw Errors.conflict('LAST_OWNER', 'A workspace must keep at least one owner.');
      }
      await tx.updateTable('memberships').set({ role: newRole }).where('organization_id', '=', workspaceId).where('user_id', '=', targetUserId).execute();
      await this.audit.record(
        { organizationId: workspaceId, actorUserId: actorId, action: 'membership.role_changed', resourceType: 'user', resourceId: targetUserId, metadata: { from: target, to: newRole } },
        tx,
      );
      return this.memberView(tx, workspaceId, targetUserId);
    });
  }

  async removeMember(actorId: string, workspaceId: string, targetUserId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const self = actorId === targetUserId;
      const { role: actorRole } = await this.access.requireWorkspace(actorId, workspaceId, self ? 'viewer' : 'admin', tx);
      await this.lockMembers(tx, workspaceId);
      const target = await this.access.membership(targetUserId, workspaceId, tx);
      if (!target) throw Errors.notFound('Member');
      if (!self && roleAtLeast(target, 'admin') && actorRole !== 'owner') throw Errors.forbidden('Only owners can remove admins or owners.');
      if (target === 'owner' && (await this.ownerCount(tx, workspaceId)) <= 1) {
        throw Errors.conflict('LAST_OWNER', 'A workspace must keep at least one owner.');
      }
      await tx.deleteFrom('memberships').where('organization_id', '=', workspaceId).where('user_id', '=', targetUserId).execute();
      await this.audit.record(
        { organizationId: workspaceId, actorUserId: actorId, action: self ? 'membership.left' : 'membership.removed', resourceType: 'user', resourceId: targetUserId, metadata: { role: target } },
        tx,
      );
    });
  }

  private async memberView(tx: Tx, workspaceId: string, userId: string) {
    const r = await tx
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.email', 'u.display_name', 'u.avatar_url', 'm.role', 'm.created_at'])
      .where('m.organization_id', '=', workspaceId)
      .where('m.user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return { user_id: r.id, email: r.email, display_name: r.display_name, avatar_url: r.avatar_url, role: r.role, joined_at: r.created_at.toISOString() };
  }

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------
  async invite(actorId: string, workspaceId: string, email: string, role: Exclude<Role, 'owner'>) {
    return this.database.transaction(async (tx) => {
      const { role: actorRole } = await this.access.requireWorkspace(actorId, workspaceId, 'admin', tx);
      if (role === 'admin' && actorRole !== 'owner') throw Errors.forbidden('Only owners can invite admins.');
      const normalized = email.trim().toLowerCase();
      const existingMember = await tx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select('u.id')
        .where('m.organization_id', '=', workspaceId)
        .where(sql`lower(u.email)`, '=', normalized)
        .executeTakeFirst();
      if (existingMember) throw Errors.conflict('ALREADY_MEMBER', 'This user is already a member of the workspace.');
      await tx
        .updateTable('workspace_invitations')
        .set({ status: 'expired' })
        .where('organization_id', '=', workspaceId)
        .where('status', '=', 'pending')
        .where('expires_at', '<', sql<Date>`now()`)
        .execute();
      const token = randomToken(32);
      let inv;
      try {
        inv = await tx
          .insertInto('workspace_invitations')
          .values({
            organization_id: workspaceId,
            email: normalized,
            role,
            token_hash: sha256Hex(token),
            invited_by: actorId,
            expires_at: new Date(Date.now() + INVITATION_TTL_DAYS * 86400 * 1000),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (pgErrorCode(err) === '23505') throw Errors.conflict('INVITATION_PENDING', 'A pending invitation already exists for this email.');
        throw err;
      }
      await this.audit.record(
        { organizationId: workspaceId, actorUserId: actorId, action: 'invitation.created', resourceType: 'invitation', resourceId: inv.id, metadata: { email: normalized, role } },
        tx,
      );
      return {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        status: inv.status,
        expires_at: inv.expires_at.toISOString(),
        created_at: inv.created_at.toISOString(),
        token,
        accept_url: `${this.config.env.WEB_APP_URL}/invitations/accept#token=${token}`,
      };
    });
  }

  async listInvitations(actorId: string, workspaceId: string) {
    await this.access.requireWorkspace(actorId, workspaceId, 'admin');
    const rows = await this.database.db
      .selectFrom('workspace_invitations')
      .select(['id', 'email', 'role', 'status', 'expires_at', 'created_at'])
      .where('organization_id', '=', workspaceId)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return rows.map((r) => ({
      ...r,
      status: r.status === 'pending' && r.expires_at.getTime() < Date.now() ? 'expired' : r.status,
      expires_at: r.expires_at.toISOString(),
      created_at: r.created_at.toISOString(),
    }));
  }

  async revokeInvitation(actorId: string, workspaceId: string, invitationId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await this.access.requireWorkspace(actorId, workspaceId, 'admin', tx);
      const res = await tx
        .updateTable('workspace_invitations')
        .set({ status: 'revoked' })
        .where('id', '=', invitationId)
        .where('organization_id', '=', workspaceId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw Errors.notFound('Invitation');
      await this.audit.record({ organizationId: workspaceId, actorUserId: actorId, action: 'invitation.revoked', resourceType: 'invitation', resourceId: invitationId }, tx);
    });
  }

  /** Accepts an invitation. The signed-in user's email must match the invited email. */
  async acceptInvitation(userId: string, userEmail: string, token: string) {
    return this.database.transaction(async (tx) => {
      const inv = await tx.selectFrom('workspace_invitations').selectAll().where('token_hash', '=', sha256Hex(token)).forUpdate().executeTakeFirst();
      if (!inv || inv.status !== 'pending' || inv.expires_at.getTime() < Date.now()) throw Errors.notFound('Invitation');
      if (inv.email.toLowerCase() !== userEmail.toLowerCase()) {
        throw Errors.forbidden('This invitation was issued to a different email address.');
      }
      const existing = await this.access.membership(userId, inv.organization_id, tx);
      if (!existing) {
        await tx.insertInto('memberships').values({ organization_id: inv.organization_id, user_id: userId, role: inv.role }).execute();
      }
      await tx
        .updateTable('workspace_invitations')
        .set({ status: 'accepted', accepted_by: userId, accepted_at: sql`now()` })
        .where('id', '=', inv.id)
        .execute();
      await this.audit.record(
        { organizationId: inv.organization_id, actorUserId: userId, action: 'invitation.accepted', resourceType: 'invitation', resourceId: inv.id, metadata: { role: inv.role } },
        tx,
      );
      const org = await tx.selectFrom('organizations').selectAll().where('id', '=', inv.organization_id).executeTakeFirstOrThrow();
      return toWorkspaceView(org, existing ?? inv.role);
    });
  }
}
