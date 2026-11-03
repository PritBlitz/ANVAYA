import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { type AppError, Errors } from '../common/errors.js';
import { type Db, DatabaseService, type Tx } from '../database/database.service.js';
import { RUN_ACTIVE_STATUSES } from '../database/types.js';
import { AccessService } from '../workspaces/access.service.js';
import type { RunQuotas } from '../workspaces/workspaces.schemas.js';
import { storedRunQuotas } from '../workspaces/workspaces.service.js';

/** The UTC calendar day containing `now`: daily quotas reset at UTC midnight. */
export function utcDayWindow(now = new Date()): { start: Date; end: Date; retryAfterSeconds: number } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 86_400_000);
  return { start, end, retryAfterSeconds: Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000)) };
}

export interface QuotaUsage {
  activeRuns: number;
  runsToday: number;
  tokensToday: number;
}

/**
 * Admin-configured workspace quotas and concurrency limits (FR-OBS-004):
 * max active runs, runs per UTC day, and model tokens (input + output) per UTC
 * day. Enforced server-side when a run starts and before every model call.
 */
@Injectable()
export class QuotaService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
  ) {}

  async quotas(organizationId: string, executor: Db | Tx = this.database.db): Promise<RunQuotas> {
    const org = await executor.selectFrom('organizations').select('settings').where('id', '=', organizationId).executeTakeFirstOrThrow();
    return storedRunQuotas(org.settings);
  }

  async usage(organizationId: string, now = new Date(), executor: Db | Tx = this.database.db): Promise<QuotaUsage> {
    const { start } = utcDayWindow(now);
    const active = await executor
      .selectFrom('workflow_runs')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('organization_id', '=', organizationId)
      .where('status', 'in', [...RUN_ACTIVE_STATUSES])
      .executeTakeFirstOrThrow();
    const today = await executor
      .selectFrom('workflow_runs')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('organization_id', '=', organizationId)
      .where('created_at', '>=', start)
      .executeTakeFirstOrThrow();
    return { activeRuns: Number(active.n), runsToday: Number(today.n), tokensToday: await this.tokensSince(organizationId, start, executor) };
  }

  private async tokensSince(organizationId: string, start: Date, executor: Db | Tx): Promise<number> {
    const row = await executor
      .selectFrom('usage_records')
      .select(sql<string>`coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0)::bigint`.as('n'))
      .where('organization_id', '=', organizationId)
      .where('created_at', '>=', start)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** Limits and current usage, for the settings screen. Any workspace member may read it. */
  async status(userId: string, workspaceId: string, now = new Date()) {
    await this.access.requireWorkspace(userId, workspaceId);
    const q = await this.quotas(workspaceId);
    const u = await this.usage(workspaceId, now);
    const { start, end } = utcDayWindow(now);
    const entry = (limit: number | undefined, used: number) => ({ limit: limit ?? null, used, remaining: limit === undefined ? null : Math.max(0, limit - used) });
    return {
      workspace_id: workspaceId,
      active_runs: entry(q.max_active_runs, u.activeRuns),
      daily_runs: entry(q.daily_runs, u.runsToday),
      daily_tokens: entry(q.daily_tokens, u.tokensToday),
      window_start: start.toISOString(),
      resets_at: end.toISOString(),
    };
  }

  /**
   * Called inside the run-start transaction, before the run row is inserted.
   * Locks the workspace row so concurrent starts are admitted one at a time.
   */
  async assertCanStartRun(tx: Tx, organizationId: string, now = new Date()): Promise<void> {
    await tx.selectFrom('organizations').select('id').where('id', '=', organizationId).forUpdate().executeTakeFirstOrThrow();
    const q = await this.quotas(organizationId, tx);
    if (q.max_active_runs === undefined && q.daily_runs === undefined && q.daily_tokens === undefined) return;
    const u = await this.usage(organizationId, now, tx);
    const { end, retryAfterSeconds } = utcDayWindow(now);
    if (q.max_active_runs !== undefined && u.activeRuns >= q.max_active_runs) throw Errors.concurrencyLimit(q.max_active_runs, u.activeRuns);
    if (q.daily_runs !== undefined && u.runsToday >= q.daily_runs) throw Errors.quotaExceeded('daily_runs', q.daily_runs, u.runsToday, end, retryAfterSeconds);
    if (q.daily_tokens !== undefined && u.tokensToday >= q.daily_tokens) throw Errors.quotaExceeded('daily_tokens', q.daily_tokens, u.tokensToday, end, retryAfterSeconds);
  }

  /** Before a model call: the QUOTA_EXCEEDED error when the daily token quota is used up, else null. */
  async tokenQuotaError(organizationId: string, now = new Date()): Promise<AppError | null> {
    const q = await this.quotas(organizationId);
    if (q.daily_tokens === undefined) return null;
    const { start, end, retryAfterSeconds } = utcDayWindow(now);
    const used = await this.tokensSince(organizationId, start, this.database.db);
    return used >= q.daily_tokens ? Errors.quotaExceeded('daily_tokens', q.daily_tokens, used, end, retryAfterSeconds) : null;
  }
}
