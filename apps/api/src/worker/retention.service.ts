import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { logger } from '../common/logger.js';
import { AppConfig } from '../config/config.js';
import { DatabaseService } from '../database/database.service.js';
import { WorkspaceManager } from '../execution/workspace.js';
import { RUN_TERMINAL_STATUSES } from '../database/types.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { retentionSettingsSchema } from '../workspaces/workspaces.schemas.js';

const log = logger('retention');
const BATCH = 200;

export interface RetentionReport {
  snapshots_deleted: number;
  logs_deleted: number;
  run_artifacts_deleted: number;
  sessions_deleted: number;
  idempotency_keys_deleted: number;
  webhook_deliveries_deleted: number;
  orphan_workspaces_removed: number;
}

/**
 * Data retention (DATABASE §8, SECURITY §9). Workspace-configured windows
 * (`settings.retention`) are applied only when set — nothing is deleted by
 * default. The latest indexed snapshot of a repository is never deleted.
 * Audit events are not touched (separate retention requirement).
 */
@Injectable()
export class RetentionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: ObjectStorage,
    private readonly workspaces: WorkspaceManager,
    private readonly config: AppConfig,
  ) {}

  async sweep(now = new Date()): Promise<RetentionReport> {
    const db = this.database.db;
    const report: RetentionReport = { snapshots_deleted: 0, logs_deleted: 0, run_artifacts_deleted: 0, sessions_deleted: 0, idempotency_keys_deleted: 0, webhook_deliveries_deleted: 0, orphan_workspaces_removed: 0 };
    const orgs = await db.selectFrom('organizations').select(['id', 'settings']).where(sql<boolean>`settings ? 'retention'`).execute();
    for (const org of orgs) {
      const r = retentionSettingsSchema.safeParse(org.settings.retention);
      if (!r.success) continue;
      const days = (n: number) => new Date(now.getTime() - n * 86400 * 1000);

      if (r.data.snapshot_days) {
        const old = await db
          .selectFrom('repository_snapshots as s')
          .innerJoin('repositories as r', 'r.id', 's.repository_id')
          .select('s.id')
          .where('r.organization_id', '=', org.id)
          .where('s.created_at', '<', days(r.data.snapshot_days))
          .where((eb) => eb.or([eb('r.latest_indexed_commit_sha', 'is', null), eb('s.commit_sha', '!=', eb.ref('r.latest_indexed_commit_sha'))]))
          .where((eb) => eb.not(eb.exists(eb.selectFrom('workflow_runs as w').select('w.id').whereRef('w.snapshot_id', '=', 's.id').where('w.status', 'not in', [...RUN_TERMINAL_STATUSES]))))
          .limit(BATCH)
          .execute();
        if (old.length) {
          const res = await db
            .deleteFrom('repository_snapshots')
            .where(
              'id',
              'in',
              old.map((o) => o.id),
            )
            .executeTakeFirst();
          report.snapshots_deleted += Number(res.numDeletedRows);
        }
      }

      if (r.data.log_days) {
        const logs = await db
          .selectFrom('verification_runs as v')
          .innerJoin('workflow_runs as w', 'w.id', 'v.run_id')
          .select(['v.id', 'v.stdout_object_key', 'v.stderr_object_key'])
          .where('w.organization_id', '=', org.id)
          .where('v.created_at', '<', days(r.data.log_days))
          .where((eb) => eb.or([eb('v.stdout_object_key', 'is not', null), eb('v.stderr_object_key', 'is not', null)]))
          .limit(BATCH)
          .execute();
        for (const l of logs) {
          for (const key of [l.stdout_object_key, l.stderr_object_key]) if (key) await this.storage.deletePrefix(key);
          await db.updateTable('verification_runs').set({ stdout_object_key: null, stderr_object_key: null }).where('id', '=', l.id).execute();
          report.logs_deleted++;
        }
      }

      if (r.data.run_artifact_days) {
        const runs = await db
          .selectFrom('workflow_runs')
          .select('id')
          .where('organization_id', '=', org.id)
          .where('status', 'in', [...RUN_TERMINAL_STATUSES])
          .where('ended_at', '<', days(r.data.run_artifact_days))
          .where(sql<boolean>`NOT coalesce((checkpoint->>'artifacts_purged')::boolean, false)`)
          .limit(BATCH)
          .execute();
        for (const run of runs) {
          await this.storage.deletePrefix(`runs/${run.id}`);
          await db
            .updateTable('workflow_runs')
            .set({ checkpoint: sql`checkpoint || '{"artifacts_purged": true}'::jsonb` })
            .where('id', '=', run.id)
            .execute();
          report.run_artifacts_deleted++;
        }
      }
    }

    // Operational records with fixed lifetimes.
    report.sessions_deleted = Number(
      (await db.deleteFrom('sessions').where((eb) => eb.or([eb('expires_at', '<', sql<Date>`now() - interval '30 days'`), eb('revoked_at', '<', sql<Date>`now() - interval '30 days'`)])).executeTakeFirst()).numDeletedRows,
    );
    report.idempotency_keys_deleted = Number((await db.deleteFrom('idempotency_keys').where('expires_at', '<', sql<Date>`now()`).executeTakeFirst()).numDeletedRows);
    report.webhook_deliveries_deleted = Number((await db.deleteFrom('webhook_deliveries').where('received_at', '<', sql<Date>`now() - interval '30 days'`).executeTakeFirst()).numDeletedRows);
    report.orphan_workspaces_removed = await this.removeOrphanWorkspaces();
    if (Object.values(report).some((n) => n > 0)) log.info(report, 'retention sweep');
    return report;
  }

  /** Workspace directories for runs that are finished (or unknown) are removed. */
  private async removeOrphanWorkspaces(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(resolve(this.config.env.WORKSPACES_DIR));
    } catch {
      return 0;
    }
    const ids = entries.filter((e) => /^[0-9a-f-]{36}$/.test(e));
    if (ids.length === 0) return 0;
    const active = await this.database.db.selectFrom('workflow_runs').select('id').where('id', 'in', ids).where('status', 'not in', [...RUN_TERMINAL_STATUSES]).execute();
    const keep = new Set(active.map((a) => a.id));
    let removed = 0;
    for (const id of ids) {
      if (keep.has(id)) continue;
      await this.workspaces.cleanup(id);
      removed++;
    }
    return removed;
  }
}
