import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrchestratorService } from '../src/runs/orchestrator.service.js';
import { FakeAi, type GenerateHandler } from './fake-ai.js';
import { FakeGithub } from './fake-github.js';
import { addMember, as, bootApp, createWorkspace, db, login, type TestUser } from './helpers.js';
import { externalId, linkInstallation, runIndexing } from './scenario.js';
import { buildTarball } from './tarball.js';

/**
 * Contract items agreed with the frontend session (frontend GAP ids):
 * GAP-02 X-Workspace-Id, GAP-05 GET /runs, GAP-19 approvals on run detail,
 * R1 run labels + pull_request, R2 task list labels + latest_run, R3 daily usage.
 */
const SHA = 'e'.repeat(40);

type Body = Record<string, unknown> & { task: string; evidence: Array<{ id: string }>; mode: string };
const plan = {
  objective: 'Handle expired access tokens',
  assumptions: [],
  steps: [{ id: 'step-1', description: 'Update refresh logic', files: ['src/token.ts'], verification: ['unit tests'] }],
  files_to_modify: ['src/token.ts'],
  tests: [],
  risks: [],
  out_of_scope: [],
};
const handler: GenerateHandler = (raw) => {
  const b = raw as Body;
  const output =
    b.task === 'investigation'
      ? { summary: 'Refresh is handled in TokenService.', findings: [], hypotheses: [], unknowns: [], candidate_files: ['src/token.ts'] }
      : plan;
  return {
    body: {
      task: b.task,
      provider: 'ollama',
      model: 'test-model',
      mode: b.mode,
      prompt_version: `${b.task}.v1`,
      output,
      evidence_included: b.evidence.map((e) => e.id),
      usage: { input_tokens: 100, output_tokens: 20, estimated_cost_microunits: 0 },
      duration_ms: 5,
      schema_repair_attempted: false,
    },
  };
};

describe('frontend integration contract', () => {
  const gh = new FakeGithub();
  const ai = new FakeAi();
  let app: INestApplication;
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let ws: string;
  let otherWs: string;
  let repo: string;
  let installationUuid: string;
  let orchestrator: OrchestratorService;

  beforeAll(async () => {
    await gh.start();
    await ai.start();
    Object.assign(process.env, gh.env(), { AI_SERVICE_URL: ai.url });
    app = await bootApp();
    ai.generateHandler = handler;
    orchestrator = app.get(OrchestratorService);
    [owner, member, outsider] = await Promise.all([login(app), login(app), login(app)]);
    ws = await createWorkspace(owner);
    otherWs = await createWorkspace(outsider);
    await addMember(owner, member, ws, 'member');
    const link = await linkInstallation(gh, owner, ws);
    installationUuid = link.installationUuid;
    const ext = externalId();
    gh.addRepo(
      {
        id: ext,
        owner: 'acme',
        name: 'contract',
        default_branch: 'main',
        private: true,
        branches: { main: SHA },
        tarballs: { [SHA]: await buildTarball('acme-contract-e', [{ name: 'src/token.ts', content: 'export class TokenService {\n  refreshAccessToken(t: string) {\n    return t;\n  }\n}\n' }]) },
      },
      link.installationId,
    );
    // Register via the header only (no workspace_id in the body).
    repo = (await as(owner, 'post', '/repositories').set('X-Workspace-Id', ws).send({ installation_id: installationUuid, external_repository_id: ext }).expect(201)).body.data.id;
    await runIndexing(app, repo);
  });

  afterAll(async () => {
    await app.close();
    await gh.stop();
    await ai.stop();
  });

  describe('X-Workspace-Id (GAP-02)', () => {
    it('selects the workspace for list endpoints', async () => {
      const res = await as(member, 'get', '/repositories').set('X-Workspace-Id', ws).expect(200);
      expect(res.body.data.map((r: { id: string }) => r.id)).toContain(repo);
      await as(member, 'get', '/tasks').set('X-Workspace-Id', ws).expect(200);
      await as(member, 'get', '/runs').set('X-Workspace-Id', ws).expect(200);
      await as(owner, 'get', '/integrations/github/installations').set('X-Workspace-Id', ws).expect(200);
    });

    it('still accepts the workspace_id query parameter', async () => {
      await as(member, 'get', `/repositories?workspace_id=${ws}`).expect(200);
    });

    it('rejects a header that disagrees with workspace_id', async () => {
      const res = await as(member, 'get', `/repositories?workspace_id=${ws}`).set('X-Workspace-Id', otherWs).expect(400);
      expect(res.body.error.code).toBe('WORKSPACE_MISMATCH');
    });

    it('requires a workspace and validates the header format', async () => {
      const missing = await as(member, 'get', '/runs').expect(422);
      expect(missing.body.error.details.issues[0].path).toBe('workspace_id');
      await as(member, 'get', '/runs').set('X-Workspace-Id', 'not-a-uuid').expect(422);
    });

    it('never grants access: a non-member header gets 404', async () => {
      await as(outsider, 'get', '/repositories').set('X-Workspace-Id', ws).expect(404);
      await as(outsider, 'get', '/runs').set('X-Workspace-Id', ws).expect(404);
    });

    it('is ignored by id-addressed endpoints (authorization follows the resource)', async () => {
      await as(member, 'get', `/repositories/${repo}`).set('X-Workspace-Id', otherWs).expect(200);
      await as(outsider, 'get', `/repositories/${repo}`).set('X-Workspace-Id', otherWs).expect(404);
    });
  });

  describe('runs list, run detail and task list', () => {
    let taskId: string;
    let runId: string;

    beforeAll(async () => {
      taskId = (await as(member, 'post', `/repositories/${repo}/tasks`).send({ source_type: 'manual', title: 'Contract task', description: 'Fix the token refresh path.' }).expect(201)).body.data.id;
      runId = (await as(member, 'post', `/tasks/${taskId}/runs`).send({}).expect(202)).body.data.id;
      await orchestrator.advance(runId);
    });

    it('GET /runs lists workspace runs with labels and status filters (GAP-05)', async () => {
      const res = await as(member, 'get', '/runs?limit=10').set('X-Workspace-Id', ws).expect(200);
      const item = res.body.data.find((r: { id: string }) => r.id === runId);
      expect(item).toMatchObject({ id: runId, task_id: taskId, task_title: 'Contract task', repository_id: repo, repository_full_name: 'acme/contract', status: 'awaiting_plan_approval' });
      const filtered = await as(member, 'get', '/runs?status=awaiting_plan_approval&status=failed').set('X-Workspace-Id', ws).expect(200);
      expect(filtered.body.data.every((r: { status: string }) => ['awaiting_plan_approval', 'failed'].includes(r.status))).toBe(true);
      expect(filtered.body.data.some((r: { id: string }) => r.id === runId)).toBe(true);
      const none = await as(member, 'get', '/runs?status=completed').set('X-Workspace-Id', ws).expect(200);
      expect(none.body.data.some((r: { id: string }) => r.id === runId)).toBe(false);
      await as(member, 'get', '/runs?status=bogus').set('X-Workspace-Id', ws).expect(422);
    });

    it('GET /runs paginates with a keyset cursor', async () => {
      const page1 = await as(member, 'get', '/runs?limit=1').set('X-Workspace-Id', ws).expect(200);
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.meta.page).toBeDefined();
    });

    it('GET /runs/:id includes labels, approvals and pull_request (GAP-19, R1)', async () => {
      const before = await as(member, 'get', `/runs/${runId}`).expect(200);
      expect(before.body.data).toMatchObject({ task_title: 'Contract task', repository_full_name: 'acme/contract', approvals: [], pull_request: null });
      const planHash = before.body.data.plan_hash as string;
      await as(member, 'post', `/runs/${runId}/plan-approval`).send({ decision: 'rejected', comment: 'not now' }).expect(200);
      const after = await as(member, 'get', `/runs/${runId}`).expect(200);
      expect(after.body.data.approvals).toHaveLength(1);
      expect(after.body.data.approvals[0]).toMatchObject({ approval_type: 'plan', decision: 'rejected', subject_hash: planHash, comment: 'not now', user_id: member.id });
      expect(typeof after.body.data.approvals[0].created_at).toBe('string');
    });

    it('GET /tasks items carry repository_full_name and latest_run (R2)', async () => {
      const res = await as(member, 'get', '/tasks').set('X-Workspace-Id', ws).expect(200);
      const t = res.body.data.find((x: { id: string }) => x.id === taskId);
      expect(t).toMatchObject({ repository_full_name: 'acme/contract', latest_run: { id: runId, run_number: 1 } });
      const detail = await as(member, 'get', `/tasks/${taskId}`).expect(200);
      expect(detail.body.data).toMatchObject({ repository_full_name: 'acme/contract', latest_run: { id: runId } });
    });
  });

  describe('usage daily series (R3)', () => {
    it('is zero-filled per UTC day across the period', async () => {
      await db(app)
        .insertInto('usage_records')
        .values({ organization_id: ws, provider: 'ollama', model: 'm', operation: 'question', input_tokens: 10, output_tokens: 5, created_at: new Date('2026-03-02T23:30:00Z') })
        .execute();
      const res = await as(member, 'get', `/workspaces/${ws}/usage?from=2026-03-01T00:00:00Z&to=2026-03-04T00:00:00Z`).expect(200);
      expect(res.body.data.daily).toEqual([
        { date: '2026-03-01', requests: 0, input_tokens: 0, output_tokens: 0, estimated_cost_microunits: null },
        { date: '2026-03-02', requests: 1, input_tokens: 10, output_tokens: 5, estimated_cost_microunits: null },
        { date: '2026-03-03', requests: 0, input_tokens: 0, output_tokens: 0, estimated_cost_microunits: null },
      ]);
    });

    it('rejects inverted or over-long periods', async () => {
      await as(member, 'get', `/workspaces/${ws}/usage?from=2026-03-05T00:00:00Z&to=2026-03-01T00:00:00Z`).expect(422);
      await as(member, 'get', `/workspaces/${ws}/usage?from=2024-01-01T00:00:00Z&to=2026-03-01T00:00:00Z`).expect(422);
    });
  });

  describe('GitHub install completion (GAP-14)', () => {
    it('derives the workspace from the server-held state when workspace_id is omitted', async () => {
      const installationId = externalId();
      gh.installations.set(installationId, { id: installationId, account: 'acme2', repos: [] });
      const url = await as(owner, 'get', '/integrations/github/install-url').set('X-Workspace-Id', ws).expect(200);
      const code = `code-${installationId}`;
      gh.oauthCodes.set(code, [installationId]);
      const res = await as(owner, 'post', '/integrations/github/complete').send({ installation_id: installationId, state: url.body.data.state, code, setup_action: 'install' }).expect(200);
      expect(res.body.data.workspace_id).toBe(ws);
    });

    it('ignores X-Workspace-Id on completion and rejects a mismatched workspace_id', async () => {
      const installationId = externalId();
      gh.installations.set(installationId, { id: installationId, account: 'acme3', repos: [] });
      const url = await as(owner, 'get', `/integrations/github/install-url?workspace_id=${ws}`).expect(200);
      const code = `code-${installationId}`;
      gh.oauthCodes.set(code, [installationId]);
      const owned = await createWorkspace(owner);
      await as(owner, 'post', '/integrations/github/complete').send({ workspace_id: owned, installation_id: installationId, state: url.body.data.state, code }).expect(403);
    });

    it('a state issued to someone else cannot be redeemed', async () => {
      const installationId = externalId();
      gh.installations.set(installationId, { id: installationId, account: 'acme4', repos: [] });
      const url = await as(owner, 'get', `/integrations/github/install-url?workspace_id=${ws}`).expect(200);
      const code = `code-${installationId}`;
      gh.oauthCodes.set(code, [installationId]);
      await as(member, 'post', '/integrations/github/complete').send({ installation_id: installationId, state: url.body.data.state, code }).expect(403);
    });
  });
});
