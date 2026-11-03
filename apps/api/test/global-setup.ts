import { Redis } from 'ioredis';
import pg from 'pg';
import { migrate } from '../src/database/migrator.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://anvaya:anvaya_local_only@127.0.0.1:5433/anvaya_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/1';

/**
 * Resets the dedicated test database to an empty schema and applies every
 * migration from scratch (DATABASE.md §9: test migrations from empty).
 */
export default async function setup(): Promise<void> {
  // anvaya_test, or anvaya_test_<suffix> so parallel checkouts can each own a test database.
  if (!/\/anvaya_test(_[a-z0-9]+)?(\?|$)/.test(DATABASE_URL)) {
    throw new Error(`Refusing to reset a non-test database: ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`);
  }
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  } finally {
    await pool.end();
  }
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}
