import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { sha256Hex } from '../common/crypto.js';

/** Migrations live in `apps/api/migrations`, two levels above both src/database and dist/database. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

const MIGRATION_LOCK_ID = 7_301_984_221; // arbitrary, stable advisory lock key

export interface MigrationFile {
  name: string;
  checksum: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      // Normalize line endings so checksums are stable across platforms.
      const sqlText = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
      return { name, sql: sqlText, checksum: sha256Hex(sqlText) };
    });
}

/**
 * Applies pending SQL migrations in order, each in its own transaction, under a
 * session advisory lock so concurrent deploys cannot race. Refuses to proceed
 * if an applied migration's checksum changed (applied migrations are immutable)
 * or if the database knows a migration that is missing on disk.
 */
export async function migrate(pool: pg.Pool, migrations = loadMigrations()): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    const onDisk = new Set(migrations.map((m) => m.name));

    for (const name of applied.keys()) {
      if (!onDisk.has(name)) throw new Error(`Migration ${name} is applied in the database but missing on disk`);
    }

    const result: MigrationResult = { applied: [], alreadyApplied: [] };
    for (const m of migrations) {
      const existing = applied.get(m.name);
      if (existing !== undefined) {
        if (existing !== m.checksum) {
          throw new Error(`Migration ${m.name} was modified after being applied (checksum mismatch). Add a new migration instead.`);
        }
        result.alreadyApplied.push(m.name);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(m.name);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
