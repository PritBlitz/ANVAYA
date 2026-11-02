import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, as, bootApp, createWorkspace, db, login, type TestUser } from './helpers.js';

describe('workspaces, memberships and authorization', () => {
  let app: INestApplication;
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let ws: string;

  beforeAll(async () => {
    app = await bootApp();
    owner = await login(app);
    admin = await login(app);
    member = await login(app);
    viewer = await login(app);
    outsider = await login(app);
    ws = await createWorkspace(owner, 'Acme Engineering');
    await addMember(owner, admin, ws, 'admin');
    await addMember(owner, member, ws, 'member');
    await addMember(owner, viewer, ws, 'viewer');
  });
  afterAll(async () => {
    await app.close();
  });

  it('creates a workspace with a derived slug and the creator as owner', async () => {
    const res = await as(owner, 'post', '/workspaces').send({ name: 'Ünïcode Team!!' }).expect(201);
    expect(res.body.data.slug).toMatch(/^[a-z0-9-]+$/);
    expect(res.body.data.role).toBe('owner');
  });

  it('rejects unknown fields and invalid bodies with 422', async () => {
    const res = await as(owner, 'post', '/workspaces').send({ name: 'x', plan_key: 'enterprise' }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.issues).toBeInstanceOf(Array);
    await as(owner, 'post', '/workspaces').send({ name: '' }).expect(422);
  });

  it('returns 409 for a taken explicit slug', async () => {
    const slug = `taken-${randomUUID().slice(0, 6)}`;
    await as(owner, 'post', '/workspaces').send({ name: 'A', slug }).expect(201);
    const res = await as(owner, 'post', '/workspaces').send({ name: 'B', slug }).expect(409);
    expect(res.body.error.code).toBe('SLUG_TAKEN');
  });

  it('lists only workspaces the caller belongs to', async () => {
    const res = await as(outsider, 'get', '/workspaces').expect(200);
    expect(res.body.data.map((w: { id: string }) => w.id)).not.toContain(ws);
  });

  it('conceals workspaces from non-members (404, not 403)', async () => {
    await as(outsider, 'get', `/workspaces/${ws}`).expect(404);
    await as(outsider, 'get', `/workspaces/${ws}/members`).expect(404);
    await as(outsider, 'patch', `/workspaces/${ws}`).send({ name: 'pwned' }).expect(404);
    await as(outsider, 'post', `/workspaces/${ws}/invitations`).send({ email: outsider.email, role: 'admin' }).expect(404);
    await as(outsider, 'get', `/workspaces/${ws}/audit-events`).expect(404);
    await as(outsider, 'get', '/workspaces/not-a-uuid').expect(404);
  });

  it('enforces roles on workspace updates', async () => {
    await as(viewer, 'patch', `/workspaces/${ws}`).send({ name: 'nope' }).expect(403);
    await as(member, 'patch', `/workspaces/${ws}`).send({ name: 'nope' }).expect(403);
    const res = await as(admin, 'patch', `/workspaces/${ws}`)
      .send({ settings: { run_budget_limits: { max_steps: 6 }, retention: { log_days: 30 } } })
      .expect(200);
    expect(res.body.data.settings.run_budget_limits.max_steps).toBe(6);
    expect(res.body.data.settings.retention.log_days).toBe(30);
  });

  it('paginates members with an opaque cursor', async () => {
    const first = await as(member, 'get', `/workspaces/${ws}/members?limit=2`).expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.page.has_more).toBe(true);
    const second = await as(member, 'get', `/workspaces/${ws}/members?limit=2&cursor=${first.body.meta.page.next_cursor}`).expect(200);
    expect(second.body.data).toHaveLength(2);
    const ids = new Set([...first.body.data, ...second.body.data].map((m: { user_id: string }) => m.user_id));
    expect(ids.size).toBe(4);
    expect(second.body.meta.page).toEqual({ next_cursor: null, has_more: false });
    await as(member, 'get', `/workspaces/${ws}/members?cursor=garbage`).expect(422);
  });

  it('applies role-change rules', async () => {
    // Members/viewers cannot change roles.
    await as(member, 'patch', `/workspaces/${ws}/members/${viewer.id}`).send({ role: 'member' }).expect(403);
    // Admins cannot grant owner or modify other admins.
    await as(admin, 'patch', `/workspaces/${ws}/members/${viewer.id}`).send({ role: 'owner' }).expect(403);
    // Admins can manage members/viewers.
    const res = await as(admin, 'patch', `/workspaces/${ws}/members/${viewer.id}`).send({ role: 'member' }).expect(200);
    expect(res.body.data.role).toBe('member');
    await as(admin, 'patch', `/workspaces/${ws}/members/${viewer.id}`).send({ role: 'viewer' }).expect(200);
  });

  it('never removes or demotes the last owner', async () => {
    const res = await as(owner, 'patch', `/workspaces/${ws}/members/${owner.id}`).send({ role: 'admin' }).expect(409);
    expect(res.body.error.code).toBe('LAST_OWNER');
    await as(owner, 'delete', `/workspaces/${ws}/members/${owner.id}`).expect(409);
  });

  it('only owners can invite admins; invitations are bound to the invited email', async () => {
    await as(admin, 'post', `/workspaces/${ws}/invitations`).send({ email: 'someone@example.test', role: 'admin' }).expect(403);
    const target = await login(app);
    const inv = await as(admin, 'post', `/workspaces/${ws}/invitations`).send({ email: target.email, role: 'viewer' }).expect(201);
    expect(inv.body.data.token).toBeTruthy();
    const wrong = await login(app);
    await as(wrong, 'post', '/invitations/accept').send({ token: inv.body.data.token }).expect(403);
    await as(target, 'post', '/invitations/accept').send({ token: inv.body.data.token }).expect(200);
    // Single-use.
    await as(target, 'post', '/invitations/accept').send({ token: inv.body.data.token }).expect(404);
    const stored = await db(app).selectFrom('workspace_invitations').select('token_hash').where('id', '=', inv.body.data.id).executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toBe(inv.body.data.token);
  });

  it('rejects duplicate pending invitations and inviting existing members', async () => {
    const email = `dup-${randomUUID().slice(0, 6)}@example.test`;
    await as(owner, 'post', `/workspaces/${ws}/invitations`).send({ email, role: 'member' }).expect(201);
    const dup = await as(owner, 'post', `/workspaces/${ws}/invitations`).send({ email, role: 'member' }).expect(409);
    expect(dup.body.error.code).toBe('INVITATION_PENDING');
    const existing = await as(owner, 'post', `/workspaces/${ws}/invitations`).send({ email: member.email, role: 'member' }).expect(409);
    expect(existing.body.error.code).toBe('ALREADY_MEMBER');
    const pending = (await as(owner, 'get', `/workspaces/${ws}/invitations`).expect(200)).body.data;
    expect(pending.map((i: { email: string }) => i.email)).toContain(email);
  });

  it('members may leave; admins cannot remove admins', async () => {
    const leaver = await login(app);
    await addMember(owner, leaver, ws, 'member');
    await as(leaver, 'delete', `/workspaces/${ws}/members/${leaver.id}`).expect(204);
    await as(leaver, 'get', `/workspaces/${ws}`).expect(404);

    const admin2 = await login(app);
    await addMember(owner, admin2, ws, 'admin');
    await as(admin, 'delete', `/workspaces/${ws}/members/${admin2.id}`).expect(403);
    await as(owner, 'delete', `/workspaces/${ws}/members/${admin2.id}`).expect(204);
  });

  it('writes audit events for privileged actions, visible to admins only', async () => {
    await as(member, 'get', `/workspaces/${ws}/audit-events`).expect(403);
    const res = await as(admin, 'get', `/workspaces/${ws}/audit-events?action=membership.role_changed`).expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toMatchObject({ action: 'membership.role_changed', resource_type: 'user' });
  });
});

describe('idempotency', () => {
  let app: INestApplication;
  let user: TestUser;
  beforeAll(async () => {
    app = await bootApp();
    user = await login(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('replays the original response for a retried request', async () => {
    const key = `key-${randomUUID()}`;
    const first = await as(user, 'post', '/workspaces', { idempotencyKey: key }).send({ name: 'Idem' }).expect(201);
    const second = await as(user, 'post', '/workspaces', { idempotencyKey: key }).send({ name: 'Idem' }).expect(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);
    const count = await db(app).selectFrom('organizations').select('id').where('name', '=', 'Idem').where('created_by', '=', user.id).execute();
    expect(count).toHaveLength(1);
  });

  it('returns 409 when a key is reused with a different body', async () => {
    const key = `key-${randomUUID()}`;
    await as(user, 'post', '/workspaces', { idempotencyKey: key }).send({ name: 'One' }).expect(201);
    const res = await as(user, 'post', '/workspaces', { idempotencyKey: key }).send({ name: 'Two' }).expect(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('does not cache failures, so a corrected retry with the same key succeeds', async () => {
    const key = `key-${randomUUID()}`;
    const slug = `fail-${randomUUID().slice(0, 6)}`;
    await as(user, 'post', '/workspaces').send({ name: 'Owner of slug', slug }).expect(201);
    await as(user, 'post', '/workspaces', { idempotencyKey: key }).send({ name: 'X', slug }).expect(409);
    const rows = await db(app).selectFrom('idempotency_keys').selectAll().where('idempotency_key', '=', key).execute();
    expect(rows).toHaveLength(0);
  });

  it('keys are scoped per user', async () => {
    const other = await login(app);
    const key = `key-${randomUUID()}`;
    const a = await as(user, 'post', '/workspaces', { idempotencyKey: key }).send({ name: 'Scoped' }).expect(201);
    const b = await as(other, 'post', '/workspaces', { idempotencyKey: key }).send({ name: 'Scoped' }).expect(201);
    expect(a.body.data.id).not.toBe(b.body.data.id);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
  });

  it('rejects malformed keys', async () => {
    await as(user, 'post', '/workspaces', { idempotencyKey: 'short' }).send({ name: 'x' }).expect(400);
  });
});
