import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppConfig } from '../config/config.js';
import { Errors } from './errors.js';
import { logger } from './logger.js';
import { RedisService } from './redis.service.js';

export interface RateLimitOptions {
  /** Logical bucket name, e.g. 'auth', 'search', 'ai', 'task-create'. */
  bucket: string;
  max: number;
  windowSeconds: number;
}

const RATE_LIMIT_KEY = 'anvaya:rate-limit';

/** Per-route rate limit (API_SPEC §10). Keyed by user when authenticated, else client IP. */
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, opts);

const log = logger('rate-limit');

/**
 * Fixed-window counter in Redis. Every route gets the default limit; routes may
 * declare a stricter bucket. If Redis is unavailable the guard fails open for
 * the default bucket (availability) but fails closed for explicitly declared
 * sensitive buckets (auth/ai), so an outage cannot be used to bypass them.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: { id: string } }>();
    const declared = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    const opts: RateLimitOptions = declared ?? {
      bucket: 'default',
      max: this.config.env.RATE_LIMIT_DEFAULT_MAX,
      windowSeconds: this.config.env.RATE_LIMIT_WINDOW_SECONDS,
    };
    const subject = req.user?.id ? `u:${req.user.id}` : `ip:${req.ip ?? 'unknown'}`;
    const window = Math.floor(Date.now() / 1000 / opts.windowSeconds);
    const key = `rl:${opts.bucket}:${subject}:${window}`;
    try {
      const results = await this.redis.client.multi().incr(key).expire(key, opts.windowSeconds + 1).exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      if (count > opts.max) {
        const retryAfter = opts.windowSeconds - (Math.floor(Date.now() / 1000) % opts.windowSeconds);
        throw Errors.rateLimited(retryAfter);
      }
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'RATE_LIMITED') throw err;
      log.error({ err: (err as Error).message, bucket: opts.bucket }, 'rate limiter unavailable');
      if (declared) throw Errors.unavailable('RATE_LIMITER_UNAVAILABLE', 'Service temporarily unavailable.');
      return true;
    }
  }
}
