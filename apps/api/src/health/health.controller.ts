import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../identity/auth.decorators.js';
import { DatabaseService } from '../database/database.service.js';
import { RedisService } from '../common/redis.service.js';

/** Liveness and readiness. Readiness reports dependency state without leaking details. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: string; checks: Record<string, 'ok' | 'fail'> }> {
    const [db, redis] = await Promise.all([this.database.ping(), this.redis.ping()]);
    const checks = { database: db ? 'ok' : 'fail', redis: redis ? 'ok' : 'fail' } as const;
    const ok = db && redis;
    if (!ok) res.status(503);
    return { status: ok ? 'ready' : 'degraded', checks };
  }
}
