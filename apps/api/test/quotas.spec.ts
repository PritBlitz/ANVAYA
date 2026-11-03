import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { utcDayWindow } from '../src/ai/quota.service.js';
import { OrchestratorService } from '../src/runs/orchestrator.service.js';
import { FakeAi } from './fake-ai.js';
import { FakeGithub } from './fake-github.js';
import { addMember, as, bootApp, createWorkspace, db, login, type TestUser } from './helpers.js';
import { externalId, linkInstallation, runIndexing } from './scenario.js';
import { buildTarball } from './tarball.js';

const SHA = 'a1'.repeat(20);

describe('workspace quotas and concurrency limits (FR-OBS-004)', () => {
  const gh = new FakeGithub();
  const ai = new FakeAi();
  let app: INestApplication;
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let ws: string;
  let repo: string;

  const setQuotas = (user: TestUser, run_quotas: Record<string, number | null>) => as(user, 'patch', `/workspaces/${ws}`).send({ settings: { run_quotas } });
  const newTask = async () =>
    (await as(member, 'post', `/repositories/${repo}/tasks`).send({ source_type: 'manual', title: 'Quota task', description: 'Refresh the token cache.' }).expect(201)).body.data.id as string;
  const cancelActive = async () => {
    const runs = await db(app).selectFrom('workflow_runs').select('id').where('organization_id', '=', ws).where('status', 'not in', ['completed', 'failed', 'cancelled', 'timed_out', 'rejected', 'completed_without_pr']).execute();
    for (const r of runs) await as(member, 'post', `/runs/${r.id}/cancel`).send({}).expect(200);
  };

  beforeAll(async () => {
    await gh.start();
    await ai.start();
    Object.assign(process.env, gh.env(), { AI_SERVICE_URL: ai.url });
    app = await bootApp();
    [owner, admin, member, viewer, outsider] = await Promise.all([login(app), login(app), login(app), login(app), login(app)]);
    ws = await createWorkspace(owner);
    await addMember(owner, admin, ws, 'admin');
    await addMember(owner, member, ws, 'member');
    await addMember(owner, viewer, ws, 'viewer');
    const link = await linkInstallation(gh, owner, ws);
    const ext = externalId();
    gh.addRepo(
      {
        id: ext,
        owner: 'acme',
        name: 'quota',
        default_branch: 'main',
        private: true,
        branches: { main: SHA },
        tarballs: { [SHA]: await buildTarball('acme-quota', [{ name: 'src/cache.ts', content: 'export function refreshTokenCache() {\n  return new Map<string, string>();\n}\n' }]) },
      },
      link.installationId,
    );
    repo = (await as(owner, 'post', '/repositories').send({ workspace_id: ws, installation_id: link.installationUuid, external_repository_id: ext }).expect(201)).body.data.id;
    await runIndexing(app, repo);
  });

  beforeEach(async () => {
    await cancelActive();
    await setQuotas(owner, { max_active_runs: null, daily_runs: null, daily_tokens: null }).expect(200);
    ai.generateCalls = [];
    ai.generateHandler = undefined;
  });

  afterAll(async () => {
    await app.close();
    await gh.stop();
    await ai.stop();
  });

  it('only admins and owners can edit quotas, and changes are audited', async () => {
    await setQuotas(member, { max_active_runs: 2 }).expect(403);
    await setQuotas(viewer, { max_active_runs: 2 }).expect(403);
    await setQuotas(outsider, { max_active_runs: 2 }).expect(404);
    await setQuotas(admin, { max_active_runs: 0 }).expect(422);
    await setQuotas(admin, { daily_tokens: 10 }).expect(422);

    const res = await setQuotas(admin, { max_active_runs: 2, daily_runs: 50, daily_tokens: 100_000 }).expect(200);
    expect(res.body.data.settings.run_quotas).toEqual({ max_active_runs: 2, daily_runs: 50, daily_tokens: 100_000 });
    // Partial update keeps the other limits; null removes one.
    const cleared = await setQuotas(admin, { daily_runs: null }).expect(200);
    expect(cleared.body.data.settings.run_quotas).toEqual({ max_active_runs: 2, daily_tokens: 100_000 });
    const events = await db(app)
      .selectFrom('audit_events')
      .select(['actor_user_id', 'metadata_redacted'])
      .where('organization_id', '=', ws)
      .where('action', '=', 'workspace.quotas_updated')
      .where('actor_user_id', '=', admin.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .execute();
    expect(events[0]).toMatchObject({ actor_user_id: admin.id, metadata_redacted: { from: { max_active_runs: 2, daily_runs: 50, daily_tokens: 100_000 }, to: { max_active_runs: 2, daily_tokens: 100_000 } } });
  });

  it('exposes limits and current usage to members, never to other tenants', async () => {
    await setQuotas(owner, { max_active_runs: 3, daily_tokens: 50_000 }).expect(200);
    const res = await as(viewer, 'get', `/workspaces/${ws}/quotas`).expect(200);
    const { start, end } = utcDayWindow();
    expect(res.body.data).toMatchObject({
      workspace_id: ws,
      active_runs: { limit: 3, used: 0, remaining: 3 },
      daily_runs: { limit: null, remaining: null },
      daily_tokens: { limit: 50_000 },
      window_start: start.toISOString(),
      resets_at: end.toISOString(),
    });
    await as(outsider, 'get', `/workspaces/${ws}/quotas`).expect(404);
  });

  it('rejects a run beyond the concurrency limit with CONCURRENCY_LIMIT_REACHED (429)', async () => {
    await setQuotas(owner, { max_active_runs: 1 }).expect(200);
    const first = (await as(member, 'post', `/tasks/${await newTask()}/runs`).send({}).expect(202)).body.data.id as string;
    const blocked = await as(member, 'post', `/tasks/${await newTask()}/runs`).send({}).expect(429);
    expect(blocked.body.error).toMatchObject({ code: 'CONCURRENCY_LIMIT_REACHED', details: { limit: 1, active_runs: 1 } });
    expect(blocked.headers['retry-after']).toBeUndefined();
    const status = await as(member, 'get', `/workspaces/${ws}/quotas`).expect(200);
    expect(status.body.data.active_runs).toEqual({ limit: 1, used: 1, remaining: 0 });
    await as(member, 'post', `/runs/${first}/cancel`).send({}).expect(200);
    await as(member, 'post', `/tasks/${await newTask()}/runs`).send({}).expect(202);
  });

  it('admits exactly one of several concurrent starts at a limit of one', async () => {
    await setQuotas(owner, { max_active_runs: 1 }).expect(200);
    const tasks = await Promise.all([newTask(), newTask(), newTask(), newTask()]);
    const results = await Promise.all(tasks.map((t) => as(member, 'post', `/tasks/${t}/runs`).send({})));
    expect(results.map((r) => r.status).sort()).toEqual([202, 429, 429, 429]);
  });

  it('replays an idempotent start instead of counting it twice', async () => {
    await setQuotas(owner, { max_active_runs: 1 }).expect(200);
    const task = await newTask();
    const key = `quota-start-${Date.now()}`;
    const a = await as(member, 'post', `/tasks/${task}/runs`, { idempotencyKey: key }).send({}).expect(202);
    const b = await as(member, 'post', `/tasks/${task}/runs`, { idempotencyKey: key }).send({}).expect(202);
    expect(b.body.data.id).toBe(a.body.data.id);
  });

  it('enforces the daily run quota with Retry-After until UTC midnight', async () => {
    const today = await as(member, 'get', `/workspaces/${ws}/quotas`).expect(200);
    const used = today.body.data.daily_runs.used as number;
    expect(used).toBeGreaterThan(0);
    await setQuotas(owner, { daily_runs: used }).expect(200);
    const res = await as(member, 'post', `/tasks/${await newTask()}/runs`).send({}).expect(429);
    expect(res.body.error).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { quota: 'daily_runs', limit: used, used, resets_at: utcDayWindow().end.toISOString() } });
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
    expect(Math.abs(retryAfter - utcDayWindow().retryAfterSeconds)).toBeLessThan(5);
    // Raising the quota admits exactly one more run today.
    await setQuotas(owner, { daily_runs: used + 1 }).expect(200);
    await as(member, 'post', `/tasks/${await newTask()}/runs`).send({}).expect(202);
    await as(member, 'post', `/tasks/${await newTask()}/runs`).send({}).expect(429);
  });

  describe('daily token quota', () => {
    it('fails a running workflow gracefully before its next model call', async () => {
      await setQuotas(owner, { daily_tokens: 1_000_000 }).expect(200);
      const run = (await as(member, 'post', `/tasks/${await newTask()}/runs`).send({}).expect(202)).body.data.id as string;
      // Usage elsewhere in the workspace exhausts the quota after the run started.
      await db(app)
        .insertInto('usage_records')
        .values({ organization_id: ws, provider: 'ollama', model: 'm', operation: 'repository_qa', input_tokens: 900_000, output_tokens: 100_000 })
        .execute();
      await app.get(OrchestratorService).advance(run);
      const detail = (await as(member, 'get', `/runs/${run}`).expect(200)).body.data;
      expect(detail).toMatchObject({ status: 'failed', error_code: 'QUOTA_EXCEEDED' });
      expect(detail.error_summary).toContain('daily quota');
      expect(ai.generateCalls).toHaveLength(0);
    });

    it('refuses to start runs and to answer questions once the quota is used up', async () => {
      await setQuotas(owner, { daily_tokens: 1_000_000 }).expect(200);
      const start = await as(member, 'post', `/tasks/${await newTask()}/runs`).send({}).expect(429);
      expect(start.body.error.details).toMatchObject({ quota: 'daily_tokens', limit: 1_000_000 });
      expect(Number(start.headers['retry-after'])).toBeGreaterThan(0);
      const qa = await as(member, 'post', `/repositories/${repo}/questions`).send({ question: 'Where is refreshTokenCache defined?' }).expect(429);
      expect(qa.body.error.code).toBe('QUOTA_EXCEEDED');
      expect(ai.generateCalls).toHaveLength(0);
      const status = await as(member, 'get', `/workspaces/${ws}/quotas`).expect(200);
      expect(status.body.data.daily_tokens).toMatchObject({ limit: 1_000_000, remaining: 0 });
      expect(status.body.data.daily_tokens.used).toBeGreaterThanOrEqual(1_000_000);
    });
  });
});
