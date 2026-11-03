import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrchestratorService } from '../src/runs/orchestrator.service.js';
import { FakeAi, type GenerateHandler } from './fake-ai.js';
import { FakeGithub } from './fake-github.js';
import { addMember, as, bootApp, createWorkspace, db, login, type TestUser } from './helpers.js';
import { externalId, linkInstallation, runIndexing } from './scenario.js';
import { buildTarball } from './tarball.js';

const SHA = 'b'.repeat(40);
const SHA_OTHER = 'c'.repeat(40);

const TOKEN_TS = `export function refreshToken(t: string): string {
  return issueToken(t);
}

export function issueToken(sub: string): string {
  return sub + ':1';
}
`;
const SESSION_TS = `import { refreshToken } from './token';

export function renewSession(id: string): string {
  return refreshToken(id);
}
`;
const TOKEN_TEST = `import { refreshToken } from '../src/token';

test('refresh', () => {
  refreshToken('a');
});
`;
const SESSION_TEST = `import { renewSession } from '../src/session';

test('renew', () => {
  renewSession('a');
});
`;

type Body = Record<string, unknown> & { task: string; evidence: Array<{ id: string; path: string }>; mode: string; context?: Record<string, unknown> };

function respond(body: Body, output: unknown) {
  return {
    body: {
      task: body.task,
      provider: 'ollama',
      model: 'test-model',
      mode: body.mode,
      prompt_version: `${body.task}.v1`,
      output,
      evidence_included: body.evidence.map((e) => e.id),
      usage: { input_tokens: 100, output_tokens: 50, estimated_cost_microunits: 0 },
      duration_ms: 5,
      schema_repair_attempted: false,
    },
  };
}

const handler: GenerateHandler = (raw) => {
  const b = raw as Body;
  if (b.task === 'investigation') return respond(b, { summary: 'Token refresh lives in src/token.ts.', findings: [], hypotheses: [], unknowns: [], candidate_files: ['src/token.ts'] });
  if (b.task === 'migration_plan') {
    return respond(b, {
      objective: 'Move token issuing to a dedicated service',
      assumptions: ['Callers only use refreshToken'],
      steps: [
        { id: 'step-1', description: 'Introduce TokenIssuer alongside issueToken', files: ['src/token.ts'], verification: ['existing tests'], rollback: 'Delete TokenIssuer; nothing calls it yet' },
        { id: 'step-2', description: 'Switch renewSession to TokenIssuer', files: ['src/session.ts', '../../etc/passwd'], verification: ['session tests'], rollback: 'Revert the session change' },
      ],
      files_to_modify: ['src/token.ts', 'src/session.ts'],
      tests: ['tests/token.test.ts'],
      risks: ['Tokens issued during rollout use two code paths'],
      out_of_scope: ['Changing the token format'],
      affected_areas: [{ area: 'Token issuing', description: 'issueToken and its callers', files: ['src/token.ts'], evidence_ids: [b.evidence[0]?.id ?? 'x', 'fabricated'] }],
      prerequisites: ['Agree on the TokenIssuer interface'],
      rollback_strategy: ['Each step is independently revertible'],
    });
  }
  if (b.task === 'repository_qa') {
    return respond(b, { answer: 'Tokens are refreshed in the auth repository.', citations: [{ evidence_id: b.evidence[0]!.id, supports: 'refresh' }, { evidence_id: 'made-up', supports: 'x' }], limitations: [], insufficient_evidence: false });
  }
  return respond(b, {
    objective: 'Fix token refresh',
    assumptions: [],
    steps: [{ id: 'step-1', description: 'Fix refresh', files: ['src/token.ts'], verification: ['tests'] }],
    files_to_modify: ['src/token.ts'],
    tests: ['tests/token.test.ts'],
    risks: [],
    out_of_scope: [],
  });
};

describe('work package B: templates, migration plans, call graph, impact, workspace search, providers', () => {
  const gh = new FakeGithub();
  const ai = new FakeAi();
  let app: INestApplication;
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let ws: string;
  let otherWs: string;
  let repo: string;
  let repo2: string;
  let otherRepo: string;
  let orchestrator: OrchestratorService;

  async function connect(user: TestUser, workspace: string, name: string, sha: string, files: Array<{ name: string; content: string }>) {
    const link = await linkInstallation(gh, user, workspace);
    const ext = externalId();
    gh.addRepo({ id: ext, owner: 'acme', name, default_branch: 'main', private: true, branches: { main: sha }, tarballs: { [sha]: await buildTarball(`acme-${name}-x`, files) } }, link.installationId);
    const id = (await as(user, 'post', '/repositories').send({ workspace_id: workspace, installation_id: link.installationUuid, external_repository_id: ext }).expect(201)).body.data.id as string;
    await runIndexing(app, id);
    return id;
  }

  beforeAll(async () => {
    await gh.start();
    await ai.start();
    Object.assign(process.env, gh.env(), { AI_SERVICE_URL: ai.url });
    app = await bootApp();
    orchestrator = app.get(OrchestratorService);
    [owner, admin, member, viewer, outsider] = await Promise.all([login(app), login(app), login(app), login(app), login(app)]);
    ws = await createWorkspace(owner);
    otherWs = await createWorkspace(outsider);
    await addMember(owner, admin, ws, 'admin');
    await addMember(owner, member, ws, 'member');
    await addMember(owner, viewer, ws, 'viewer');
    repo = await connect(owner, ws, 'auth', SHA, [
      { name: 'src/token.ts', content: TOKEN_TS },
      { name: 'src/session.ts', content: SESSION_TS },
      { name: 'tests/token.test.ts', content: TOKEN_TEST },
      { name: 'tests/session.test.ts', content: SESSION_TEST },
    ]);
    repo2 = await connect(owner, ws, 'billing', SHA, [{ name: 'billing/refresh_invoice.py', content: 'def refresh_invoice(invoice):\n    return invoice\n' }]);
    otherRepo = await connect(outsider, otherWs, 'secret', SHA_OTHER, [{ name: 'src/refresh.ts', content: 'export function refreshSecretToken() { return 1; }\n' }]);
  });

  beforeEach(() => {
    ai.generateHandler = handler;
    ai.generateCalls = [];
  });

  afterAll(async () => {
    await app.close();
    await gh.stop();
    await ai.stop();
  });

  describe('route security', () => {
    it('every new route requires a session, and mutations require the CSRF token', async () => {
      const anon = request(app.getHttpServer());
      const sym = '00000000-0000-4000-8000-000000000000';
      for (const [m, path] of [
        ['get', `/workspaces/${ws}/templates`],
        ['post', `/workspaces/${ws}/templates`],
        ['patch', `/workspaces/${ws}/templates/${sym}`],
        ['delete', `/workspaces/${ws}/templates/${sym}`],
        ['get', `/repositories/${repo}/symbols/${sym}/call-graph`],
        ['post', `/repositories/${repo}/impact`],
        ['get', `/runs/${sym}/impact`],
        ['post', `/workspaces/${ws}/search`],
        ['post', `/workspaces/${ws}/questions`],
      ] as const) {
        const res = await anon[m](`/api/v1${path}`).send({});
        expect(res.status, `${m} ${path}`).toBe(401);
        if (m !== 'get') {
          const noCsrf = await owner.agent[m](`/api/v1${path}`).send({});
          expect(noCsrf.status, `${m} ${path} without CSRF`).toBe(403);
          expect(noCsrf.body.error.code).toBe('CSRF_TOKEN_INVALID');
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('workflow templates', () => {
    const custom = {
      key: 'security_fix',
      name: 'Security fix',
      description: 'Fix a reported vulnerability',
      workflow: 'change',
      task_defaults: { title_prefix: 'Security: ', description_template: '## Advisory\n', labels: ['security'] },
      budget: { max_changed_files: 2, max_repair_attempts: 0 },
      allowed_profiles: ['node-test'],
      planning_guidance: ['Do not change public interfaces.'],
    };
    let customId: string;

    it('lists the five built-in templates to any member, conceals them from outsiders', async () => {
      const res = await as(viewer, 'get', `/workspaces/${ws}/templates`).expect(200);
      const keys = (res.body.data as Array<{ key: string; source: string }>).filter((t) => t.source === 'builtin').map((t) => t.key);
      expect(keys).toEqual(['bug_fix', 'add_tests', 'refactor', 'dependency_upgrade', 'migration_plan']);
      const mp = (res.body.data as Array<{ key: string; plan_only: boolean; allowed_profiles: string[] | null }>).find((t) => t.key === 'migration_plan')!;
      expect(mp).toMatchObject({ plan_only: true, allowed_profiles: [] });
      await as(outsider, 'get', `/workspaces/${ws}/templates`).expect(404);
    });

    it('only admins create templates; members and viewers are denied', async () => {
      await as(member, 'post', `/workspaces/${ws}/templates`).send(custom).expect(403);
      await as(viewer, 'post', `/workspaces/${ws}/templates`).send(custom).expect(403);
      await as(outsider, 'post', `/workspaces/${ws}/templates`).send(custom).expect(404);
      const res = await as(admin, 'post', `/workspaces/${ws}/templates`).send(custom).expect(201);
      customId = res.body.data.id;
      expect(res.body.data).toMatchObject({ key: 'security_fix', source: 'workspace', version: 1, status: 'active', plan_only: false });
    });

    it('rejects reserved and duplicate keys and invalid profiles', async () => {
      await as(admin, 'post', `/workspaces/${ws}/templates`).send({ ...custom, key: 'bug_fix' }).expect(422);
      await as(admin, 'post', `/workspaces/${ws}/templates`).send(custom).expect(409);
      await as(admin, 'post', `/workspaces/${ws}/templates`).send({ ...custom, key: 'other_one', allowed_profiles: ['rm -rf /'] }).expect(422);
    });

    it('updates bump the version and are audited; other tenants cannot touch them', async () => {
      await as(member, 'patch', `/workspaces/${ws}/templates/${customId}`).send({ name: 'x' }).expect(403);
      await as(outsider, 'patch', `/workspaces/${otherWs}/templates/${customId}`).send({ name: 'x' }).expect(404);
      const res = await as(admin, 'patch', `/workspaces/${ws}/templates/${customId}`).send({ planning_guidance: ['Do not change public interfaces.', 'Add a regression test.'] }).expect(200);
      expect(res.body.data.version).toBe(2);
      const audit = await db(app).selectFrom('audit_events').select(['action', 'actor_user_id']).where('organization_id', '=', ws).where('resource_type', '=', 'workflow_template').orderBy('created_at').execute();
      expect(audit.map((a) => a.action)).toEqual(['template.created', 'template.updated']);
      expect(audit.every((a) => a.actor_user_id === admin.id)).toBe(true);
    });

    it('tasks store an immutable snapshot of the template', async () => {
      const t = await as(member, 'post', `/repositories/${repo}/tasks`).send({ source_type: 'manual', title: 'Security: fix token', description: 'd', template_key: 'security_fix' }).expect(201);
      expect(t.body.data).toMatchObject({ template_key: 'security_fix', template: { version: 2, source: 'workspace', planning_guidance: ['Do not change public interfaces.', 'Add a regression test.'] } });
      await as(admin, 'patch', `/workspaces/${ws}/templates/${customId}`).send({ planning_guidance: ['Changed later'] }).expect(200);
      const again = await as(member, 'get', `/tasks/${t.body.data.id}`).expect(200);
      expect(again.body.data.template.planning_guidance).toEqual(['Do not change public interfaces.', 'Add a regression test.']);
    });

    it('unknown, archived or other-workspace templates cannot be used', async () => {
      await as(member, 'post', `/repositories/${repo}/tasks`).send({ source_type: 'manual', title: 't', description: 'd', template_key: 'nope_nope' }).expect(422);
      const other = await as(outsider, 'post', `/workspaces/${otherWs}/templates`).send({ ...custom, key: 'outsider_tpl' }).expect(201);
      expect(other.body.data.id).toBeTruthy();
      await as(member, 'post', `/repositories/${repo}/tasks`).send({ source_type: 'manual', title: 't', description: 'd', template_key: 'outsider_tpl' }).expect(422);
      await as(admin, 'delete', `/workspaces/${ws}/templates/${customId}`).expect(204);
      const res = await as(member, 'post', `/repositories/${repo}/tasks`).send({ source_type: 'manual', title: 't', description: 'd', template_key: 'security_fix' }).expect(422);
      expect(res.body.error.code).toBe('TEMPLATE_ARCHIVED');
      const listed = await as(viewer, 'get', `/workspaces/${ws}/templates`).expect(200);
      expect((listed.body.data as Array<{ key: string }>).some((t) => t.key === 'security_fix')).toBe(false);
      const all = await as(viewer, 'get', `/workspaces/${ws}/templates?include_archived=true`).expect(200);
      expect((all.body.data as Array<{ key: string; status: string }>).find((t) => t.key === 'security_fix')!.status).toBe('archived');
      const audit = await db(app).selectFrom('audit_events').select('action').where('resource_id', '=', customId).where('action', '=', 'template.archived').execute();
      expect(audit).toHaveLength(1);
    });

    it('a run lowers its budget to the template ceilings and sends the guidance as trusted context', async () => {
      const t = await as(member, 'post', `/repositories/${repo}/tasks`).send({ source_type: 'manual', title: 'Fix: refresh', description: 'Refresh fails', template_key: 'bug_fix' }).expect(201);
      const run = await as(member, 'post', `/tasks/${t.body.data.id}/runs`).send({ budgets: { max_changed_files: 50 } }).expect(202);
      expect(run.body.data.budget).toMatchObject({ max_changed_files: 5, max_repair_attempts: 1 });
      await orchestrator.advance(run.body.data.id);
      const planCall = ai.generateCalls.find((c) => c.task === 'planning') as Body;
      expect(planCall.context!.template).toMatchObject({ key: 'bug_fix', source: 'application', guidance: expect.arrayContaining([expect.stringContaining('regression test')]) });
      // The task description stays untrusted input; template guidance never comes from repository content.
      expect(JSON.stringify(planCall.untrusted_inputs)).toContain('Refresh fails');
      const detail = await as(viewer, 'get', `/runs/${run.body.data.id}`).expect(200);
      expect(detail.body.data).toMatchObject({ template: { key: 'bug_fix', workflow: 'change' }, plan_only: false });
    });
  });

  // -------------------------------------------------------------------------
  describe('migration planning (plan-only)', () => {
    let runId: string;

    it('produces an evidence-backed plan with affected areas, rollback and prerequisites', async () => {
      const t = await as(member, 'post', `/repositories/${repo}/tasks`).send({ source_type: 'manual', title: 'Migration plan: token issuer', description: 'Move issuing', template_key: 'migration_plan' }).expect(201);
      runId = (await as(member, 'post', `/tasks/${t.body.data.id}/runs`).send({}).expect(202)).body.data.id;
      await orchestrator.advance(runId);
      expect(ai.generateCalls.map((c) => c.task)).toEqual(['investigation', 'migration_plan']);
      const plan = await as(viewer, 'get', `/runs/${runId}/plan`).expect(200);
      const p = plan.body.data;
      expect(p.plan_only).toBe(true);
      expect(p.plan.steps.map((s: { id: string }) => s.id)).toEqual(['step-1', 'step-2']);
      expect(p.plan.steps[1].files).toEqual(['src/session.ts']);
      expect(p.plan.migration.step_rollback).toEqual([
        { step_id: 'step-1', rollback: 'Delete TokenIssuer; nothing calls it yet' },
        { step_id: 'step-2', rollback: 'Revert the session change' },
      ]);
      expect(p.plan.migration.affected_areas[0].evidence_ids).toHaveLength(1);
      expect(p.plan.migration.affected_areas[0].evidence_ids).not.toContain('fabricated');
      expect(p.migration_evidence).toHaveLength(1);
      expect(p.migration_evidence[0]).toMatchObject({ commit_sha: SHA });
      expect(p.plan.migration.prerequisites).toEqual(['Agree on the TokenIssuer interface']);
    });

    it('approval completes the run without any workspace or execution', async () => {
      const plan = await as(member, 'get', `/runs/${runId}/plan`).expect(200);
      const res = await as(member, 'post', `/runs/${runId}/plan-approval`).send({ decision: 'approved', plan_hash: plan.body.data.plan_hash }).expect(200);
      expect(res.body.data.status).toBe('completed_without_pr');
      await orchestrator.advance(runId);
      const steps = await db(app).selectFrom('agent_steps').select('agent_type').where('run_id', '=', runId).execute();
      expect(steps.map((s) => s.agent_type)).not.toContain('workspace');
      const patches = await db(app).selectFrom('patches').select('id').where('run_id', '=', runId).execute();
      expect(patches).toEqual([]);
    });

    it('viewers cannot approve a migration plan', async () => {
      const t = await as(member, 'post', `/repositories/${repo}/tasks`).send({ source_type: 'manual', title: 'Migration plan: 2', description: 'd', template_key: 'migration_plan' }).expect(201);
      const r = (await as(member, 'post', `/tasks/${t.body.data.id}/runs`).send({}).expect(202)).body.data.id;
      await orchestrator.advance(r);
      const plan = await as(viewer, 'get', `/runs/${r}/plan`).expect(200);
      await as(viewer, 'post', `/runs/${r}/plan-approval`).send({ decision: 'approved', plan_hash: plan.body.data.plan_hash }).expect(403);
      await as(outsider, 'post', `/runs/${r}/plan-approval`).send({ decision: 'approved', plan_hash: plan.body.data.plan_hash }).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('call graph', () => {
    async function symbolId(name: string) {
      const res = await as(viewer, 'get', `/repositories/${repo}/symbols?q=${name}`).expect(200);
      return (res.body.data as Array<{ id: string; name: string }>).find((s) => s.name === name)!.id;
    }

    it('returns callers and callees linked to call-site lines, bounded by depth', async () => {
      const issue = await symbolId('issueToken');
      const one = await as(viewer, 'get', `/repositories/${repo}/symbols/${issue}/call-graph?direction=callers&depth=1`).expect(200);
      expect(one.body.data.nodes.map((n: { symbol: { name: string } }) => n.symbol.name)).toEqual(['refreshToken']);
      expect(one.body.data.edges[0]).toMatchObject({ path: 'src/token.ts', line: 2 });
      const two = await as(viewer, 'get', `/repositories/${repo}/symbols/${issue}/call-graph?direction=callers&depth=2`).expect(200);
      expect(two.body.data.nodes.map((n: { symbol: { name: string }; depth: number }) => [n.symbol.name, n.depth])).toEqual(
        expect.arrayContaining([
          ['refreshToken', 1],
          ['renewSession', 2],
        ]),
      );
      const callees = await as(viewer, 'get', `/repositories/${repo}/symbols/${await symbolId('renewSession')}/call-graph?direction=callees&depth=2`).expect(200);
      expect(callees.body.data.nodes.map((n: { symbol: { name: string } }) => n.symbol.name)).toEqual(['refreshToken', 'issueToken']);
    });

    it('pages nodes with a cursor', async () => {
      const issue = await symbolId('issueToken');
      const p1 = await as(viewer, 'get', `/repositories/${repo}/symbols/${issue}/call-graph?direction=callers&depth=3&limit=1`).expect(200);
      expect(p1.body.data.nodes).toHaveLength(1);
      expect(p1.body.data.total_nodes).toBeGreaterThan(1);
      const p2 = await as(viewer, 'get', `/repositories/${repo}/symbols/${issue}/call-graph?direction=callers&depth=3&limit=1&cursor=${p1.body.data.next_cursor}`).expect(200);
      expect(p2.body.data.nodes[0].symbol.id).not.toBe(p1.body.data.nodes[0].symbol.id);
      await as(viewer, 'get', `/repositories/${repo}/symbols/${issue}/call-graph?depth=9`).expect(422);
      await as(viewer, 'get', `/repositories/${repo}/symbols/${issue}/call-graph?cursor=bad!`).expect(422);
    });

    it('conceals the graph from other tenants and rejects symbols of another repository', async () => {
      const issue = await symbolId('issueToken');
      await as(outsider, 'get', `/repositories/${repo}/symbols/${issue}/call-graph`).expect(404);
      await as(owner, 'get', `/repositories/${repo2}/symbols/${issue}/call-graph`).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('change impact and test selection', () => {
    it('predicts impacted files and selects tests with evidence, labelled heuristic', async () => {
      const res = await as(viewer, 'post', `/repositories/${repo}/impact`).send({ changed_files: ['src/token.ts'] }).expect(200);
      const d = res.body.data;
      expect(d.heuristic).toBe(true);
      expect(d.disclaimer).toMatch(/not a verification result/);
      expect(d.impacted_files.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(['src/session.ts', 'tests/token.test.ts', 'tests/session.test.ts']));
      expect(d.selected_tests.map((t: { path: string }) => t.path)).toEqual(['tests/token.test.ts', 'tests/session.test.ts']);
      expect(d.selected_tests[0].reasons[0].evidence[0]).toMatchObject({ kind: 'imports', from: 'tests/token.test.ts', to: 'src/token.ts', line: 1 });
    });

    it('validates paths and conceals other tenants', async () => {
      await as(viewer, 'post', `/repositories/${repo}/impact`).send({ changed_files: ['../etc/passwd'] }).expect(422);
      await as(viewer, 'post', `/repositories/${repo}/impact`).send({ changed_files: [] }).expect(422);
      await as(outsider, 'post', `/repositories/${repo}/impact`).send({ changed_files: ['src/token.ts'] }).expect(404);
    });

    it("predicts a run's impact from its plan before a patch exists", async () => {
      const t = await as(member, 'post', `/repositories/${repo}/tasks`).send({ source_type: 'manual', title: 'Fix refresh', description: 'd' }).expect(201);
      const run = (await as(member, 'post', `/tasks/${t.body.data.id}/runs`).send({}).expect(202)).body.data.id;
      await orchestrator.advance(run);
      const res = await as(viewer, 'get', `/runs/${run}/impact`).expect(200);
      expect(res.body.data).toMatchObject({ source: 'plan', plan_version: 1, heuristic: true, commit_sha: SHA });
      expect(res.body.data.selected_tests[0].path).toBe('tests/token.test.ts');
      await as(outsider, 'get', `/runs/${run}/impact`).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('cross-repository search and Q&A', () => {
    it('searches every repository of the workspace with provenance, never another tenant', async () => {
      const res = await as(viewer, 'post', `/workspaces/${ws}/search`).send({ query: 'refresh token' }).expect(200);
      const d = res.body.data;
      const repos = new Set((d.results as Array<{ repository_id: string }>).map((r) => r.repository_id));
      expect(repos.has(repo)).toBe(true);
      expect(repos.has(repo2)).toBe(true);
      expect(repos.has(otherRepo)).toBe(false);
      expect(d.results[0]).toMatchObject({ repository_full_name: expect.stringMatching(/^acme\//), commit_sha: SHA, source: 'code' });
      expect(d.repositories.map((r: { id: string }) => r.id).sort()).toEqual([repo, repo2].sort());
    });

    it('restricts to requested repositories and refuses ids from another workspace', async () => {
      const only = await as(viewer, 'post', `/workspaces/${ws}/search`).send({ query: 'refresh', repository_ids: [repo2] }).expect(200);
      expect((only.body.data.results as Array<{ repository_id: string }>).every((r) => r.repository_id === repo2)).toBe(true);
      await as(viewer, 'post', `/workspaces/${ws}/search`).send({ query: 'refresh', repository_ids: [otherRepo] }).expect(404);
      await as(outsider, 'post', `/workspaces/${ws}/search`).send({ query: 'refresh' }).expect(404);
    });

    it('answers across repositories with citations rebuilt from retrieval records', async () => {
      const res = await as(viewer, 'post', `/workspaces/${ws}/questions`).send({ question: 'Where are tokens refreshed?', mode: 'local' }).expect(200);
      const d = res.body.data;
      expect(d.citations).toHaveLength(1);
      expect(d.citations[0]).toMatchObject({ repository_id: expect.any(String), repository_full_name: expect.stringMatching(/^acme\//) });
      expect(d.limitations).toContain('Some model citations did not match retrieved evidence and were removed.');
      const sent = ai.generateCalls[0] as Body;
      expect(sent.evidence.every((e) => /^acme\/(auth|billing)\//.test(e.path))).toBe(true);
      await as(outsider, 'post', `/workspaces/${ws}/questions`).send({ question: 'Where are tokens refreshed?' }).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('hosted provider choice and disclosure', () => {
    it('accepts only known hosted providers and requires a new acknowledgment to switch provider', async () => {
      const enable = { allowed_modes: ['local', 'mock', 'cloud'], cloud: { enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', data_categories: ['source_code'] }, acknowledge_data_disclosure: true };
      await as(owner, 'patch', `/workspaces/${ws}/ai-policy`).send({ ...enable, cloud: { ...enable.cloud, provider: 'some-other-cloud' } }).expect(422);
      await as(member, 'patch', `/workspaces/${ws}/ai-policy`).send(enable).expect(403);
      await as(owner, 'patch', `/workspaces/${ws}/ai-policy`).send(enable).expect(200);
      const noAck = await as(owner, 'patch', `/workspaces/${ws}/ai-policy`).send({ cloud: { provider: 'openai_compatible', model: 'gpt-test' } }).expect(422);
      expect(noAck.body.error.code).toBe('DATA_DISCLOSURE_REQUIRED');
      const more = await as(owner, 'patch', `/workspaces/${ws}/ai-policy`).send({ cloud: { data_categories: ['source_code', 'diffs'] } }).expect(422);
      expect(more.body.error.code).toBe('DATA_DISCLOSURE_REQUIRED');
      const ok = await as(owner, 'patch', `/workspaces/${ws}/ai-policy`).send({ cloud: { provider: 'openai_compatible', model: 'gpt-test' }, acknowledge_data_disclosure: true }).expect(200);
      expect(ok.body.data.cloud).toMatchObject({ provider: 'openai_compatible', model: 'gpt-test' });
      const audit = await db(app).selectFrom('audit_events').select('action').where('organization_id', '=', ws).where('action', '=', 'ai_policy.cloud_provider_changed').execute();
      expect(audit).toHaveLength(1);
    });

    it('routes cloud requests to the selected provider with its disclosure, never another one', async () => {
      const res = await as(viewer, 'post', `/workspaces/${ws}/questions`).send({ question: 'Where are tokens refreshed?', mode: 'cloud' }).expect(200);
      expect(res.body.data.data_disclosure).toEqual({ provider: 'openai_compatible', data_categories: ['source_code'] });
      expect(ai.generateCalls[0]).toMatchObject({ mode: 'cloud', provider: 'openai_compatible', model: 'gpt-test' });
      const audit = await db(app).selectFrom('audit_events').select('metadata_redacted').where('organization_id', '=', ws).where('action', '=', 'ai.cloud_inference').executeTakeFirstOrThrow();
      expect(audit.metadata_redacted).toMatchObject({ operation: 'workspace_qa' });
    });
  });
});
