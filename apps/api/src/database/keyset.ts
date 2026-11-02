import { sql, type RawBuilder } from 'kysely';
import type { Cursor } from '../common/http.js';

/** Exact microsecond epoch of a timestamptz column, as a bigint (parsed to number). */
export function cursorUs(column: string): RawBuilder<number> {
  return sql<number>`(extract(epoch from ${sql.ref(column)}) * 1000000)::bigint`;
}

/** `(created_at, id) < (cursor)` predicate for descending keyset pagination. */
export function beforeCursor(createdAtColumn: string, idColumn: string, cursor: Cursor): RawBuilder<boolean> {
  return sql<boolean>`(${sql.ref(createdAtColumn)}, ${sql.ref(idColumn)}) < (timestamptz 'epoch' + ${cursor.us} * interval '1 microsecond', ${cursor.id}::uuid)`;
}
