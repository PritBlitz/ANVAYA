import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPayload } from '../src/github/webhooks.controller.js';
import { FakeGithub } from './fake-github.js';
import { addMember, as, bootApp, createWorkspace, db, login, type TestUser } from './helpers.js';

const SECRET = 'test-webhook-secret-0123456789';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

let nextId = 9_000_000 + Math.floor(Math.random() * 100_000);
const uid = () => nextId++;

describe('GitHub App integration', () => {
  const gh = new FakeGithub();
  let app: INestApplication;
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let ws: string;
  let otherWs: string;
  const instId = uid();
  const repoId = uid();
  const repo2Id = uid();
  const foreignRepoId = uid();

  async function completeInstall(user: TestUser, workspaceId: string, installationId: number, status: number) {
    const url = await as(user, 'get', `/integrations/github/install-url?workspace_id=${workspaceId}`).expect(200);
    const code = `code-${randomUUID()}`;
    gh.oauthCodes.set(code, [installationId]);
    return as(user, 'post', '/integrations/github/complete').send({ workspace_id: workspaceId, installation_id: installationId, state: url.body.data.state, code }).expect(status);
  }

  function webhook(event: string, payload: unknown, deliveryId = randomUUID(), secret = SECRET) {
    const body = Buffer.from(JSON.stringify(payload));
    return request(app.getHttpServer())
      .post('/api/v1/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', event)
      .set('X-GitHub-Delivery', deliveryId)
      .set('X-Hub-Signature-256', signPayload(secret, body))
      .send(body.toString('utf8'));
  }

  beforeAll(async () => {
    await gh.start();
    Object.assign(process.env, gh.env());
    gh.installations.set(instId, { id: instId, account: 'acme', repos: [] });
    gh.addRepo({ id: repoId, owner: 'acme', name: 'api', default_branch: 'main', private: true, branches: { main: SHA_A } }, instId);
    gh.addRepo({ id: repo2Id, owner: 'acme', name: 'web', default_branch: 'main', private: false, branches: { main: SHA_A } }, instId);
    gh.repos.set(foreignRepoId, { id: foreignRepoId, owner: 'evil', name: 'other', default_branch: 'main', private: true, branches: {} });
    app = await bootApp();
    owner = await login(app);
    member = await login(app);
    outsider = await login(app);
    ws = await createWorkspace(owner);
    otherWs = await createWorkspace(outsider);
    await addMember(owner, member, ws, 'member');
  });

  afterAll(async () => {
    await app.close();
    await gh.stop();
  });

  describe('installation handshake', () => {
    it('only admins can start an installation', async () => {
      await as(member, 'get', `/integrations/github/install-url?workspace_id=${ws}`).expect(403);
      await as(outsider, 'get', `/integrations/github/install-url?workspace_id=${ws}`).expect(404);
      const res = await as(owner, 'get', `/integrations/github/install-url?workspace_id=${ws}`).expect(200);
      expect(res.body.data.url).toContain('/apps/anvaya-test/installations/new?state=');
    });

    it('rejects an installation the user cannot see on GitHub', async () => {
      const url = await as(owner, 'get', `/integrations/github/install-url?workspace_id=${ws}`).expect(200);
      const code = `code-${randomUUID()}`;
      gh.oauthCodes.set(code, [123]); // user can see a different installation
      await as(owner, 'post', '/integrations/github/complete').send({ workspace_id: ws, installation_id: instId, state: url.body.data.state, code }).expect(403);
    });

    it('rejects a state issued for another workspace or user, and states are single-use', async () => {
      const url = await as(outsider, 'get', `/integrations/github/install-url?workspace_id=${otherWs}`).expect(200);
      const code = `code-${randomUUID()}`;
      gh.oauthCodes.set(code, [instId]);
      // owner tries to use outsider's state for their own workspace
      await as(owner, 'post', '/integrations/github/complete').send({ workspace_id: ws, installation_id: instId, state: url.body.data.state, code }).expect(403);
      // the state was consumed by the failed attempt and cannot be reused even by its owner
      await as(outsider, 'post', '/integrations/github/complete').send({ workspace_id: otherWs, installation_id: instId, state: url.body.data.state, code }).expect(403);
    });

    it('links a verified installation and records an audit event', async () => {
      const res = await completeInstall(owner, ws, instId, 200);
      expect(res.body.data).toMatchObject({ workspace_id: ws, external_installation_id: instId, account_login: 'acme', status: 'active' });
      const audit = await db(app).selectFrom('audit_events').selectAll().where('organization_id', '=', ws).where('action', '=', 'integration.github.connected').execute();
      expect(audit).toHaveLength(1);
    });

    it('refuses to link an installation already linked to another workspace', async () => {
      const res = await completeInstall(outsider, otherWs, instId, 409);
      expect(res.body.error.code).toBe('INSTALLATION_ALREADY_LINKED');
    });

    it('lists installations only within the workspace', async () => {
      const mine = await as(member, 'get', `/integrations/github/installations?workspace_id=${ws}`).expect(200);
      expect(mine.body.data).toHaveLength(1);
      await as(outsider, 'get', `/integrations/github/installations?workspace_id=${ws}`).expect(404);
      await as(owner, 'get', '/integrations/github/installations').expect(422);
    });

    it('lists repositories granted by the installation (admins)', async () => {
      const [inst] = (await as(owner, 'get', `/integrations/github/installations?workspace_id=${ws}`)).body.data;
      await as(member, 'get', `/integrations/github/installations/${inst.id}/repositories`).expect(403);
      await as(outsider, 'get', `/integrations/github/installations/${inst.id}/repositories`).expect(404);
      const res = await as(owner, 'get', `/integrations/github/installations/${inst.id}/repositories`).expect(200);
      expect(res.body.data.repositories.map((r: { full_name: string }) => r.full_name).sort()).toEqual(['acme/api', 'acme/web']);
    });
  });

  describe('repositories', () => {
    let installationUuid: string;
    let repositoryUuid: string;

    beforeAll(async () => {
      installationUuid = (await as(owner, 'get', `/integrations/github/installations?workspace_id=${ws}`)).body.data[0].id;
    });

    it('members cannot connect repositories', async () => {
      await as(member, 'post', '/repositories').send({ workspace_id: ws, installation_id: installationUuid, external_repository_id: repoId }).expect(403);
    });

    it('connects a repository with a repository-scoped, read-only token and queues initial indexing', async () => {
      gh.grants.length = 0;
      const res = await as(owner, 'post', '/repositories').send({ workspace_id: ws, installation_id: installationUuid, external_repository_id: repoId }).expect(201);
      repositoryUuid = res.body.data.id;
      expect(res.body.data).toMatchObject({ full_name: 'acme/api', visibility: 'private', status: 'connected', indexing_status: 'queued', default_branch: 'main' });
      expect(gh.grants).toEqual([{ installationId: instId, permissions: { metadata: 'read' }, repositoryIds: [repoId] }]);
      const jobs = await db(app).selectFrom('indexing_jobs').selectAll().where('repository_id', '=', repositoryUuid).execute();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ status: 'queued', trigger: 'initial' });
    });

    it('refuses repositories the installation does not grant', async () => {
      await as(owner, 'post', '/repositories').send({ workspace_id: ws, installation_id: installationUuid, external_repository_id: foreignRepoId }).expect((r) => {
        expect([403, 502]).toContain(r.status);
      });
    });

    it('refuses to connect the same repository twice', async () => {
      const res = await as(owner, 'post', '/repositories').send({ workspace_id: ws, installation_id: installationUuid, external_repository_id: repoId }).expect(409);
      expect(res.body.error.code).toBe('REPOSITORY_ALREADY_CONNECTED');
    });

    it('refuses an installation from another workspace (no cross-tenant linking)', async () => {
      await as(outsider, 'post', '/repositories').send({ workspace_id: otherWs, installation_id: installationUuid, external_repository_id: repo2Id }).expect(404);
    });

    it('enforces tenant isolation on repository reads and writes', async () => {
      await as(outsider, 'get', `/repositories/${repositoryUuid}`).expect(404);
      await as(outsider, 'patch', `/repositories/${repositoryUuid}`).send({ status: 'disabled' }).expect(404);
      await as(outsider, 'delete', `/repositories/${repositoryUuid}`).expect(404);
      const list = await as(outsider, 'get', `/repositories?workspace_id=${ws}`).expect(404);
      expect(list.body.error.code).toBe('NOT_FOUND');
      const mine = await as(member, 'get', `/repositories?workspace_id=${ws}`).expect(200);
      expect(mine.body.data.map((r: { id: string }) => r.id)).toContain(repositoryUuid);
    });

    it('validates repository settings and rejects path traversal', async () => {
      await as(owner, 'patch', `/repositories/${repositoryUuid}`).send({ settings: { exclude_paths: ['../etc'] } }).expect(422);
      await as(owner, 'patch', `/repositories/${repositoryUuid}`).send({ settings: { exclude_paths: ['/abs'] } }).expect(422);
      await as(member, 'patch', `/repositories/${repositoryUuid}`).send({ settings: { exclude_paths: ['vendor/'] } }).expect(403);
      const res = await as(owner, 'patch', `/repositories/${repositoryUuid}`).send({ settings: { exclude_paths: ['vendor/', '*.min.js'], max_file_bytes: 100_000 } }).expect(200);
      expect(res.body.data.settings).toMatchObject({ exclude_paths: ['vendor/', '*.min.js'], max_file_bytes: 100_000, auto_index_on_push: true });
    });
  });

  describe('webhooks', () => {
    it('rejects missing or invalid signatures', async () => {
      await request(app.getHttpServer()).post('/api/v1/webhooks/github').set('X-GitHub-Event', 'ping').set('X-GitHub-Delivery', randomUUID()).send({ zen: 'x' }).expect(401);
      await webhook('ping', { zen: 'x' }, randomUUID(), 'wrong-secret-0123456789').expect(401);
    });

    it('verifies the signature over the exact raw bytes', async () => {
      const body = '{"zen":"raw",  "hook_id": 1}';
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'ping')
        .set('X-GitHub-Delivery', randomUUID())
        .set('X-Hub-Signature-256', signPayload(SECRET, Buffer.from('{"zen":"raw","hook_id":1}')))
        .send(body)
        .expect(401);
    });

    it('does not require a CSRF token and accepts a valid delivery', async () => {
      const res = await webhook('ping', { zen: `x-${randomUUID()}` }).expect(202);
      expect(res.body.data.status).toBe('processed');
    });

    it('rejects a duplicate delivery id and a replayed payload under a new delivery id', async () => {
      const payload = { zen: `replay-${randomUUID()}` };
      const delivery = randomUUID();
      await webhook('ping', payload, delivery).expect(202);
      const dup = await webhook('ping', payload, delivery).expect(202);
      expect(dup.body.data.status).toBe('duplicate');
      const replay = await webhook('ping', payload, randomUUID()).expect(202);
      expect(replay.body.data.status).toBe('duplicate');
    });

    it('ignores pushes to non-default branches and coalesces default-branch pushes into the active index job', async () => {
      const repo = await db(app).selectFrom('repositories').select('id').where('external_repository_id', '=', repoId).executeTakeFirstOrThrow();
      const base = { repository: { id: repoId, name: 'api', full_name: 'acme/api', default_branch: 'main' }, installation: { id: instId } };
      const other = await webhook('push', { ...base, ref: 'refs/heads/feature', after: SHA_B }).expect(202);
      expect(other.body.data.status).toBe('ignored');
      const main = await webhook('push', { ...base, ref: 'refs/heads/main', after: SHA_B }).expect(202);
      expect(main.body.data.status).toBe('processed');
      const active = await db(app).selectFrom('indexing_jobs').selectAll().where('repository_id', '=', repo.id).where('status', 'in', ['queued', 'running']).execute();
      expect(active).toHaveLength(1);
    });

    it('ignores events for unknown installations (payload cannot select a workspace)', async () => {
      const res = await webhook('push', { ref: 'refs/heads/main', after: SHA_B, repository: { id: repoId, name: 'api', full_name: 'acme/api' }, installation: { id: 1 } }).expect(202);
      expect(res.body.data.status).toBe('ignored');
    });

    it('marks repositories disconnected when access is removed', async () => {
      const ownerInstall = (await as(owner, 'get', `/integrations/github/installations?workspace_id=${ws}`)).body.data[0].id;
      await as(owner, 'post', '/repositories').send({ workspace_id: ws, installation_id: ownerInstall, external_repository_id: repo2Id, index: false }).expect(201);
      await webhook('installation_repositories', { action: 'removed', installation: { id: instId }, repositories_removed: [{ id: repo2Id }] }).expect(202);
      const r = await db(app).selectFrom('repositories').select(['status', 'indexing_status']).where('external_repository_id', '=', repo2Id).executeTakeFirstOrThrow();
      expect(r).toEqual({ status: 'disconnected', indexing_status: 'disabled' });
    });

    it('stops access when the app is uninstalled', async () => {
      await webhook('installation', { action: 'deleted', installation: { id: instId, account: { login: 'acme' } } }).expect(202);
      const inst = await db(app).selectFrom('git_installations').select('status').where('external_installation_id', '=', instId).executeTakeFirstOrThrow();
      expect(inst.status).toBe('disconnected');
      const repos = await db(app).selectFrom('repositories').select('status').where('organization_id', '=', ws).execute();
      expect(repos.every((r) => r.status === 'disconnected')).toBe(true);
      const jobs = await db(app).selectFrom('indexing_jobs').select('status').where('organization_id', '=', ws).execute();
      expect(jobs.every((j) => j.status === 'cancelled')).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('admins can disconnect an installation, which disconnects its repositories', async () => {
      const id = uid();
      const r = uid();
      gh.installations.set(id, { id, account: 'beta', repos: [] });
      gh.addRepo({ id: r, owner: 'beta', name: 'svc', default_branch: 'main', private: true, branches: { main: SHA_A } }, id);
      const inst = (await completeInstall(owner, ws, id, 200)).body.data;
      const repo = (await as(owner, 'post', '/repositories').send({ workspace_id: ws, installation_id: inst.id, external_repository_id: r, index: false }).expect(201)).body.data;
      await as(member, 'delete', `/integrations/github/installations/${inst.id}`).expect(403);
      await as(owner, 'delete', `/integrations/github/installations/${inst.id}`).expect(204);
      const after = await as(owner, 'get', `/repositories/${repo.id}`).expect(200);
      expect(after.body.data.status).toBe('disconnected');
      const list = await as(owner, 'get', `/integrations/github/installations?workspace_id=${ws}`).expect(200);
      expect(list.body.data.map((i: { id: string }) => i.id)).not.toContain(inst.id);
    });
  });
  describe('GitHub sign-in', () => {
    async function signIn(profile: Parameters<typeof gh.oauthProfiles.set>[1]) {
      const agent = request.agent(app.getHttpServer());
      const start = await agent.get('/api/v1/auth/github/login?return_to=/dashboard').expect(302);
      const state = new URL(start.headers.location as string).searchParams.get('state')!;
      const code = `code-${randomUUID()}`;
      gh.oauthProfiles.set(code, profile);
      const cb = await agent.get(`/api/v1/auth/github/callback?code=${code}&state=${state}`).expect(302);
      return { agent, location: cb.headers.location as string };
    }

    it('signs in with the verified primary email', async () => {
      const id = uid();
      const { agent, location } = await signIn({ id, login: `octo${id}`, emails: [{ email: `other${id}@example.test`, primary: false, verified: true }, { email: `octo${id}@example.test`, primary: true, verified: true }] });
      expect(new URL(location).pathname).toBe('/dashboard');
      const me = await agent.get('/api/v1/me').expect(200);
      expect(me.body.data.email ?? me.body.data.user?.email).toBe(`octo${id}@example.test`);
    });

    it('falls back to the public profile email when the App cannot read /user/emails', async () => {
      const id = uid();
      const { agent, location } = await signIn({ id, login: `pub${id}`, publicEmail: `pub${id}@example.test`, emails: 'forbidden' });
      expect(new URL(location).pathname).toBe('/dashboard');
      const me = await agent.get('/api/v1/me').expect(200);
      expect(me.body.data.email ?? me.body.data.user?.email).toBe(`pub${id}@example.test`);
    });

    it('falls back to the GitHub noreply address when no email is readable', async () => {
      const id = uid();
      const { agent } = await signIn({ id, login: `priv${id}`, publicEmail: null, emails: 'forbidden' });
      const me = await agent.get('/api/v1/me').expect(200);
      expect(me.body.data.email ?? me.body.data.user?.email).toBe(`${id}+priv${id}@users.noreply.github.com`);
      // Signing in again resolves to the same account (keyed on the GitHub user id).
      const again = await signIn({ id, login: `priv${id}`, publicEmail: null, emails: 'forbidden' });
      const me2 = await again.agent.get('/api/v1/me').expect(200);
      expect(me2.body.data.id ?? me2.body.data.user?.id).toBe(me.body.data.id ?? me.body.data.user?.id);
    });

    it('refuses an account without a verified primary email when emails are readable', async () => {
      const id = uid();
      const { location } = await signIn({ id, login: `unv${id}`, emails: [{ email: `unv${id}@example.test`, primary: true, verified: false }] });
      expect(location).toContain('/login?error=oauth_failed');
    });
  });
});
