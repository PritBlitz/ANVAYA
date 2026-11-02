import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { VerificationProfile } from '../src/execution/profiles.js';
import { SandboxDriver, type SandboxResult } from '../src/execution/sandbox.js';
import { WorkspaceManager } from '../src/execution/workspace.js';
import { OrchestratorService } from '../src/runs/orchestrator.service.js';
import { FakeAi, type GenerateHandler } from './fake-ai.js';
import { FakeGithub } from './fake-github.js';
import { addMember, as, bootApp, createWorkspace, db, login, type TestUser } from './helpers.js';
import { externalId, linkInstallation, runIndexing } from './scenario.js';
import { buildTarball } from './tarball.js';

const SHA = 'e'.repeat(40);
const TOKEN_TS = 'export function refresh(t: string) {\n  return t;\n}\n';
const TEST_PY = 'import unittest\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n';

type Body = Record<string, unknown> & { task: string; evidence: Array<{ id: string }>; mode: string; context?: Record<string, unknown> };

function respond(b: Body, output: unknown) {
  return {
    body: {
      task: b.task,
      provider: 'ollama',
      model: 'test-model',
      mode: b.mode,
      prompt_version: `${b.task}.v1`,
      output,
      evidence_included: b.evidence.map((e) => e.id),
      usage: { input_tokens: 100, output_tokens: 50, estimated_cost_microunits: 0 },
      duration_ms: 5,
      schema_repair_attempted: false,
    },
  };
}

const plan = {
  objective: 'Fix refresh',
  assumptions: [],
  steps: [{ id: 'step-1', description: 'Update refresh', files: ['src/token.ts'], verification: ['tests'] }],
  files_to_modify: ['src/token.ts'],
  tests: ['unit'],
  risks: [],
  out_of_scope: [],
};

/** Builds an AI handler whose patch/repair output is computed from the workspace file content. */
function handler(opts: { patch: (content: string, attempt: number) => Array<Record<string, unknown>>; review?: Array<Record<string, unknown>> }): GenerateHandler {
  let attempt = 0;
  return (raw) => {
    const b = raw as Body;
    switch (b.task) {
      case 'investigation':
        return respond(b, { summary: 's', findings: [], hypotheses: [], unknowns: [], candidate_files: ['src/token.ts'] });
      case 'planning':
        return respond(b, plan);
      case 'patch':
      case 'repair': {
        attempt++;
        const files = (b.context?.files ?? []) as Array<{ path: string; content: string }>;
        const current = files.find((f) => f.path === 'src/token.ts')?.content ?? '';
        return respond(b, { summary: `attempt ${attempt}`, changes: opts.patch(current, attempt), plan_revision_needed: false });
      }
      case 'review':
        return respond(b, {
          summary: 'Looks reasonable.',
          findings: opts.review ?? [
            { severity: 'low', file_path: 'src/token.ts', start_line: 1, end_line: 2, title: 'Consider a test', rationale: 'No regression test.', evidence: ['diff'], confidence: 'medium', suggested_action: 'Add a test' },
            { severity: 'high', file_path: 'src/unrelated.ts', start_line: 1, end_line: 1, title: 'Hallucinated', rationale: 'Not in diff', evidence: [], confidence: 'high' },
          ],
        });
      default:
        return respond(b, { summary: 'ok', likely_causes: [], suggested_next_steps: [] });
    }
  };
}

const modify = (content: string) => [{ path: 'src/token.ts', action: 'modify', content, explanation: 'fix' }];

describe('execution, verification, review and pull-request handoff', () => {
  const gh = new FakeGithub();
  const ai = new FakeAi();
  let app: INestApplication;
  let owner: TestUser;
  let member: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let repo: string;
  let repoExt: number;
  let orchestrator: OrchestratorService;
  let workspaces: WorkspaceManager;
  const sandboxCalls: Array<{ profile: string; content: string }> = [];
  let sandboxImpl: (profile: VerificationProfile, dir: string, opts: { timeoutSeconds: number; signal?: AbortSignal }) => Promise<SandboxResult>;

  const result = (exitCode: number | null, extra: Partial<SandboxResult> = {}): SandboxResult => ({ exitCode, timedOut: false, durationMs: 12, stdout: '', stderr: '', truncated: false, error: null, ...extra });
  /** Deterministic stand-in: fails when the workspace file contains BROKEN. */
  const defaultSandbox = async (profile: VerificationProfile, dir: string) => {
    const content = readFileSync(join(dir, 'src', 'token.ts'), 'utf8');
    sandboxCalls.push({ profile: profile.id, content });
    return content.includes('BROKEN') ? result(1, { stderr: `AssertionError: refresh broken ghp_${'z'.repeat(36)}` }) : result(0, { stdout: 'OK' });
  };

  async function toPrApproval(budgets: Record<string, number> = {}): Promise<string> {
    const task = (await as(member, 'post', `/repositories/${repo}/tasks`).send({ source_type: 'manual', title: 'Fix refresh', description: 'Refresh must work.' }).expect(201)).body.data.id;
    const run = (await as(member, 'post', `/tasks/${task}/runs`).send({ budgets }).expect(202)).body.data.id as string;
    await orchestrator.advance(run);
    const hash = (await as(member, 'get', `/runs/${run}/plan`).expect(200)).body.data.plan_hash;
    await as(member, 'post', `/runs/${run}/plan-approval`).send({ decision: 'approved', plan_hash: hash }).expect(200);
    await orchestrator.advance(run);
    return run;
  }

  const status = async (run: string): Promise<Record<string, unknown>> => (await as(member, 'get', `/runs/${run}`).expect(200)).body.data as Record<string, unknown>;

  beforeAll(async () => {
    await gh.start();
    await ai.start();
    Object.assign(process.env, gh.env(), { AI_SERVICE_URL: ai.url, EXECUTION_DRIVER: 'docker', WORKSPACES_DIR: mkdtempSync(join(tmpdir(), 'anvaya-ws-test-')) });
    app = await bootApp();
    orchestrator = app.get(OrchestratorService);
    workspaces = app.get(WorkspaceManager);
    const driver = app.get(SandboxDriver);
    driver.run = (p: VerificationProfile, d: string, o: { timeoutSeconds: number; signal?: AbortSignal }): Promise<SandboxResult> => sandboxImpl(p, d, o);
    [owner, member, viewer, outsider] = await Promise.all([login(app), login(app), login(app), login(app)]);
    const ws = await createWorkspace(owner);
    await addMember(owner, member, ws, 'member');
    await addMember(owner, viewer, ws, 'viewer');
    const link = await linkInstallation(gh, owner, ws);
    repoExt = externalId();
    gh.addRepo(
      {
        id: repoExt,
        owner: 'acme',
        name: 'exec',
        default_branch: 'main',
        private: true,
        branches: { main: SHA },
        tarballs: { [SHA]: await buildTarball('acme-exec-e', [{ name: 'src/token.ts', content: TOKEN_TS }, { name: 'tests/test_token.py', content: TEST_PY }, { name: 'src/other.ts', content: 'export const o = 1;\n' }]) },
      },
      link.installationId,
    );
    repo = (await as(owner, 'post', '/repositories').send({ workspace_id: ws, installation_id: link.installationUuid, external_repository_id: repoExt }).expect(201)).body.data.id;
    await runIndexing(app, repo);
  });

  beforeEach(() => {
    sandboxImpl = defaultSandbox;
    sandboxCalls.length = 0;
    ai.generateCalls = [];
  });

  afterAll(async () => {
    await app.close();
    await gh.stop();
    await ai.stop();
    delete process.env.EXECUTION_DRIVER;
  });

  describe('happy path', () => {
    let run: string;
    let calls: Array<{ profile: string; content: string }> = [];

    beforeAll(async () => {
      ai.generateHandler = handler({ patch: (c) => modify(c.replace('return t;', 'return t.trim();')) });
      sandboxImpl = defaultSandbox;
      sandboxCalls.length = 0;
      run = await toPrApproval();
      calls = [...sandboxCalls];
    });

    it('applies a validated patch, verifies it in the sandbox and waits for PR approval', async () => {
      const r = await status(run);
      expect(r.status).toBe('awaiting_pr_approval');
      expect(calls.map((c) => c.profile)).toEqual(['python-compile', 'python-unittest']);
      expect(calls[0]!.content).toContain('t.trim()');
      const steps = (await as(viewer, 'get', `/runs/${run}/steps`)).body.data.map((s: { agent_type: string }) => s.agent_type);
      expect(steps).toEqual(['context_retriever', 'investigator', 'planner', 'workspace', 'patch_developer', 'verification_engine', 'code_reviewer']);
    });

    it('exposes the diff with a patch hash', async () => {
      const d = (await as(viewer, 'get', `/runs/${run}/diff`).expect(200)).body.data;
      expect(d.patch_hash).toMatch(/^sha256:/);
      expect(d.changed_files).toEqual([{ path: 'src/token.ts', action: 'modify', explanation: 'fix' }]);
      expect(d.diff).toContain('-  return t;');
      expect(d.diff).toContain('+  return t.trim();');
      expect(d).toMatchObject({ additions: 1, deletions: 1, base_commit_sha: SHA, attempt: 1 });
      await as(outsider, 'get', `/runs/${run}/diff`).expect(404);
    });

    it('reports deterministic verification results separately', async () => {
      const v = (await as(viewer, 'get', `/runs/${run}/verification`).expect(200)).body.data;
      expect(v.deterministic).toBe(true);
      expect(v.summary).toEqual({ passed: 2, failed: 0, timed_out: 0, skipped: 0, unavailable: 0 });
      expect(v.results[0]).toMatchObject({ profile_id: 'python-compile', command_display: 'python -m compileall -q .', status: 'passed', exit_code: 0 });
    });

    it('separates AI findings from deterministic findings and drops findings outside the diff', async () => {
      const rv = (await as(viewer, 'get', `/runs/${run}/review`).expect(200)).body.data;
      expect(rv.deterministic_findings).toEqual([]);
      expect(rv.ai_findings).toHaveLength(1);
      expect(rv.ai_findings[0]).toMatchObject({ source: 'ai_review', file_path: 'src/token.ts', severity: 'low', status: 'open' });
      const f = rv.ai_findings[0].id;
      await as(viewer, 'post', `/runs/${run}/findings/${f}/disposition`).send({ status: 'dismissed' }).expect(403);
      const d = await as(member, 'post', `/runs/${run}/findings/${f}/disposition`).send({ status: 'accepted', comment: 'Will add test' }).expect(200);
      expect(d.body.data).toMatchObject({ status: 'accepted', disposition_by: member.id });
    });

    it('cleans up the workspace after review', async () => {
      expect(await workspaces.exists(run)).toBe(false);
    });

    it('emits execution events', async () => {
      const types = (await db(app).selectFrom('run_events').select('event_type').where('run_id', '=', run).execute()).map((e) => e.event_type);
      expect(types).toEqual(expect.arrayContaining(['patch.proposed', 'sandbox.started', 'verification.completed', 'review.finding.created']));
      const approvals = await db(app).selectFrom('run_events').select('payload').where('run_id', '=', run).where('event_type', '=', 'approval.required').execute();
      expect(approvals.map((a) => a.payload.approval_type)).toEqual(['plan', 'pull_request']);
    });

    it('never creates a PR without a human approval of the exact patch', async () => {
      const key = () => ({ idempotencyKey: `pr-${randomUUID()}` });
      await as(member, 'post', `/runs/${run}/pull-request`).send({ title: 'Fix' }).expect(422); // no Idempotency-Key
      const noApproval = await as(member, 'post', `/runs/${run}/pull-request`, key()).send({ title: 'Fix' }).expect(403);
      expect(noApproval.body.error.code).toBe('FORBIDDEN');
      await as(viewer, 'post', `/runs/${run}/pr-approval`).send({ decision: 'approved', patch_hash: `sha256:${'0'.repeat(64)}` }).expect(403);
      const stale = await as(member, 'post', `/runs/${run}/pr-approval`).send({ decision: 'approved', patch_hash: `sha256:${'0'.repeat(64)}` }).expect(409);
      expect(stale.body.error.code).toBe('PATCH_CHANGED');
      expect(gh.pulls).toHaveLength(0);
    });

    it('creates the PR with scoped write credentials, idempotently, and completes the run', async () => {
      const hash = (await as(member, 'get', `/runs/${run}/diff`)).body.data.patch_hash;
      await as(member, 'post', `/runs/${run}/pr-approval`).send({ decision: 'approved', patch_hash: hash, comment: 'LGTM' }).expect(200);
      gh.grants.length = 0;
      const key = `pr-${randomUUID()}`;
      const res = await as(member, 'post', `/runs/${run}/pull-request`, { idempotencyKey: key }).send({ title: 'Fix token refresh', body: 'Summary.' }).expect(201);
      expect(res.body.data).toMatchObject({ provider: 'github', pr_number: 1, base_branch: 'main' });
      expect(gh.pulls).toHaveLength(1);
      expect(gh.pulls[0]!.files['src/token.ts']).toContain('t.trim()');
      expect(gh.pulls[0]!.body).toContain('python-compile');
      expect(gh.pulls[0]!.body).toContain('human review required');
      expect(gh.grants.map((g) => g.permissions)).toContainEqual({ contents: 'write', metadata: 'read', pull_requests: 'write' });
      expect(gh.grants.every((g) => g.repositoryIds?.length === 1 && g.repositoryIds[0] === repoExt)).toBe(true);
      expect((await status(run)).status).toBe('completed');

      const replay = await as(member, 'post', `/runs/${run}/pull-request`, { idempotencyKey: key }).send({ title: 'Fix token refresh', body: 'Summary.' }).expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const again = await as(member, 'post', `/runs/${run}/pull-request`, { idempotencyKey: `pr-${randomUUID()}` }).send({ title: 'Fix token refresh' }).expect(409);
      expect(again.body.error.code).toBe('PULL_REQUEST_EXISTS');
      expect(gh.pulls).toHaveLength(1);
      const audit = await db(app).selectFrom('audit_events').select('action').where('resource_id', '=', run).execute();
      expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['plan.approved', 'pull_request.approved', 'pull_request.created']));
    });
  });

  describe('repair and failure paths', () => {
    it('runs a bounded repair after a real verification failure', async () => {
      ai.generateHandler = handler({ patch: (c, attempt) => modify(attempt === 1 ? c.replace('return t;', 'return BROKEN;') : c.replace('return BROKEN;', 'return t.trim();')) });
      const run = await toPrApproval({ max_repair_attempts: 1 });
      expect((await status(run)).status).toBe('awaiting_pr_approval');
      const repair = ai.generateCalls.find((c) => c.task === 'repair')!;
      const failure = (repair.untrusted_inputs as Array<{ label: string; content: string }>).find((u) => u.label === 'verification_failure')!;
      expect(failure.content).toContain('AssertionError: refresh broken');
      expect(failure.content).not.toContain('ghp_zzzz'); // sandbox output is redacted before reuse
      const v = (await as(member, 'get', `/runs/${run}/verification`)).body.data;
      expect(v.results.filter((r: { attempt: number; status: string }) => r.attempt === 1).some((r: { status: string }) => r.status === 'failed')).toBe(true);
      expect(v.summary.passed).toBe(2);
      expect((await as(member, 'get', `/runs/${run}/diff`)).body.data.attempt).toBe(2);
    });

    it('fails with evidence when the repair budget is exhausted', async () => {
      ai.generateHandler = handler({ patch: (c) => modify(c.replace('return t;', 'return BROKEN;').replace('return t.trim();', 'return BROKEN;')) });
      const run = await toPrApproval({ max_repair_attempts: 0 });
      const r = await status(run);
      expect(r).toMatchObject({ status: 'failed', error_code: 'VERIFICATION_FAILED' });
      expect(r.error_summary).toMatch(/Repair budget exhausted/);
      expect(await workspaces.exists(run)).toBe(false);
    });

    it('rejects patches outside the approved plan', async () => {
      ai.generateHandler = handler({ patch: () => [{ path: 'src/other.ts', action: 'modify', content: 'export const o = 2;\n', explanation: 'scope creep' }] });
      const run = await toPrApproval({ max_repair_attempts: 0 });
      expect(await status(run)).toMatchObject({ status: 'failed', error_code: 'PATCH_REJECTED' });
      expect(sandboxCalls).toHaveLength(0);
      const patches = await db(app).selectFrom('patches').select('id').where('run_id', '=', run).execute();
      expect(patches).toHaveLength(0);
    });

    it('rejects path traversal and workflow edits from the model', async () => {
      ai.generateHandler = handler({ patch: () => [{ path: '../../../etc/cron.d/x', action: 'create', content: '* * * * * root id', explanation: 'evil' }] });
      const run = await toPrApproval({ max_repair_attempts: 0 });
      expect(await status(run)).toMatchObject({ status: 'failed', error_code: 'PATCH_REJECTED' });
    });

    it('blocks patches that introduce secrets (deterministic check) without storing the value', async () => {
      const key = `AKIA${'Q'.repeat(16)}`;
      ai.generateHandler = handler({ patch: (c) => modify(`${c}export const k = "${key}";\n`), review: [] });
      const run = await toPrApproval({ max_repair_attempts: 0 });
      expect(await status(run)).toMatchObject({ status: 'failed', error_code: 'SECURITY_CHECK_FAILED' });
      const rv = (await as(member, 'get', `/runs/${run}/review`)).body.data;
      expect(rv.deterministic_findings[0]).toMatchObject({ source: 'security_scanner', severity: 'critical', file_path: 'src/token.ts' });
      expect(JSON.stringify(rv)).not.toContain(key);
    });

    it('reports sandbox infrastructure failures distinctly from test failures', async () => {
      ai.generateHandler = handler({ patch: (c) => modify(c.replace('return t;', 'return t.trim();')) });
      sandboxImpl = async () => result(125, { error: 'container runtime error (exit 125)' });
      const run = await toPrApproval();
      expect(await status(run)).toMatchObject({ status: 'failed', error_code: 'SANDBOX_ERROR' });
      const v = (await as(member, 'get', `/runs/${run}/verification`)).body.data;
      expect(v.summary.unavailable).toBe(1);
    });

    it('cancellation terminates a running sandbox and cleans up', async () => {
      ai.generateHandler = handler({ patch: (c) => modify(c.replace('return t;', 'return t.trim();')) });
      let started!: () => void;
      const sandboxStarted = new Promise<void>((r) => (started = r));
      let aborted = false;
      sandboxImpl = (_p, _d, o) =>
        new Promise((resolve) => {
          started();
          o.signal?.addEventListener('abort', () => {
            aborted = true;
            resolve(result(137));
          });
        });
      const task = (await as(member, 'post', `/repositories/${repo}/tasks`).send({ source_type: 'manual', title: 'Fix', description: 'd' }).expect(201)).body.data.id;
      const run = (await as(member, 'post', `/tasks/${task}/runs`).send({}).expect(202)).body.data.id as string;
      await orchestrator.advance(run);
      const hash = (await as(member, 'get', `/runs/${run}/plan`)).body.data.plan_hash;
      await as(member, 'post', `/runs/${run}/plan-approval`).send({ decision: 'approved', plan_hash: hash }).expect(200);
      const advancing = orchestrator.advance(run);
      await sandboxStarted;
      await as(member, 'post', `/runs/${run}/cancel`).send({}).expect(200);
      await advancing;
      expect(aborted).toBe(true);
      expect((await status(run)).status).toBe('cancelled');
      expect(await workspaces.exists(run)).toBe(false);
    });

    it('rejecting the PR completes the run without a PR', async () => {
      ai.generateHandler = handler({ patch: (c) => modify(c.replace('return t;', 'return t.trim();')) });
      const run = await toPrApproval();
      const r = await as(member, 'post', `/runs/${run}/pr-approval`).send({ decision: 'rejected', comment: 'Not now' }).expect(200);
      expect(r.body.data.status).toBe('completed_without_pr');
    });

    it('returns to awaiting approval on a transient GitHub failure and succeeds on retry', async () => {
      ai.generateHandler = handler({ patch: (c) => modify(c.replace('return t;', 'return t.trim();')) });
      const run = await toPrApproval();
      const hash = (await as(member, 'get', `/runs/${run}/diff`)).body.data.patch_hash;
      await as(member, 'post', `/runs/${run}/pr-approval`).send({ decision: 'approved', patch_hash: hash }).expect(200);
      gh.failWrites = 503;
      try {
        const res = await as(member, 'post', `/runs/${run}/pull-request`, { idempotencyKey: `pr-${randomUUID()}` }).send({ title: 'Fix' }).expect(503);
        expect(res.body.error.code).toBe('GITHUB_UNAVAILABLE');
      } finally {
        gh.failWrites = null;
      }
      expect((await status(run)).status).toBe('awaiting_pr_approval');
      await as(member, 'post', `/runs/${run}/pull-request`, { idempotencyKey: `pr-${randomUUID()}` }).send({ title: 'Fix' }).expect(201);
      expect((await status(run)).status).toBe('completed');
    });
  });

  it('leaves no workspace directories behind once runs finish or reach human review', () => {
    const dir = process.env.WORKSPACES_DIR!;
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});
