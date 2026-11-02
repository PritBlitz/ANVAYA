import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { AppConfig } from '../config/config.js';
import type { Database } from './types.js';

// int8 → number. All bigint columns in this schema (durations, GitHub ids,
// event ids) are well below 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    application_name: 'anvaya-api',
  });
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: pg.Pool;
  readonly db: Db;

  constructor(config: AppConfig) {
    this.pool = createPool(config.env.DATABASE_URL, config.env.DATABASE_POOL_MAX);
    this.db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: this.pool }) });
  }

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(fn);
  }

  async ping(): Promise<boolean> {
    try {
      await sql`select 1`.execute(this.db);
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}
