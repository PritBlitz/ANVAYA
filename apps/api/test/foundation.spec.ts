import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/database/migrator.js';
import { bootApp } from './helpers.js';

describe('foundation', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves liveness and readiness with the success envelope', async () => {
    const live = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    expect(live.body.data).toEqual({ status: 'ok' });
    expect(live.body.meta.request_id).toMatch(/^req_/);

    const ready = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect(ready.body.data.checks).toEqual({ database: 'ok', redis: 'ok' });
  });

  it('propagates a well-formed X-Request-Id and replaces malformed ones', async () => {
    const ok = await request(app.getHttpServer()).get('/api/v1/health/live').set('X-Request-Id', 'client-abc_123').expect(200);
    expect(ok.headers['x-request-id']).toBe('client-abc_123');
    expect(ok.body.meta.request_id).toBe('client-abc_123');

    const bad = await request(app.getHttpServer()).get('/api/v1/health/live').set('X-Request-Id', 'bad id <script>').expect(200);
    expect(bad.headers['x-request-id']).toMatch(/^req_/);
  });

  it('renders unknown routes with the error envelope', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.meta.request_id).toBeTruthy();
  });

  it('rejects unauthenticated access to protected routes with 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/workspaces').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects malformed JSON with 400 and oversized bodies with 413, without leaking internals', async () => {
    const bad = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-login')
      .set('Content-Type', 'application/json')
      .send('{"email": ')
      .expect(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(bad.body)).not.toMatch(/at \w+ \(|node_modules|SyntaxError/);

    const big = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'x@example.test', pad: 'x'.repeat(1_200_000) }))
      .expect(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('allows CORS only for configured origins, with credentials', async () => {
    const allowed = await request(app.getHttpServer()).options('/api/v1/me').set('Origin', 'http://localhost:3000').set('Access-Control-Request-Method', 'GET');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await request(app.getHttpServer()).options('/api/v1/me').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
});

describe('migrator', () => {
  const url = process.env.DATABASE_URL!;

  it('is idempotent when re-run against an up-to-date schema', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const result = await migrate(pool);
      expect(result.applied).toEqual([]);
      expect(result.alreadyApplied.length).toBe(loadMigrations().length);
    } finally {
      await pool.end();
    }
  });

  it('refuses to run when an applied migration was modified', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const tampered = loadMigrations().map((m, i) => (i === 0 ? { ...m, checksum: 'tampered' } : m));
      await expect(migrate(pool, tampered)).rejects.toThrow(/modified after being applied/);
    } finally {
      await pool.end();
    }
  });

  it('refuses to run when a migration applied in the database is missing on disk', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await expect(migrate(pool, [])).rejects.toThrow(/missing on disk/);
    } finally {
      await pool.end();
    }
  });
});
