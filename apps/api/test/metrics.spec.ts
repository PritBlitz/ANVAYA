import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, bootApp, createWorkspace, login } from './helpers.js';

const TOKEN = 'metrics-test-token-0123456789';

describe('metrics endpoint', () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.METRICS_TOKEN = TOKEN;
    app = await bootApp();
  });
  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  it('requires the bearer token', async () => {
    await request(app.getHttpServer()).get('/api/v1/internal/metrics').expect(401);
    await request(app.getHttpServer()).get('/api/v1/internal/metrics').set('Authorization', 'Bearer wrong-token-0123456789').expect(401);
  });

  it('exposes Prometheus counters labelled by route template, never by id', async () => {
    const user = await login(app);
    const ws = await createWorkspace(user);
    await as(user, 'get', `/workspaces/${ws}`).expect(200);
    const res = await request(app.getHttpServer()).get('/api/v1/internal/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('# TYPE anvaya_http_requests_total counter');
    expect(res.text).toMatch(/anvaya_http_requests_total\{method="GET",route="\/api\/v1\/workspaces\/:workspaceId",status="2xx"\} \d+/);
    expect(res.text).not.toContain(ws);
    expect(res.text).toContain('anvaya_http_request_duration_seconds_bucket');
  });
});
