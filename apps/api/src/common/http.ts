import { randomUUID } from 'node:crypto';
import {
  type ArgumentsHost,
  Catch,
  type CallHandler,
  type ExceptionFilter,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
  type PipeTransform,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import { z, type ZodType } from 'zod';
import { AppError, Errors } from './errors.js';
import { logger } from './logger.js';
import { metrics, statusClass } from './metrics.js';
import { requestContext } from './request-context.js';

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Express middleware: assigns/propagates X-Request-Id and opens the request context. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : `req_${randomUUID()}`;
  res.setHeader('X-Request-Id', requestId);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    // Route template (not the concrete URL) keeps label cardinality bounded.
    const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
    metrics.httpRequests.inc({ method: req.method, route, status: statusClass(res.statusCode) });
    metrics.httpDuration.observe({ method: req.method, route }, Number(process.hrtime.bigint() - started) / 1e9);
  });
  (req as Request & { requestId: string }).requestId = requestId;
  requestContext.run({ requestId, ip: req.ip }, () => next());
}

export function getRequestId(req: Request): string {
  return (req as Request & { requestId?: string }).requestId ?? requestContext.requestId() ?? 'unknown';
}

/** A paginated result; rendered as `data: items` with `meta.page`. */
export class Page<T> {
  constructor(
    readonly items: T[],
    readonly nextCursor: string | null,
  ) {}
}

/** Marker for handlers that write the response themselves (SSE, redirects). */
export const RAW_RESPONSE = Symbol('raw-response');

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((value: unknown) => {
        if (value === RAW_RESPONSE || res.headersSent) return undefined;
        if (res.statusCode === 204) return undefined;
        const meta: Record<string, unknown> = { request_id: getRequestId(req) };
        if (value instanceof Page) {
          meta.page = { next_cursor: value.nextCursor, has_more: value.nextCursor !== null };
          return { data: value.items, meta };
        }
        return { data: value ?? null, meta };
      }),
    );
  }
}

const log = logger('http');

/** Renders every error through the canonical error envelope. Never leaks internals. */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = getRequestId(req);
    const appError = toAppError(exception);

    if (appError.status >= 500 && !(exception instanceof AppError)) {
      // Unexpected failure: full error for diagnosis (never sent to the client).
      log.error({ err: exception, code: appError.code, path: req.path, method: req.method }, 'request failed');
    } else if (appError.status >= 500) {
      // Known upstream/dependency condition (e.g. provider unavailable).
      log.warn({ code: appError.code, status: appError.status, path: req.path, method: req.method }, 'request failed: dependency unavailable');
    } else {
      log.debug({ code: appError.code, path: req.path, method: req.method }, 'request rejected');
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    if (appError.status === 429 && typeof appError.details.retry_after_seconds === 'number') {
      res.setHeader('Retry-After', String(appError.details.retry_after_seconds));
    }
    res.status(appError.status).json({
      error: { code: appError.code, message: appError.message, details: appError.details },
      meta: { request_id: requestId },
    });
  }
}

function toAppError(exception: unknown): AppError {
  if (exception instanceof AppError) return exception;
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    // body-parser errors surface as HttpException-like objects via Nest; map common ones.
    if (status === 404) return new AppError(404, 'NOT_FOUND', 'Route not found.');
    if (status === 413) return Errors.payloadTooLarge();
    if (status === 400) return Errors.badRequest();
    if (status === 405) return new AppError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return new AppError(status, status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR', status >= 500 ? 'An unexpected error occurred.' : exception.message);
  }
  const maybe = exception as { type?: string; status?: number } | null;
  if (maybe?.type === 'entity.too.large') return Errors.payloadTooLarge();
  if (maybe?.type === 'entity.parse.failed') return Errors.badRequest('The request body is not valid JSON.');
  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
}

/** Formats Zod issues into a stable, client-friendly structure. */
export function zodIssues(error: z.ZodError): Array<{ path: string; message: string; code: string }> {
  return error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message, code: i.code }));
}

export function parseOrThrow<T extends ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw Errors.validation({ issues: zodIssues(result.error) });
  return result.data;
}

/** Nest pipe validating a body/query/param with a Zod schema (422 on failure). */
export class ZodPipe<T extends ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    return parseOrThrow(this.schema, value);
  }
}

export const uuidParam = z.uuid({ message: 'must be a UUID' });

/** Validates a UUID path parameter; malformed ids are reported as not found to avoid probing. */
export class UuidParamPipe implements PipeTransform<unknown, string> {
  constructor(private readonly resource = 'Resource') {}
  transform(value: unknown): string {
    if (!uuidParam.safeParse(value).success) throw Errors.notFound(this.resource);
    return value as string;
  }
}

// ---------------------------------------------------------------------------
// Cursor pagination
// ---------------------------------------------------------------------------
export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});

/**
 * Keyset cursor. `us` is created_at in exact microseconds since epoch (JS Dates
 * would truncate Postgres' microsecond precision and skip rows); `id` breaks ties.
 */
export interface Cursor {
  us: number;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

const cursorSchema = z.object({ us: z.number().int().nonnegative(), id: z.string().min(1).max(64) });

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw Errors.validation({ issues: [{ path: 'cursor', message: 'invalid cursor', code: 'invalid_cursor' }] });
  }
}

/** Given `limit + 1` rows ordered (created_at desc, id desc) with a `cursor_us` column, build a Page. */
export function toPage<T extends { cursor_us: number; id: string | number }, R>(rows: T[], limit: number, mapRow: (row: T) => R): Page<R> {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice.at(-1);
  const next = hasMore && last ? encodeCursor({ us: last.cursor_us, id: String(last.id) }) : null;
  return new Page(slice.map(mapRow), next);
}
