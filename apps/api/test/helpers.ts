import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../src/bootstrap.js';
import { RedisService } from '../src/common/redis.service.js';
import { DatabaseService } from '../src/database/database.service.js';

export interface TestUser {
  id: string;
  email: string;
  csrf: string;
  agent: TestAgent;
}

export async function bootApp(): Promise<INestApplication> {
  const app = await createApp();
  await resetRateLimits(app);
  return app;
}

/** Clears rate-limit counters so independent test files do not share a window. */
export async function resetRateLimits(app: INestApplication): Promise<void> {
  const redis = app.get(RedisService).client;
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) await redis.del(...keys);
}

export function db(app: INestApplication) {
  return app.get(DatabaseService).db;
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

/** Signs in via dev login and returns an agent that carries cookies. */
export async function login(app: INestApplication, email = uniqueEmail()): Promise<TestUser> {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/api/v1/auth/dev-login').send({ email }).expect(200);
  return { id: res.body.data.user.id as string, email, csrf: res.body.data.csrf_token as string, agent };
}

type Method = 'get' | 'post' | 'patch' | 'delete';

/** Issues a request as `user`, adding the CSRF header for mutating methods. */
export function as(user: TestUser, method: Method, path: string, opts: { idempotencyKey?: string } = {}) {
  let req = user.agent[method](`/api/v1${path}`);
  if (method !== 'get') req = req.set('X-CSRF-Token', user.csrf);
  if (opts.idempotencyKey) req = req.set('Idempotency-Key', opts.idempotencyKey);
  return req;
}

export async function createWorkspace(user: TestUser, name = `WS ${randomUUID().slice(0, 6)}`): Promise<string> {
  const res = await as(user, 'post', '/workspaces').send({ name }).expect(201);
  return res.body.data.id as string;
}

/** Adds `member` to `workspaceId` with `role` via the invitation flow. */
export async function addMember(owner: TestUser, member: TestUser, workspaceId: string, role: 'admin' | 'member' | 'viewer'): Promise<void> {
  const inv = await as(owner, 'post', `/workspaces/${workspaceId}/invitations`).send({ email: member.email, role }).expect(201);
  await as(member, 'post', '/invitations/accept').send({ token: inv.body.data.token }).expect(200);
}
