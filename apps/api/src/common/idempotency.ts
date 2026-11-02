import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { sql } from 'kysely';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { DatabaseService } from '../database/database.service.js';
import { json } from '../database/types.js';
import type { AuthedRequest } from '../identity/auth.decorators.js';
import { canonicalJson, sha256Hex } from './crypto.js';
import { Errors } from './errors.js';
import { logger } from './logger.js';

const IDEMPOTENCY_META = 'anvaya:idempotency';
const KEY_RE = /^[A-Za-z0-9._:-]{8,255}$/;
const TTL_HOURS = 24;
const log = logger('idempotency');

interface IdempotencyOptions {
  /** When true the Idempotency-Key header is mandatory (external side effects). */
  required: boolean;
}

/**
 * Marks a creation/side-effect endpoint as idempotent (API_SPEC §1). With an
 * `Idempotency-Key` header the first completed response is stored and replayed
 * for retries with the same body; reuse with a different body returns 409.
 */
export const Idempotent = (opts: Partial<IdempotencyOptions> = {}) =>
  applyDecorators(SetMetadata(IDEMPOTENCY_META, { required: opts.required ?? false }), UseInterceptors(IdempotencyInterceptor));

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly database: DatabaseService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const opts = this.reflector.get<IdempotencyOptions>(IDEMPOTENCY_META, context.getHandler());
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const key = req.header('idempotency-key');

    if (!key) {
      if (opts.required) throw Errors.unprocessable('IDEMPOTENCY_KEY_REQUIRED', 'This operation requires an Idempotency-Key header.');
      return next.handle();
    }
    if (!KEY_RE.test(key)) throw Errors.badRequest('Idempotency-Key must be 8-255 characters of [A-Za-z0-9._:-].');
    if (!req.user) throw Errors.unauthenticated();

    const userId = req.user.id;
    const endpoint = `${req.method} ${req.path}`;
    const body: unknown = req.body;
    const requestHash = sha256Hex(canonicalJson({ body: body ?? null, query: req.query }));
    const db = this.database.db;

    // Expired records are treated as absent.
    await db
      .deleteFrom('idempotency_keys')
      .where('user_id', '=', userId)
      .where('endpoint', '=', endpoint)
      .where('idempotency_key', '=', key)
      .where('expires_at', '<', sql<Date>`now()`)
      .execute();

    const inserted = await db
      .insertInto('idempotency_keys')
      .values({
        user_id: userId,
        endpoint,
        idempotency_key: key,
        request_hash: requestHash,
        status: 'in_progress',
        expires_at: new Date(Date.now() + TTL_HOURS * 3600 * 1000),
      })
      .onConflict((oc) => oc.columns(['user_id', 'endpoint', 'idempotency_key']).doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!inserted) {
      const existing = await db
        .selectFrom('idempotency_keys')
        .selectAll()
        .where('user_id', '=', userId)
        .where('endpoint', '=', endpoint)
        .where('idempotency_key', '=', key)
        .executeTakeFirstOrThrow();
      if (existing.request_hash !== requestHash) {
        throw Errors.conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
      }
      if (existing.status === 'in_progress') {
        throw Errors.conflict('IDEMPOTENCY_REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed.');
      }
      res.status(existing.response_status ?? 200);
      res.setHeader('Idempotent-Replayed', 'true');
      return from([existing.response_body]);
    }

    const recordId = inserted.id;
    return from(
      (async () => {
        try {
          const result: unknown = await lastValueFrom(next.handle(), { defaultValue: undefined });
          await db
            .updateTable('idempotency_keys')
            .set({ status: 'completed', response_status: res.statusCode, response_body: json(result ?? null) })
            .where('id', '=', recordId)
            .execute();
          return result;
        } catch (err) {
          // Failed requests are not cached; the client may retry with the same key.
          await db
            .deleteFrom('idempotency_keys')
            .where('id', '=', recordId)
            .execute()
            .catch((e: unknown) => log.error({ err: e }, 'failed to release idempotency key'));
          throw err;
        }
      })(),
    );
  }
}
