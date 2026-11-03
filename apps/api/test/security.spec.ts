import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, bootApp, createWorkspace, login, type TestUser } from './helpers.js';

/**
 * Security suite (ROADMAP Phase 7), driven by the API's own OpenAPI document so that every route,
 * including ones added later, is held to the same rules:
 *   1. every route outside a short public allowlist rejects anonymous callers (401);
 *   2. every state-changing route rejects a signed-in caller without the CSRF token (403);
 *   3. no error response leaks stack traces, file paths, SQL or framework internals;
 *   4. every response carries the security headers;
 *   5. a signed-in non-member cannot see that another workspace's resources exist (404).
 * Webhook signatures, sandbox escape probes, SSRF/redirect handling, prompt injection and redaction
 * have their own focused suites (github, sandbox/gvisor.live, execution, ai, redaction tests).
 */

type Method = 'get' | 'post' | 'patch' | 'delete';
interface Route {
  method: Method;
  path: string;
}

const spec = JSON.parse(readFileSync(path.resolve(__dirname, '../openapi.json'), 'utf8')) as {
  paths: Record<string, Partial<Record<string, { security?: unknown[] }>>>;
  security?: unknown[];
};

/** Routes that are public by design, each with its own protection. */
const PUBLIC = new Set([
  'get /health/live',
  'get /health/ready',
  'get /auth/providers',
  'post /auth/dev-login', // disabled in production by config validation
  'get /auth/github/login', // starts OAuth; state cookie checked on callback
  'get /auth/github/callback',
  'post /webhooks/github', // HMAC signature verified
  'get /internal/metrics', // bearer token, disabled when METRICS_TOKEN is unset
]);

const routes: Route[] = Object.entries(spec.paths).flatMap(([p, ops]) =>
  (['get', 'post', 'patch', 'delete'] as const).filter((m) => ops[m]).map((method) => ({ method, path: p })),
);
const key = (r: Route) => `${r.method} ${r.path}`;
const secured = routes.filter((r) => !PUBLIC.has(key(r)));
const mutating = secured.filter((r) => r.method !== 'get');

/** Fills path parameters with fresh UUIDs: authorization must fail before any lookup. */
function concrete(p: string): string {
  return p.replace(/\{[^}]+\}/g, () => randomUUID());
}

const LEAKS = /\bat [\w$.<>]+ \(|node_modules|\.(ts|js):\d+|"stack"|\bSELECT\b|\bINSERT INTO\b|syntax error at|QueryFailedError|TypeError:|ECONNREFUSED/;

function expectSafe(res: request.Response, label: string) {
  expect(JSON.stringify(res.body ?? res.text), `${label} leaks internals`).not.toMatch(LEAKS);
  expect(res.headers['x-content-type-options'], `${label} nosniff`).toBe('nosniff');
  expect(res.headers['content-security-policy'], `${label} CSP`).toContain("default-src 'none'");
  expect(res.headers['x-powered-by'], `${label} x-powered-by`).toBeUndefined();
  expect(res.headers['x-request-id'], `${label} request id`).toBeTruthy();
}

let app: INestApplication;
let owner: TestUser;
let outsider: TestUser;
let workspaceId: string;

beforeAll(async () => {
  app = await bootApp();
  owner = await login(app);
  outsider = await login(app);
  workspaceId = await createWorkspace(owner);
});
afterAll(async () => {
  await app.close();
});

describe('security suite', () => {
  it('covers a meaningful share of the API surface', () => {
    expect(routes.length).toBeGreaterThan(50);
    // Every allowlisted public route still exists: a rename must be re-reviewed, not silently public.
    for (const k of PUBLIC) expect(routes.map(key), `${k} is in the allowlist but not in openapi.json`).toContain(k);
  });

  it('rejects anonymous callers on every non-public route', async () => {
    const failures: string[] = [];
    for (const r of secured) {
      const res = await request(app.getHttpServer())[r.method](`/api/v1${concrete(r.path)}`).send({});
      if (res.status !== 401 || res.body?.error?.code !== 'UNAUTHENTICATED') failures.push(`${key(r)} -> ${res.status} ${res.body?.error?.code ?? ''}`);
      expectSafe(res, key(r));
    }
    expect(failures).toEqual([]);
  });

  it('rejects state-changing requests without the CSRF token on every route', async () => {
    const failures: string[] = [];
    for (const r of mutating) {
      const res = await owner.agent[r.method](`/api/v1${concrete(r.path)}`).send({});
      if (res.status !== 403 || res.body?.error?.code !== 'CSRF_TOKEN_INVALID') failures.push(`${key(r)} -> ${res.status} ${res.body?.error?.code ?? ''}`);
      expectSafe(res, key(r));
    }
    expect(failures).toEqual([]);
  });

  it('rejects a CSRF token that belongs to another session', async () => {
    const res = await owner.agent.post('/api/v1/workspaces').set('X-CSRF-Token', outsider.csrf).send({ name: 'forged' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('never leaks internals on malformed input', async () => {
    const cases: Array<[string, request.Response]> = [
      ['truncated JSON', await owner.agent.post('/api/v1/workspaces').set('X-CSRF-Token', owner.csrf).set('Content-Type', 'application/json').send('{"name": ')],
      ['malformed id', await as(owner, 'get', '/workspaces/not-a-uuid')],
      ['path traversal', await as(owner, 'get', `/repositories/${randomUUID()}/files/content?path=../../etc/passwd`)],
      ['operator injection', await as(owner, 'patch', `/workspaces/${workspaceId}`).send({ name: { $gt: '' }, settings: 'x'.repeat(10_000) })],
    ];
    for (const [label, res] of cases) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body.error?.code).toEqual(expect.any(String));
      expectSafe(res, label);
    }
  });

  it("hides another workspace's resources from a signed-in non-member", async () => {
    const workspaceRoutes = secured.filter((r) => r.method === 'get' && /^\/workspaces\/\{[^}]+\}/.test(r.path));
    expect(workspaceRoutes.length).toBeGreaterThan(3);
    const failures: string[] = [];
    for (const r of workspaceRoutes) {
      const p = r.path.replace(/^\/workspaces\/\{[^}]+\}/, `/workspaces/${workspaceId}`).replace(/\{[^}]+\}/g, () => randomUUID());
      const res = await as(outsider, 'get', p);
      if (res.status !== 404) failures.push(`${key(r)} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
    // The owner can see the same workspace, so the 404s above are authorization, not routing.
    await as(owner, 'get', `/workspaces/${workspaceId}`).expect(200);
  });

  // API_CONTRACT_NOTES §4: on routes without a workspace in the path, X-Workspace-Id only selects;
  // a disagreeing workspace_id is refused and membership is always re-verified.
  it('refuses a workspace header that disagrees with workspace_id, and re-verifies membership', async () => {
    const other = await createWorkspace(outsider);
    const mismatch = await as(owner, 'get', `/repositories?workspace_id=${workspaceId}`).set('X-Workspace-Id', other);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('WORKSPACE_MISMATCH');
    const foreign = await as(outsider, 'get', '/repositories').set('X-Workspace-Id', workspaceId);
    expect(foreign.status).toBe(404);
    await as(owner, 'get', '/repositories').set('X-Workspace-Id', workspaceId).expect(200);
  });
});
