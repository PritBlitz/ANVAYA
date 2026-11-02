import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Errors } from '../common/errors.js';
import { Idempotent } from '../common/idempotency.js';
import { paginationQuery, RAW_RESPONSE, UuidParamPipe, ZodPipe } from '../common/http.js';
import { logger } from '../common/logger.js';
import { RateLimit } from '../common/rate-limit.js';
import { RedisService } from '../common/redis.service.js';
import { type AuthedRequest, type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import { AccessService } from '../workspaces/access.service.js';
import { channel, RunEventsService } from './run-events.service.js';
import { createTaskBody, editPlanBody, listTasksQuery, planApprovalBody, startRunBody, updateTaskBody } from './run.schemas.js';
import { RunsService } from './runs.service.js';
import { isTerminal } from './state-machine.js';
import { TasksService } from './tasks.service.js';

const log = logger('sse');
export const cancelBody = z.object({ reason: z.string().max(500).optional() }).strict();
export const sseQuery = z.object({ last_event_id: z.coerce.number().int().min(0).optional() });
const HEARTBEAT_MS = 15_000;
const POLL_MS = 5_000;
const MAX_STREAM_MS = 30 * 60 * 1000;
const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled']);

@Controller()
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post('repositories/:repositoryId/tasks')
  @Idempotent()
  @RateLimit({ bucket: 'task-create', max: 60, windowSeconds: 3600 })
  create(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) repositoryId: string, @Body(new ZodPipe(createTaskBody)) body: z.infer<typeof createTaskBody>) {
    return this.tasks.create(user.id, repositoryId, body);
  }

  @Get('tasks')
  list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(listTasksQuery)) q: z.infer<typeof listTasksQuery>) {
    return this.tasks.list(user.id, q);
  }

  @Get('tasks/:taskId')
  get(@CurrentUser() user: AuthUser, @Param('taskId', new UuidParamPipe('Task')) taskId: string) {
    return this.tasks.get(user.id, taskId);
  }

  @Patch('tasks/:taskId')
  update(@CurrentUser() user: AuthUser, @Param('taskId', new UuidParamPipe('Task')) taskId: string, @Body(new ZodPipe(updateTaskBody)) body: z.infer<typeof updateTaskBody>) {
    return this.tasks.update(user.id, taskId, body);
  }
}

@Controller()
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly access: AccessService,
    private readonly events: RunEventsService,
    private readonly redis: RedisService,
  ) {}

  @Post('tasks/:taskId/runs')
  @HttpCode(202)
  @Idempotent()
  @RateLimit({ bucket: 'run-start', max: 30, windowSeconds: 3600 })
  start(@CurrentUser() user: AuthUser, @Param('taskId', new UuidParamPipe('Task')) taskId: string, @Body(new ZodPipe(startRunBody)) body: z.infer<typeof startRunBody>) {
    return this.runs.start(user.id, taskId, body);
  }

  @Get('tasks/:taskId/runs')
  list(@CurrentUser() user: AuthUser, @Param('taskId', new UuidParamPipe('Task')) taskId: string, @Query(new ZodPipe(paginationQuery)) q: z.infer<typeof paginationQuery>) {
    return this.runs.listForTask(user.id, taskId, q.limit, q.cursor);
  }

  @Get('runs/:runId')
  get(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string) {
    return this.runs.get(user.id, runId);
  }

  @Post('runs/:runId/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string, @Body(new ZodPipe(cancelBody)) body: z.infer<typeof cancelBody>) {
    return this.runs.cancel(user.id, runId, body.reason);
  }

  @Post('runs/:runId/retry')
  @HttpCode(202)
  @Idempotent()
  retry(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string) {
    return this.runs.retry(user.id, runId);
  }

  @Get('runs/:runId/steps')
  steps(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string) {
    return this.runs.steps(user.id, runId);
  }

  @Get('runs/:runId/artifacts')
  artifacts(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string) {
    return this.runs.artifacts(user.id, runId);
  }

  @Get('runs/:runId/plan')
  plan(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string) {
    return this.runs.getPlan(user.id, runId);
  }

  @Patch('runs/:runId/plan')
  editPlan(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string, @Body(new ZodPipe(editPlanBody)) body: z.infer<typeof editPlanBody>) {
    return this.runs.editPlan(user.id, runId, body);
  }

  @Post('runs/:runId/plan-approval')
  @HttpCode(200)
  @Idempotent()
  approvePlan(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string, @Body(new ZodPipe(planApprovalBody)) body: z.infer<typeof planApprovalBody>) {
    return this.runs.decidePlan(user.id, runId, body);
  }

  /**
   * SSE run event stream (API_SPEC §8). Replays from `Last-Event-ID` (or
   * `?last_event_id=`) out of PostgreSQL, then streams new events. Redis is
   * only a wake-up signal; a poll covers missed notifications.
   */
  @Get('runs/:runId/events')
  async stream(
    @CurrentUser() user: AuthUser,
    @Param('runId', new UuidParamPipe('Run')) runId: string,
    @Query(new ZodPipe(sseQuery)) q: z.infer<typeof sseQuery>,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<symbol> {
    const { run } = await this.access.requireRun(user.id, runId);
    const header = req.header('last-event-id');
    const fromHeader = header && /^\d{1,18}$/.test(header) ? Number(header) : undefined;
    let lastId = fromHeader ?? q.last_event_id ?? 0;
    if (!Number.isSafeInteger(lastId)) throw Errors.badRequest('Invalid Last-Event-ID.');

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    let closed = false;
    let draining = Promise.resolve();
    const sub = this.redis.subscriber();
    const timers: NodeJS.Timeout[] = [];
    const close = () => {
      if (closed) return;
      closed = true;
      timers.forEach((t) => clearInterval(t));
      this.redis.releaseSubscriber(sub);
      res.end();
    };

    const drain = async (): Promise<void> => {
      for (;;) {
        if (closed) return;
        const batch = await this.events.since(runId, lastId);
        for (const e of batch) {
          res.write(`id: ${e.id}\nevent: ${e.event_type}\ndata: ${JSON.stringify(e.payload)}\n\n`);
          lastId = e.id;
          if (TERMINAL_EVENTS.has(e.event_type)) {
            close();
            return;
          }
        }
        if (batch.length < 200) return;
      }
    };
    const schedule = () => {
      draining = draining.then(drain).catch((err: unknown) => {
        log.warn({ run_id: runId, err: (err as Error).message }, 'sse drain failed');
        close();
      });
    };

    req.on('close', close);
    sub.on('message', schedule);
    await sub.subscribe(channel(runId)).catch(() => undefined);
    timers.push(setInterval(() => !closed && res.write(': heartbeat\n\n'), HEARTBEAT_MS));
    timers.push(setInterval(schedule, POLL_MS));
    timers.push(setTimeout(close, MAX_STREAM_MS));
    schedule();
    await draining;
    // A run that is already finished with nothing left to send ends the stream.
    if (!closed && isTerminal(run.status) && (await this.events.since(runId, lastId, 1)).length === 0) close();
    return RAW_RESPONSE;
  }
}
