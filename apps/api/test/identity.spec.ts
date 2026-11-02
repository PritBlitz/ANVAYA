import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, bootApp, db, login, resetRateLimits, uniqueEmail } from './helpers.js';

describe('identity and sessions', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('dev login sets an HttpOnly session cookie and a readable CSRF cookie', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/dev-login').send({ email: uniqueEmail() }).expect(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const session = cookies.find((c) => c.startsWith('anvaya_session='));
    const csrf = cookies.find((c) => c.startsWith('anvaya_csrf='));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(csrf).not.toMatch(/HttpOnly/);
    expect(res.body.data.csrf_token).toBeTruthy();
  });

  it('stores only hashes of session tokens', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/dev-login').send({ email: uniqueEmail() }).expect(200);
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('anvaya_session='))!.split(';')[0]!.split('=')[1]!;
    const rows = await db(app).selectFrom('sessions').select('token_hash').where('user_id', '=', res.body.data.user.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(raw);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects dev login without a JSON content type', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/dev-login').type('form').send('email=a@example.test').expect((r) => {
      expect([400, 422]).toContain(r.status);
    });
  });

  it('GET /me returns the user and memberships', async () => {
    const user = await login(app);
    await as(user, 'post', '/workspaces').send({ name: 'Mine' }).expect(201);
    const res = await as(user, 'get', '/me').expect(200);
    expect(res.body.data.user.email).toBe(user.email);
    expect(res.body.data.memberships).toHaveLength(1);
    expect(res.body.data.memberships[0].role).toBe('owner');
  });

  it('requires a session-bound CSRF token for mutations', async () => {
    const user = await login(app);
    const missing = await user.agent.post('/api/v1/workspaces').send({ name: 'x' }).expect(403);
    expect(missing.body.error.code).toBe('CSRF_TOKEN_INVALID');

    // Another user's valid token is not accepted for this session.
    const other = await login(app);
    await user.agent.post('/api/v1/workspaces').set('X-CSRF-Token', other.csrf).send({ name: 'x' }).expect(403);

    await as(user, 'post', '/workspaces').send({ name: 'ok' }).expect(201);
  });

  it('rotating the CSRF token invalidates the previous one', async () => {
    const user = await login(app);
    const res = await as(user, 'get', '/auth/csrf').expect(200);
    const fresh = res.body.data.csrf_token as string;
    await user.agent.post('/api/v1/workspaces').set('X-CSRF-Token', user.csrf).send({ name: 'x' }).expect(403);
    await user.agent.post('/api/v1/workspaces').set('X-CSRF-Token', fresh).send({ name: 'x' }).expect(201);
  });

  it('logout revokes the session server-side', async () => {
    const user = await login(app);
    await as(user, 'post', '/auth/logout').expect(204);
    await user.agent.get('/api/v1/me').expect(401);
  });

  it('lists and revokes own sessions but conceals other users sessions', async () => {
    const user = await login(app);
    const second = await login(app, user.email);
    const list = await as(user, 'get', '/auth/sessions').expect(200);
    expect(list.body.data.length).toBe(2);
    const otherId = list.body.data.find((s: { current: boolean }) => !s.current).id as string;

    const stranger = await login(app);
    await as(stranger, 'delete', `/auth/sessions/${otherId}`).expect(404);

    await as(user, 'delete', `/auth/sessions/${otherId}`).expect(204);
    await second.agent.get('/api/v1/me').expect(401);
    await user.agent.get('/api/v1/me').expect(200);
  });

  it('records audit events for login', async () => {
    const user = await login(app);
    const rows = await db(app).selectFrom('audit_events').selectAll().where('actor_user_id', '=', user.id).where('action', '=', 'auth.login').execute();
    expect(rows.length).toBe(1);
    expect(rows[0]!.request_id).toBeTruthy();
  });

  it('audit events are append-only at the database level', async () => {
    const user = await login(app);
    const d = db(app);
    await expect(d.updateTable('audit_events').set({ action: 'tampered' }).where('actor_user_id', '=', user.id).execute()).rejects.toThrow(/append-only/);
    await expect(d.deleteFrom('audit_events').where('actor_user_id', '=', user.id).execute()).rejects.toThrow(/append-only/);
  });

  it('reports available sign-in providers', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/providers').expect(200);
    expect(res.body.data).toEqual({ github: false, dev: true });
  });

  it('rate-limits sign-in attempts and reports Retry-After', async () => {
    await resetRateLimits(app);
    const server = app.getHttpServer();
    let limited: request.Response | undefined;
    for (let i = 0; i < 25 && !limited; i++) {
      const r = await request(server).post('/api/v1/auth/dev-login').send({ email: uniqueEmail('rl') });
      if (r.status === 429) limited = r;
    }
    expect(limited?.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited?.headers['retry-after'])).toBeGreaterThan(0);
    await resetRateLimits(app);
  });

  it('github login reports not configured when OAuth credentials are absent', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/github/login').expect(503);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
  });
});
