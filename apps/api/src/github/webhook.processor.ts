import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { logger } from '../common/logger.js';
import type { Tx } from '../database/database.service.js';
import { json } from '../database/types.js';
import { type IndexRequestResult, IndexingRequestsService } from '../indexing/indexing-requests.service.js';
import { effectiveSettings } from '../repositories/repositories.service.js';
import { GithubAppService } from './github-app.service.js';
import { IntegrationsService } from './integrations.service.js';

const log = logger('webhook-processor');

const installationRef = z.object({ id: z.number().int() });
const repoRef = z.object({ id: z.number().int(), name: z.string(), full_name: z.string(), default_branch: z.string().nullable().optional(), owner: z.object({ login: z.string() }).optional() });

const installationEvent = z.object({
  action: z.string(),
  installation: installationRef.extend({ permissions: z.record(z.string(), z.string()).optional(), account: z.object({ login: z.string() }).nullable().optional() }),
});
const installationReposEvent = z.object({
  action: z.enum(['added', 'removed']),
  installation: installationRef,
  repositories_removed: z.array(z.object({ id: z.number().int() })).default([]),
});
const pushEvent = z.object({
  ref: z.string(),
  after: z.string().regex(/^[0-9a-f]{40}$/),
  deleted: z.boolean().optional(),
  repository: repoRef,
  installation: installationRef,
});
const repositoryEvent = z.object({ action: z.string(), repository: repoRef, installation: installationRef.optional() });

export interface WebhookOutcome {
  handled: boolean;
  indexRequests: IndexRequestResult[];
  forgetInstallation?: number;
}

/**
 * Applies GitHub webhook effects. Payload content is untrusted: every event is
 * schema-validated and resolved against our own records (installation id →
 * workspace) — nothing in the payload can select a workspace by itself.
 */
@Injectable()
export class WebhookProcessor {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly indexing: IndexingRequestsService,
    private readonly audit: AuditService,
    private readonly github: GithubAppService,
  ) {}

  async process(tx: Tx, event: string, payload: unknown): Promise<WebhookOutcome> {
    const none: WebhookOutcome = { handled: false, indexRequests: [] };
    switch (event) {
      case 'ping':
        return { handled: true, indexRequests: [] };
      case 'installation':
        return (await this.installation(tx, payload)) ?? none;
      case 'installation_repositories':
        return (await this.installationRepositories(tx, payload)) ?? none;
      case 'push':
        return (await this.push(tx, payload)) ?? none;
      case 'repository':
        return (await this.repository(tx, payload)) ?? none;
      default:
        return none;
    }
  }

  async afterCommit(outcome: WebhookOutcome): Promise<void> {
    if (outcome.forgetInstallation !== undefined) this.github.forgetInstallation(outcome.forgetInstallation);
    await this.indexing.dispatch(outcome.indexRequests);
  }

  private async installation(tx: Tx, payload: unknown): Promise<WebhookOutcome | null> {
    const p = installationEvent.safeParse(payload);
    if (!p.success) return null;
    const inst = await tx.selectFrom('git_installations').selectAll().where('external_installation_id', '=', p.data.installation.id).executeTakeFirst();
    // `created` is ignored: linking requires the verified completion handshake.
    if (!inst) return null;
    const audit = (action: string) =>
      this.audit.record({ organizationId: inst.organization_id, actorUserId: null, actorType: 'system', action, resourceType: 'git_installation', resourceId: inst.id, metadata: { source: 'github_webhook' } }, tx);
    switch (p.data.action) {
      case 'deleted':
        await this.integrations.markDisconnected(tx, inst.id);
        await audit('integration.github.uninstalled');
        return { handled: true, indexRequests: [], forgetInstallation: p.data.installation.id };
      case 'suspend':
        await tx.updateTable('git_installations').set({ status: 'suspended' }).where('id', '=', inst.id).execute();
        await audit('integration.github.suspended');
        return { handled: true, indexRequests: [], forgetInstallation: p.data.installation.id };
      case 'unsuspend':
        if (inst.status === 'suspended') await tx.updateTable('git_installations').set({ status: 'active' }).where('id', '=', inst.id).execute();
        await audit('integration.github.unsuspended');
        return { handled: true, indexRequests: [] };
      case 'new_permissions_accepted':
        await tx
          .updateTable('git_installations')
          .set({ granted_permissions: json(p.data.installation.permissions ?? {}) })
          .where('id', '=', inst.id)
          .execute();
        await audit('integration.github.permissions_changed');
        return { handled: true, indexRequests: [], forgetInstallation: p.data.installation.id };
      default:
        return null;
    }
  }

  private async installationRepositories(tx: Tx, payload: unknown): Promise<WebhookOutcome | null> {
    const p = installationReposEvent.safeParse(payload);
    if (!p.success || p.data.action !== 'removed' || p.data.repositories_removed.length === 0) return null;
    const inst = await tx.selectFrom('git_installations').select(['id', 'organization_id']).where('external_installation_id', '=', p.data.installation.id).executeTakeFirst();
    if (!inst) return null;
    const removed = await tx
      .updateTable('repositories')
      .set({ status: 'disconnected', indexing_status: 'disabled' })
      .where('installation_id', '=', inst.id)
      .where(
        'external_repository_id',
        'in',
        p.data.repositories_removed.map((r) => r.id),
      )
      .returning('id')
      .execute();
    for (const r of removed) {
      await this.audit.record({ organizationId: inst.organization_id, actorUserId: null, actorType: 'system', action: 'repository.access_revoked', resourceType: 'repository', resourceId: r.id, metadata: { source: 'github_webhook' } }, tx);
    }
    return { handled: removed.length > 0, indexRequests: [], forgetInstallation: p.data.installation.id };
  }

  /** Pushes to the default branch trigger incremental re-indexing when enabled. */
  private async push(tx: Tx, payload: unknown): Promise<WebhookOutcome | null> {
    const p = pushEvent.safeParse(payload);
    if (!p.success || p.data.deleted) return null;
    const repo = await tx
      .selectFrom('repositories as r')
      .innerJoin('git_installations as i', 'i.id', 'r.installation_id')
      .select(['r.id', 'r.organization_id', 'r.default_branch', 'r.status', 'r.settings', 'i.status as installation_status'])
      .where('r.external_repository_id', '=', p.data.repository.id)
      .where('r.status', '<>', 'disconnected')
      .where('i.external_installation_id', '=', p.data.installation.id)
      .executeTakeFirst();
    if (!repo || repo.status !== 'connected' || repo.installation_status !== 'active') return null;
    if (p.data.ref !== `refs/heads/${repo.default_branch ?? ''}`) return null;
    if (!effectiveSettings(repo.settings).auto_index_on_push) return null;
    const req = await this.indexing.request(tx, { organizationId: repo.organization_id, repositoryId: repo.id, trigger: 'push', commitSha: p.data.after, ref: repo.default_branch });
    log.info({ repository_id: repo.id, created: req.created }, 'push triggered re-index');
    return { handled: true, indexRequests: [req] };
  }

  private async repository(tx: Tx, payload: unknown): Promise<WebhookOutcome | null> {
    const p = repositoryEvent.safeParse(payload);
    if (!p.success) return null;
    const repo = await tx.selectFrom('repositories').select(['id', 'organization_id']).where('external_repository_id', '=', p.data.repository.id).where('status', '<>', 'disconnected').executeTakeFirst();
    if (!repo) return null;
    if (p.data.action === 'deleted') {
      await tx.updateTable('repositories').set({ status: 'disconnected', indexing_status: 'disabled' }).where('id', '=', repo.id).execute();
      await this.audit.record({ organizationId: repo.organization_id, actorUserId: null, actorType: 'system', action: 'repository.deleted_upstream', resourceType: 'repository', resourceId: repo.id }, tx);
      return { handled: true, indexRequests: [] };
    }
    if (['renamed', 'transferred', 'edited'].includes(p.data.action)) {
      await tx
        .updateTable('repositories')
        .set({
          name: p.data.repository.name,
          full_name: p.data.repository.full_name,
          ...(p.data.repository.owner ? { owner: p.data.repository.owner.login } : {}),
          ...(p.data.repository.default_branch ? { default_branch: p.data.repository.default_branch } : {}),
        })
        .where('id', '=', repo.id)
        .execute();
      return { handled: true, indexRequests: [] };
    }
    return null;
  }
}
