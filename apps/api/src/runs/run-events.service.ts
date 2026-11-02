import { Injectable } from '@nestjs/common';
import { logger } from '../common/logger.js';
import { RedisService } from '../common/redis.service.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { json } from '../database/types.js';

const log = logger('run-events');

/** SSE event names (API_SPEC §8). */
export type RunEventType =
  | 'run.created'
  | 'dependencies.installed'
  | 'run.status.changed'
  | 'run.stage.changed'
  | 'retrieval.completed'
  | 'agent.started'
  | 'agent.completed'
  | 'agent.failed'
  | 'tool.started'
  | 'tool.completed'
  | 'patch.proposed'
  | 'sandbox.started'
  | 'verification.completed'
  | 'review.finding.created'
  | 'approval.required'
  | 'pull_request.created'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

export function channel(runId: string): string {
  return `run-events:${runId}`;
}

/**
 * Durable run event log (outbox). Events are inserted in the same transaction
 * as the state change they describe; Redis pub/sub only wakes SSE listeners
 * after commit. Payloads must never contain secrets or raw logs.
 */
@Injectable()
export class RunEventsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async emit(tx: Tx, run: { id: string; organization_id: string }, type: RunEventType, payload: Record<string, unknown> = {}): Promise<number> {
    const row = await tx
      .insertInto('run_events')
      .values({ run_id: run.id, organization_id: run.organization_id, event_type: type, payload: json({ run_id: run.id, ...payload, timestamp: new Date().toISOString() }) })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Call after commit. Best-effort: SSE listeners also poll. */
  async notify(runId: string): Promise<void> {
    try {
      await this.redis.client.publish(channel(runId), '1');
    } catch (err) {
      log.warn({ run_id: runId, err: (err as Error).message }, 'event notify failed; listeners will poll');
    }
  }

  async since(runId: string, afterId: number, limit = 200) {
    return this.database.db
      .selectFrom('run_events')
      .select(['id', 'event_type', 'payload'])
      .where('run_id', '=', runId)
      .where('id', '>', afterId)
      .orderBy('id')
      .limit(limit)
      .execute();
  }
}
