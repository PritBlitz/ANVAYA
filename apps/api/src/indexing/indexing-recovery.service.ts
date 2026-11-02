import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { logger } from '../common/logger.js';
import { DatabaseService } from '../database/database.service.js';
import { QUEUES, QueueService } from '../queue/queues.js';

const log = logger('indexing-recovery');
const MAX_ATTEMPTS = 3;

/**
 * PostgreSQL is the source of truth for indexing jobs; Redis may lose jobs.
 * This sweep (a) re-enqueues durable `queued` jobs whose queue entry is gone,
 * and (b) recovers `running` jobs whose worker stopped heartbeating.
 */
@Injectable()
export class IndexingRecoveryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly queues: QueueService,
  ) {}

  async sweep(opts: { queuedGraceSeconds?: number; staleRunningSeconds?: number } = {}): Promise<{ requeued: number; recovered: number; failed: number }> {
    const db = this.database.db;
    const queue = this.queues.queue(QUEUES.repositoryIndex);
    let requeued = 0;
    let recovered = 0;
    let failed = 0;

    const stale = await db
      .selectFrom('indexing_jobs')
      .select(['id', 'attempts'])
      .where('status', '=', 'running')
      .where('updated_at', '<', sql<Date>`now() - ${`${opts.staleRunningSeconds ?? 900} seconds`}::interval`)
      .limit(100)
      .execute();
    for (const j of stale) {
      if (j.attempts >= MAX_ATTEMPTS) {
        await db
          .updateTable('indexing_jobs')
          .set({ status: 'failed', error_code: 'WORKER_LOST', error_summary: 'The indexing worker stopped responding too many times.', ended_at: new Date() })
          .where('id', '=', j.id)
          .where('status', '=', 'running')
          .execute();
        failed++;
      } else {
        await db.updateTable('indexing_jobs').set({ status: 'queued', stage: 'recovered' }).where('id', '=', j.id).where('status', '=', 'running').execute();
        recovered++;
      }
    }

    const queued = await db
      .selectFrom('indexing_jobs')
      .select(['id', 'organization_id', 'repository_id'])
      .where('status', '=', 'queued')
      .where('updated_at', '<', sql<Date>`now() - ${`${opts.queuedGraceSeconds ?? 120} seconds`}::interval`)
      .limit(100)
      .execute();
    for (const j of queued) {
      const existing = await queue.getJob(j.id);
      const state = existing ? await existing.getState() : 'missing';
      if (state === 'waiting' || state === 'active' || state === 'delayed' || state === 'prioritized' || state === 'waiting-children') continue;
      if (existing) await existing.remove().catch(() => undefined);
      await this.queues.enqueueIndex({ indexingJobId: j.id, organizationId: j.organization_id, repositoryId: j.repository_id });
      requeued++;
    }
    if (requeued + recovered + failed > 0) log.info({ requeued, recovered, failed }, 'indexing recovery sweep');
    return { requeued, recovered, failed };
  }
}
