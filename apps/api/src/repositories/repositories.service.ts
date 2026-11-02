import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/errors.js';
import { decodeCursor, type Page, toPage } from '../common/http.js';
import { DatabaseService } from '../database/database.service.js';
import { beforeCursor, cursorUs } from '../database/keyset.js';
import { json, type Repository } from '../database/types.js';
import { GithubAppService, toAppError } from '../github/github-app.service.js';
import { IndexingRequestsService } from '../indexing/indexing-requests.service.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { AccessService } from '../workspaces/access.service.js';
import { DEFAULT_REPOSITORY_SETTINGS, type RepositorySettings, repositorySettingsSchema } from './repositories.schemas.js';

export function effectiveSettings(stored: Record<string, unknown>): Required<RepositorySettings> {
  const parsed = repositorySettingsSchema.safeParse(stored);
  return { ...DEFAULT_REPOSITORY_SETTINGS, ...(parsed.success ? parsed.data : {}) };
}

export function repositoryView(r: Repository) {
  return {
    id: r.id,
    workspace_id: r.organization_id,
    installation_id: r.installation_id,
    provider: r.provider,
    external_repository_id: r.external_repository_id,
    owner: r.owner,
    name: r.name,
    full_name: r.full_name,
    default_branch: r.default_branch,
    visibility: r.visibility,
    status: r.status,
    indexing_status: r.indexing_status,
    latest_indexed_commit_sha: r.latest_indexed_commit_sha,
    indexed_at: r.indexed_at?.toISOString() ?? null,
    settings: effectiveSettings(r.settings),
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

@Injectable()
export class RepositoriesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly github: GithubAppService,
    private readonly indexing: IndexingRequestsService,
    private readonly storage: ObjectStorage,
  ) {}

  async list(userId: string, workspaceId: string, limit: number, cursorRaw?: string, status?: Repository['status']): Promise<Page<unknown>> {
    await this.access.requireWorkspace(userId, workspaceId);
    const cursor = decodeCursor(cursorRaw);
    let q = this.database.db.selectFrom('repositories').selectAll().select(cursorUs('created_at').as('cursor_us')).where('organization_id', '=', workspaceId);
    if (status) q = q.where('status', '=', status);
    if (cursor) q = q.where(beforeCursor('created_at', 'id', cursor));
    const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
    return toPage(rows, limit, ({ cursor_us: _c, ...r }) => repositoryView(r));
  }

  /**
   * Registers a repository from an installation. GitHub is asked for the
   * repository using an installation token scoped to that repository id, which
   * proves the installation actually grants it.
   */
  async create(userId: string, body: { workspace_id: string; installation_id: string; external_repository_id: number; index: boolean }) {
    await this.access.requireWorkspace(userId, body.workspace_id, 'admin');
    const inst = await this.database.db
      .selectFrom('git_installations')
      .selectAll()
      .where('id', '=', body.installation_id)
      .where('organization_id', '=', body.workspace_id)
      .executeTakeFirst();
    if (!inst) throw Errors.notFound('Installation');
    if (inst.status !== 'active') throw Errors.invalidState('The installation is not active.');

    let remote;
    try {
      remote = await this.github.getRepository(inst.external_installation_id, body.external_repository_id);
    } catch (err) {
      throw toAppError(err);
    }

    const result = await this.database.transaction(async (tx) => {
      const existing = await tx.selectFrom('repositories').selectAll().where('external_repository_id', '=', remote.id).forUpdate().executeTakeFirst();
      if (existing && existing.organization_id !== body.workspace_id) {
        throw Errors.conflict('REPOSITORY_ALREADY_CONNECTED', 'This repository is connected to another workspace.');
      }
      if (existing && existing.status === 'connected') {
        throw Errors.conflict('REPOSITORY_ALREADY_CONNECTED', 'This repository is already connected.', { repository_id: existing.id });
      }
      const values = {
        organization_id: body.workspace_id,
        installation_id: inst.id,
        owner: remote.owner.login,
        name: remote.name,
        full_name: remote.full_name,
        default_branch: remote.default_branch ?? null,
        visibility: remote.visibility ?? (remote.private ? ('private' as const) : ('public' as const)),
        status: 'connected' as const,
        indexing_status: 'pending' as const,
      };
      const repo = existing
        ? await tx.updateTable('repositories').set(values).where('id', '=', existing.id).returningAll().executeTakeFirstOrThrow()
        : await tx
            .insertInto('repositories')
            .values({ ...values, external_repository_id: remote.id, settings: json({}) })
            .returningAll()
            .executeTakeFirstOrThrow();
      await this.audit.record(
        { organizationId: body.workspace_id, actorUserId: userId, action: 'repository.connected', resourceType: 'repository', resourceId: repo.id, metadata: { full_name: repo.full_name } },
        tx,
      );
      const indexReq = body.index ? await this.indexing.request(tx, { organizationId: repo.organization_id, repositoryId: repo.id, trigger: 'initial', requestedBy: userId }) : null;
      return { repo: indexReq ? { ...repo, indexing_status: 'queued' as const } : repo, indexReq };
    });
    if (result.indexReq) await this.indexing.dispatch([result.indexReq]);
    return repositoryView(result.repo);
  }

  async get(userId: string, repositoryId: string) {
    const { repository } = await this.access.requireRepository(userId, repositoryId);
    return repositoryView(repository);
  }

  async update(userId: string, repositoryId: string, body: { settings?: RepositorySettings; status?: 'connected' | 'disabled' }) {
    const { repository } = await this.access.requireRepository(userId, repositoryId, 'admin');
    if (repository.status === 'disconnected') throw Errors.invalidState('A disconnected repository must be reconnected first.');
    return this.database.transaction(async (tx) => {
      const current = await tx.selectFrom('repositories').selectAll().where('id', '=', repositoryId).forUpdate().executeTakeFirstOrThrow();
      const settings = body.settings ? { ...current.settings, ...body.settings } : current.settings;
      const patch: Record<string, unknown> = { settings: json(settings) };
      if (body.status) {
        patch.status = body.status;
        if (body.status === 'disabled') patch.indexing_status = 'disabled';
        if (body.status === 'connected' && current.status === 'disabled') patch.indexing_status = current.latest_indexed_commit_sha ? 'ready' : 'pending';
      }
      const updated = await tx.updateTable('repositories').set(patch).where('id', '=', repositoryId).returningAll().executeTakeFirstOrThrow();
      if (body.status === 'disabled') {
        await tx
          .updateTable('indexing_jobs')
          .set({ status: 'cancelled', error_code: 'REPOSITORY_DISABLED', ended_at: sql`now()` })
          .where('repository_id', '=', repositoryId)
          .where('status', 'in', ['queued', 'running'])
          .execute();
      }
      await this.audit.record(
        { organizationId: repository.organization_id, actorUserId: userId, action: 'repository.updated', resourceType: 'repository', resourceId: repositoryId, metadata: { fields: Object.keys(body), status: body.status } },
        tx,
      );
      return repositoryView(updated);
    });
  }

  /**
   * Disconnect (DATABASE §8): the repository row is kept so task/run history and
   * audit remain intact, but all index data (snapshots → files → chunks/symbols)
   * is deleted and future access stops.
   */
  async disconnect(userId: string, repositoryId: string): Promise<void> {
    const { repository } = await this.access.requireRepository(userId, repositoryId, 'admin');
    await this.database.transaction(async (tx) => {
      await tx.updateTable('repositories').set({ status: 'disconnected', indexing_status: 'disabled', latest_indexed_commit_sha: null, indexed_at: null }).where('id', '=', repositoryId).execute();
      await tx
        .updateTable('indexing_jobs')
        .set({ status: 'cancelled', error_code: 'REPOSITORY_DISCONNECTED', ended_at: sql`now()` })
        .where('repository_id', '=', repositoryId)
        .where('status', 'in', ['queued', 'running'])
        .execute();
      const deleted = await tx.deleteFrom('repository_snapshots').where('repository_id', '=', repositoryId).executeTakeFirst();
      await this.audit.record(
        {
          organizationId: repository.organization_id,
          actorUserId: userId,
          action: 'repository.disconnected',
          resourceType: 'repository',
          resourceId: repositoryId,
          metadata: { full_name: repository.full_name, snapshots_deleted: Number(deleted.numDeletedRows) },
        },
        tx,
      );
    });
    // Stored file content for this repository is removed with its index (DATABASE §8).
    await this.storage.deletePrefix(`repositories/${repositoryId}`);
  }
}
