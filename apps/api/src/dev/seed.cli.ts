/**
 * Development seed: creates a user, a workspace and a repository backed by a
 * local fixture directory, then queues indexing. Lets the web app be developed
 * without GitHub App credentials.
 *
 *   REPOSITORY_SOURCE=local_fixture LOCAL_FIXTURE_ROOT=../../infra/fixtures \
 *   node --env-file=.env dist/dev/seed.cli.js dev@example.test acme/demo-service
 *
 * Refuses to run unless NODE_ENV=development and REPOSITORY_SOURCE=local_fixture.
 */
import { createHash } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createRootLogger } from '../common/logger.js';
import { AppConfig } from '../config/config.js';
import { createPool } from '../database/database.service.js';
import { type Database, json } from '../database/types.js';
import { QUEUES } from '../queue/queues.js';

const config = new AppConfig();
const log = createRootLogger(config.env.LOG_LEVEL, 'anvaya-seed');
if (config.env.NODE_ENV !== 'development' || config.env.REPOSITORY_SOURCE !== 'local_fixture') {
  log.fatal('seed only runs with NODE_ENV=development and REPOSITORY_SOURCE=local_fixture');
  process.exit(1);
}
const email = (process.argv[2] ?? 'dev@example.test').toLowerCase();
const fullName = process.argv[3] ?? 'acme/demo-service';
const [owner, name] = fullName.split('/');
if (!owner || !name) {
  log.fatal('repository must be <owner>/<name>');
  process.exit(1);
}

const pool = createPool(config.env.DATABASE_URL, 2);
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
const redis = new Redis(config.env.REDIS_URL, { maxRetriesPerRequest: null });
try {
  // Stable synthetic id in a range GitHub does not use.
  const externalId = 9_000_000_000 + (parseInt(createHash('sha1').update(fullName).digest('hex').slice(0, 7), 16) % 1_000_000);
  const result = await db.transaction().execute(async (tx) => {
    const user =
      (await tx.selectFrom('users').selectAll().where('auth_subject', '=', `dev:${email}`).executeTakeFirst()) ??
      (await tx.insertInto('users').values({ auth_subject: `dev:${email}`, email, display_name: 'Dev User' }).returningAll().executeTakeFirstOrThrow());
    const slug = 'dev-workspace';
    const org =
      (await tx.selectFrom('organizations').selectAll().where('slug', '=', slug).executeTakeFirst()) ??
      (await tx
        .insertInto('organizations')
        .values({ name: 'Dev Workspace', slug, created_by: user.id, settings: json({ ai_policy: { default_mode: 'mock', allowed_modes: ['mock', 'local'], cloud: { enabled: false, provider: null, model: null, data_categories: [] }, limits: { max_input_tokens: 6000, max_output_tokens: 1024, request_timeout_seconds: 300 } } }) })
        .returningAll()
        .executeTakeFirstOrThrow());
    await tx.insertInto('memberships').values({ organization_id: org.id, user_id: user.id, role: 'owner' }).onConflict((oc) => oc.columns(['organization_id', 'user_id']).doNothing()).execute();
    const repo =
      (await tx.selectFrom('repositories').selectAll().where('external_repository_id', '=', externalId).executeTakeFirst()) ??
      (await tx
        .insertInto('repositories')
        .values({ organization_id: org.id, installation_id: null, external_repository_id: externalId, owner, name, full_name: fullName, default_branch: 'main', visibility: 'private', settings: json({}) })
        .returningAll()
        .executeTakeFirstOrThrow());
    const active = await tx.selectFrom('indexing_jobs').select('id').where('repository_id', '=', repo.id).where('status', 'in', ['queued', 'running']).executeTakeFirst();
    const job = active ?? (await tx.insertInto('indexing_jobs').values({ organization_id: org.id, repository_id: repo.id, trigger: 'initial', progress: json({}) }).returning('id').executeTakeFirstOrThrow());
    await tx.updateTable('repositories').set({ indexing_status: 'queued' }).where('id', '=', repo.id).execute();
    return { user, org, repo, jobId: job.id };
  });
  const queue = new Queue(QUEUES.repositoryIndex, { connection: redis });
  await queue.add('index', { indexingJobId: result.jobId, organizationId: result.org.id, repositoryId: result.repo.id }, { jobId: result.jobId, attempts: 2 });
  await queue.close();
  log.info({ email, workspace_id: result.org.id, repository_id: result.repo.id, indexing_job_id: result.jobId }, 'seeded; sign in with POST /api/v1/auth/dev-login');
} finally {
  await db.destroy();
  redis.disconnect();
}
