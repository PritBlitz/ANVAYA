import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { randomToken } from '../common/crypto.js';
import { Errors } from '../common/errors.js';
import { RedisService } from '../common/redis.service.js';
import { AppConfig } from '../config/config.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { type GitInstallation, json } from '../database/types.js';
import { AccessService } from '../workspaces/access.service.js';
import { GithubAppService, toAppError } from './github-app.service.js';

const STATE_TTL_SECONDS = 15 * 60;
const stateSchema = z.object({ userId: z.uuid(), workspaceId: z.uuid() });

export function installationView(i: GitInstallation) {
  return {
    id: i.id,
    workspace_id: i.organization_id,
    provider: i.provider,
    external_installation_id: i.external_installation_id,
    account_login: i.account_login,
    account_type: i.account_type,
    granted_permissions: i.granted_permissions,
    status: i.status,
    created_at: i.created_at.toISOString(),
    updated_at: i.updated_at.toISOString(),
  };
}

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly github: GithubAppService,
    private readonly redis: RedisService,
    private readonly config: AppConfig,
  ) {}

  /** Returns a GitHub App install URL carrying a single-use state bound to (user, workspace). */
  async installUrl(userId: string, workspaceId: string) {
    await this.access.requireWorkspace(userId, workspaceId, 'admin');
    const slug = this.config.env.GITHUB_APP_SLUG;
    if (!slug || !this.github.configured) throw Errors.notConfigured('GitHub App');
    const state = randomToken(24);
    await this.redis.client.set(`gh-install-state:${state}`, JSON.stringify({ userId, workspaceId }), 'EX', STATE_TTL_SECONDS);
    const url = new URL(`/apps/${encodeURIComponent(slug)}/installations/new`, this.config.env.GITHUB_WEB_URL);
    url.searchParams.set('state', state);
    return { url: url.toString(), state, expires_in_seconds: STATE_TTL_SECONDS };
  }

  /**
   * Completes the installation handshake. The installation id in the GitHub
   * redirect is attacker-controllable, so we require (1) the single-use state we
   * issued to this user for this workspace and (2) an OAuth code proving the
   * user can see the installation (`GET /user/installations`).
   */
  async complete(userId: string, requestedWorkspaceId: string | undefined, installationId: number, state: string, code: string) {
    if (requestedWorkspaceId) await this.access.requireWorkspace(userId, requestedWorkspaceId, 'admin');
    if (!this.github.configured) throw Errors.notConfigured('GitHub App');

    const raw = await this.redis.client.getdel(`gh-install-state:${state}`);
    const bound = raw ? stateSchema.safeParse(JSON.parse(raw)) : null;
    if (!bound?.success || bound.data.userId !== userId || (requestedWorkspaceId !== undefined && bound.data.workspaceId !== requestedWorkspaceId)) {
      throw Errors.forbidden('The installation state is invalid or has expired. Start the installation again.');
    }
    // The workspace comes from the server-held state, never from the redirect.
    const workspaceId = bound.data.workspaceId;
    if (!requestedWorkspaceId) await this.access.requireWorkspace(userId, workspaceId, 'admin');

    let remote;
    try {
      const userToken = await this.github.exchangeUserCode(code);
      const visible = await this.github.userInstallationIds(userToken);
      if (!visible.has(installationId)) throw Errors.forbidden('You do not have access to this GitHub App installation.');
      remote = await this.github.getInstallation(installationId);
    } catch (err) {
      throw toAppError(err);
    }
    if (!remote.account) throw Errors.upstream('GITHUB_BAD_RESPONSE', 'Installation has no account.');
    const account = remote.account;

    return this.database.transaction(async (tx) => {
      const existing = await tx.selectFrom('git_installations').selectAll().where('external_installation_id', '=', installationId).forUpdate().executeTakeFirst();
      if (existing && existing.organization_id !== workspaceId && existing.status !== 'disconnected') {
        throw Errors.conflict('INSTALLATION_ALREADY_LINKED', 'This GitHub installation is linked to another workspace.');
      }
      const values = {
        organization_id: workspaceId,
        account_login: account.login,
        account_type: account.type ?? null,
        granted_permissions: json(remote.permissions),
        status: remote.suspended_at ? ('suspended' as const) : ('active' as const),
      };
      const row = existing
        ? await tx.updateTable('git_installations').set(values).where('id', '=', existing.id).returningAll().executeTakeFirstOrThrow()
        : await tx
            .insertInto('git_installations')
            .values({ ...values, provider: 'github', external_installation_id: installationId })
            .returningAll()
            .executeTakeFirstOrThrow();
      await this.audit.record(
        {
          organizationId: workspaceId,
          actorUserId: userId,
          action: 'integration.github.connected',
          resourceType: 'git_installation',
          resourceId: row.id,
          metadata: { external_installation_id: installationId, account: account.login, permissions: remote.permissions },
        },
        tx,
      );
      return installationView(row);
    });
  }

  async list(userId: string, workspaceId: string) {
    await this.access.requireWorkspace(userId, workspaceId);
    const rows = await this.database.db
      .selectFrom('git_installations')
      .selectAll()
      .where('organization_id', '=', workspaceId)
      .where('status', '!=', 'disconnected')
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return rows.map(installationView);
  }

  async requireInstallation(userId: string, installationId: string, min: 'viewer' | 'admin' = 'viewer') {
    const row = await this.database.db.selectFrom('git_installations').selectAll().where('id', '=', installationId).executeTakeFirst();
    if (!row) throw Errors.notFound('Installation');
    const role = await this.access.membership(userId, row.organization_id);
    if (!role) throw Errors.notFound('Installation');
    await this.access.requireWorkspace(userId, row.organization_id, min);
    return row;
  }

  /** Repositories the installation grants, annotated with whether each is already connected. */
  async availableRepositories(userId: string, installationId: string, page: number) {
    const inst = await this.requireInstallation(userId, installationId, 'admin');
    if (inst.status !== 'active') throw Errors.invalidState('The installation is not active.');
    let res;
    try {
      res = await this.github.listInstallationRepositories(inst.external_installation_id, page);
    } catch (err) {
      throw toAppError(err);
    }
    const ids = res.repositories.map((r) => r.id);
    const connected = ids.length
      ? await this.database.db
          .selectFrom('repositories')
          .select(['external_repository_id', 'id', 'status'])
          .where('organization_id', '=', inst.organization_id)
          .where('external_repository_id', 'in', ids)
          .execute()
      : [];
    const byExt = new Map(connected.map((c) => [c.external_repository_id, c]));
    return {
      total_count: res.total_count,
      page,
      repositories: res.repositories.map((r) => ({
        external_repository_id: r.id,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch ?? null,
        archived: r.archived ?? false,
        connected_repository_id: byExt.get(r.id)?.status === 'connected' ? byExt.get(r.id)!.id : null,
      })),
    };
  }

  /** Disconnect: stop all future access and indexing for the installation (FR-GIT-008). */
  async disconnect(userId: string, installationId: string): Promise<void> {
    const inst = await this.requireInstallation(userId, installationId, 'admin');
    await this.database.transaction(async (tx) => {
      await this.markDisconnected(tx, inst.id);
      await this.audit.record(
        { organizationId: inst.organization_id, actorUserId: userId, action: 'integration.github.disconnected', resourceType: 'git_installation', resourceId: inst.id },
        tx,
      );
    });
    this.github.forgetInstallation(inst.external_installation_id);
  }

  /** Shared by user disconnect and the `installation.deleted` webhook. */
  async markDisconnected(tx: Tx, installationId: string): Promise<void> {
    await tx.updateTable('git_installations').set({ status: 'disconnected' }).where('id', '=', installationId).execute();
    const repos = await tx
      .updateTable('repositories')
      .set({ status: 'disconnected', indexing_status: 'disabled' })
      .where('installation_id', '=', installationId)
      .returning('id')
      .execute();
    if (repos.length > 0) {
      await tx
        .updateTable('indexing_jobs')
        .set({ status: 'cancelled', error_code: 'INSTALLATION_DISCONNECTED', ended_at: sql`now()` })
        .where(
          'repository_id',
          'in',
          repos.map((r) => r.id),
        )
        .where('status', 'in', ['queued', 'running'])
        .execute();
    }
  }
}
