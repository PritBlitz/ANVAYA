import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { IndexerService } from '../src/indexing/indexer.service.js';
import type { FakeGithub } from './fake-github.js';
import { as, db, type TestUser } from './helpers.js';

let nextExternalId = 7_000_000 + Math.floor(Math.random() * 1_000_000);
export const externalId = () => nextExternalId++;

/** Links a fake GitHub installation to `workspaceId` through the verified handshake. */
export async function linkInstallation(gh: FakeGithub, owner: TestUser, workspaceId: string, account = 'acme'): Promise<{ installationUuid: string; installationId: number }> {
  const installationId = externalId();
  gh.installations.set(installationId, { id: installationId, account, repos: [] });
  const url = await as(owner, 'get', `/integrations/github/install-url?workspace_id=${workspaceId}`).expect(200);
  const code = `code-${randomUUID()}`;
  gh.oauthCodes.set(code, [installationId]);
  const res = await as(owner, 'post', '/integrations/github/complete')
    .send({ workspace_id: workspaceId, installation_id: installationId, state: url.body.data.state, code })
    .expect(200);
  return { installationUuid: res.body.data.id as string, installationId };
}

/** Runs every queued indexing job for the repository in-process (no worker needed). */
export async function runIndexing(app: INestApplication, repositoryId: string): Promise<void> {
  const jobs = await db(app).selectFrom('indexing_jobs').select('id').where('repository_id', '=', repositoryId).where('status', 'in', ['queued', 'running']).execute();
  for (const j of jobs) await app.get(IndexerService).run(j.id);
}
