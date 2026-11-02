import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.service.js';
import { json } from '../src/database/types.js';
import { WorkspaceManager } from '../src/execution/workspace.js';
import { ObjectStorage } from '../src/storage/object-storage.js';
import { RetentionService } from '../src/worker/retention.service.js';
import { as, bootApp, createWorkspace, db, login } from './helpers.js';

describe('data retention', () => {
  let app: INestApplication;
  let retention: RetentionService;
  const wsDir = mkdtempSync(join(tmpdir(), 'anvaya-ret-'));

  async function seedRepo(orgId: string) {
    const d = db(app);
    const repo = await d
      .insertInto('repositories')
      .values({ organization_id: orgId, external_repository_id: 8_000_000_000 + Math.floor(Math.random() * 1e6), owner: 'o', name: randomUUID().slice(0, 8), full_name: `o/${randomUUID().slice(0, 8)}`, settings: json({}) })
      .returning('id')
      .executeTakeFirstOrThrow();
    const old = await d
      .insertInto('repository_snapshots')
      .values({ repository_id: repo.id, commit_sha: 'a'.repeat(40), status: 'ready', language_stats: json({}), created_at: new Date(Date.now() - 100 * 86400_000) })
      .returning('id')
      .executeTakeFirstOrThrow();
    const latestOld = await d
      .insertInto('repository_snapshots')
      .values({ repository_id: repo.id, commit_sha: 'b'.repeat(40), status: 'ready', language_stats: json({}), created_at: new Date(Date.now() - 90 * 86400_000) })
      .returning('id')
      .executeTakeFirstOrThrow();
    await d.updateTable('repositories').set({ latest_indexed_commit_sha: 'b'.repeat(40) }).where('id', '=', repo.id).execute();
    return { repo: repo.id, old: old.id, latest: latestOld.id };
  }

  beforeAll(async () => {
    process.env.WORKSPACES_DIR = wsDir;
    app = await bootApp();
    retention = new RetentionService(app.get(DatabaseService), app.get(ObjectStorage), app.get(WorkspaceManager), app.get(AppConfig));
  });
  afterAll(async () => {
    await app.close();
  });

  it('applies configured snapshot retention but never deletes the latest indexed snapshot', async () => {
    const owner = await login(app);
    const ws = await createWorkspace(owner);
    await as(owner, 'patch', `/workspaces/${ws}`).send({ settings: { retention: { snapshot_days: 30 } } }).expect(200);
    const seeded = await seedRepo(ws);
    const report = await retention.sweep();
    expect(report.snapshots_deleted).toBeGreaterThanOrEqual(1);
    const left = await db(app).selectFrom('repository_snapshots').select('id').where('repository_id', '=', seeded.repo).execute();
    expect(left.map((l) => l.id)).toEqual([seeded.latest]);
  });

  it('deletes nothing for workspaces without a retention policy', async () => {
    const owner = await login(app);
    const ws = await createWorkspace(owner);
    const seeded = await seedRepo(ws);
    await retention.sweep();
    const left = await db(app).selectFrom('repository_snapshots').select('id').where('repository_id', '=', seeded.repo).execute();
    expect(left).toHaveLength(2);
  });

  it('purges expired operational records but keeps audit events', async () => {
    const user = await login(app);
    const d = db(app);
    await d
      .insertInto('sessions')
      .values({ user_id: user.id, token_hash: randomUUID(), csrf_token_hash: 'x', expires_at: new Date(Date.now() - 40 * 86400_000) })
      .execute();
    await d
      .insertInto('idempotency_keys')
      .values({ user_id: user.id, endpoint: 'POST /x', idempotency_key: `k-${randomUUID()}`, request_hash: 'h', status: 'completed', expires_at: new Date(Date.now() - 1000) })
      .execute();
    const auditBefore = await d.selectFrom('audit_events').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const report = await retention.sweep();
    expect(report.sessions_deleted).toBeGreaterThanOrEqual(1);
    expect(report.idempotency_keys_deleted).toBeGreaterThanOrEqual(1);
    const auditAfter = await d.selectFrom('audit_events').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    expect(Number(auditAfter.n)).toBeGreaterThanOrEqual(Number(auditBefore.n));
    // The current session still works.
    await as(user, 'get', '/me').expect(200);
  });

  it('removes orphaned execution workspaces', async () => {
    const orphan = randomUUID();
    mkdirSync(join(wsDir, orphan, 'repo'), { recursive: true });
    const report = await retention.sweep();
    expect(report.orphan_workspaces_removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(wsDir, orphan))).toBe(false);
  });
});
