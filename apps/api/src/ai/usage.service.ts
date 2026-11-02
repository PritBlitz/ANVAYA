import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { type Db, DatabaseService, type Tx } from '../database/database.service.js';
import { AccessService } from '../workspaces/access.service.js';

export interface UsageInput {
  organizationId: string;
  runId?: string | null;
  provider: string;
  model: string;
  operation: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostMicrounits?: number | null;
  durationMs?: number | null;
}

/** Token/cost/latency tracking (FR-OBS-003, PRD §6.8). */
@Injectable()
export class UsageService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
  ) {}

  async record(u: UsageInput, executor: Db | Tx = this.database.db): Promise<void> {
    await executor
      .insertInto('usage_records')
      .values({
        organization_id: u.organizationId,
        run_id: u.runId ?? null,
        provider: u.provider,
        model: u.model,
        operation: u.operation,
        input_tokens: u.inputTokens ?? null,
        output_tokens: u.outputTokens ?? null,
        estimated_cost_microunits: u.estimatedCostMicrounits ?? null,
        duration_ms: u.durationMs ?? null,
      })
      .execute();
  }

  /** `to` = null means open-ended (records are timestamped by the database clock, not this host's). */
  async summary(userId: string, workspaceId: string, from: Date, to: Date | null) {
    await this.access.requireWorkspace(userId, workspaceId, 'member');
    const base = () => {
      const q = this.database.db.selectFrom('usage_records').where('organization_id', '=', workspaceId).where('created_at', '>=', from);
      return to ? q.where('created_at', '<', to) : q;
    };
    const agg = [
      sql<number>`count(*)::int`.as('requests'),
      sql<number>`coalesce(sum(input_tokens), 0)::bigint`.as('input_tokens'),
      sql<number>`coalesce(sum(output_tokens), 0)::bigint`.as('output_tokens'),
      sql<number | null>`sum(estimated_cost_microunits)::bigint`.as('estimated_cost_microunits'),
      sql<number>`coalesce(avg(duration_ms), 0)::int`.as('avg_duration_ms'),
    ] as const;
    const totals = await base().select(agg).executeTakeFirstOrThrow();
    const byProvider = await base().select(['provider', 'model', ...agg]).groupBy(['provider', 'model']).orderBy('provider').limit(100).execute();
    const byOperation = await base().select(['operation', ...agg]).groupBy('operation').orderBy('operation').limit(100).execute();
    const localRequests = byProvider.filter((p) => p.provider === 'ollama').reduce((s, p) => s + p.requests, 0);
    const mockRequests = byProvider.filter((p) => p.provider === 'mock').reduce((s, p) => s + p.requests, 0);
    return {
      workspace_id: workspaceId,
      period: { from: from.toISOString(), to: to?.toISOString() ?? null },
      totals,
      local_vs_hosted: { local: localRequests, mock: mockRequests, hosted: totals.requests - localRequests - mockRequests },
      by_provider: byProvider,
      by_operation: byOperation,
    };
  }
}
