import { Injectable } from '@nestjs/common';
import { Errors } from '../common/errors.js';
import { logger } from '../common/logger.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { json } from '../database/types.js';
import { QueueService } from '../queue/queues.js';

const log = logger('indexing-requests');

export interface IndexRequest {
  organizationId: string;
  repositoryId: string;
  trigger: 'manual' | 'push' | 'initial' | 'retry';
  ref?: string | null;
  commitSha?: string | null;
  requestedBy?: string | null;
}

export interface IndexRequestResult {
  indexingJobId: string;
  organizationId: string;
  repositoryId: string;
  created: boolean;
}

/**
 * Creates durable indexing job rows. PostgreSQL holds the truth; the BullMQ job
 * is only a wake-up signal and is enqueued after commit. At most one active job
 * per repository (partial unique index) — repeated requests coalesce.
 */
@Injectable()
export class IndexingRequestsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly queues: QueueService,
  ) {}

  async request(tx: Tx, req: IndexRequest): Promise<IndexRequestResult> {
    const repo = await tx
      .selectFrom('repositories')
      .select(['status', 'installation_id'])
      .where('id', '=', req.repositoryId)
      .where('organization_id', '=', req.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!repo) throw Errors.notFound('Repository');
    if (repo.status !== 'connected') throw Errors.invalidState('The repository is not connected.');

    const active = await tx
      .selectFrom('indexing_jobs')
      .select('id')
      .where('repository_id', '=', req.repositoryId)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (active) return { indexingJobId: active.id, organizationId: req.organizationId, repositoryId: req.repositoryId, created: false };

    const job = await tx
      .insertInto('indexing_jobs')
      .values({
        organization_id: req.organizationId,
        repository_id: req.repositoryId,
        trigger: req.trigger,
        requested_ref: req.ref ?? null,
        commit_sha: req.commitSha ?? null,
        requested_by: req.requestedBy ?? null,
        progress: json({}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx.updateTable('repositories').set({ indexing_status: 'queued' }).where('id', '=', req.repositoryId).execute();
    return { indexingJobId: job.id, organizationId: req.organizationId, repositoryId: req.repositoryId, created: true };
  }

  /** Enqueue after the transaction commits. Failures are logged; the recovery sweep re-enqueues. */
  async dispatch(results: IndexRequestResult[]): Promise<void> {
    for (const r of results) {
      if (!r.created) continue;
      try {
        await this.queues.enqueueIndex({ indexingJobId: r.indexingJobId, organizationId: r.organizationId, repositoryId: r.repositoryId });
      } catch (err) {
        log.error({ err: (err as Error).message, indexing_job_id: r.indexingJobId }, 'failed to enqueue indexing job; recovery sweep will retry');
      }
    }
  }
}
