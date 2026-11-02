import { createHmac } from 'node:crypto';
import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { sql } from 'kysely';
import type { RawBodyRequest } from '../bootstrap.js';
import { constantTimeEqual, sha256Hex } from '../common/crypto.js';
import { Errors } from '../common/errors.js';
import { logger } from '../common/logger.js';
import { RateLimit } from '../common/rate-limit.js';
import { AppConfig } from '../config/config.js';
import { DatabaseService } from '../database/database.service.js';
import { Public, SkipCsrf } from '../identity/auth.decorators.js';
import { WebhookProcessor } from './webhook.processor.js';

const log = logger('webhooks');
const DELIVERY_RE = /^[A-Za-z0-9-]{1,100}$/;
const EVENT_RE = /^[a-z_]{1,64}$/;
/** Window in which an identical payload is treated as a replay. */
const REPLAY_WINDOW_DAYS = 7;

export function signPayload(secret: string, body: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * GitHub webhook receiver (FR-GIT-004, SECURITY §6).
 * 1. HMAC-SHA256 over the exact raw body, constant-time comparison.
 * 2. Replay protection: delivery id is a primary key; identical payloads within
 *    the replay window are rejected even under a new delivery id.
 * 3. The delivery is persisted, then processed asynchronously by a worker.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly processor: WebhookProcessor,
  ) {}

  @Public()
  @SkipCsrf()
  @Post('github')
  @HttpCode(202)
  @RateLimit({ bucket: 'webhook', max: 600, windowSeconds: 60 })
  async github(@Req() req: RawBodyRequest) {
    const secret = this.config.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) throw Errors.notConfigured('GitHub webhooks');
    const body = req.rawBody;
    const signature = req.header('x-hub-signature-256') ?? '';
    if (!body || !signature || !constantTimeEqual(signature, signPayload(secret, body))) {
      log.warn({ delivery: req.header('x-github-delivery') }, 'webhook signature verification failed');
      throw Errors.unauthenticated('Invalid webhook signature.');
    }
    const deliveryId = req.header('x-github-delivery') ?? '';
    const event = req.header('x-github-event') ?? '';
    if (!DELIVERY_RE.test(deliveryId) || !EVENT_RE.test(event)) throw Errors.badRequest('Missing or malformed GitHub delivery headers.');

    let payload: { action?: unknown; installation?: { id?: unknown } };
    try {
      payload = JSON.parse(body.toString('utf8')) as typeof payload;
    } catch {
      throw Errors.badRequest('Webhook payload is not valid JSON.');
    }
    const payloadHash = sha256Hex(body);
    const replay = await this.database.db
      .selectFrom('webhook_deliveries')
      .select('delivery_id')
      .where('payload_hash', '=', payloadHash)
      .where('received_at', '>', sql<Date>`now() - ${`${REPLAY_WINDOW_DAYS} days`}::interval`)
      .executeTakeFirst();
    if (replay) {
      log.warn({ delivery: deliveryId, original: replay.delivery_id }, 'webhook payload replay rejected');
      return { status: 'duplicate' };
    }

    // Record the delivery and apply its (cheap, DB-only) effects atomically. If
    // processing fails the delivery row rolls back, so a GitHub redelivery is
    // not mistaken for a duplicate. Heavy work is dispatched via durable
    // indexing_jobs rows, enqueued after commit.
    const outcome = await this.database.transaction(async (tx) => {
      const inserted = await tx
        .insertInto('webhook_deliveries')
        .values({
          delivery_id: deliveryId,
          event,
          action: typeof payload.action === 'string' ? payload.action.slice(0, 64) : null,
          external_installation_id: typeof payload.installation?.id === 'number' ? payload.installation.id : null,
          payload_hash: payloadHash,
        })
        .onConflict((oc) => oc.column('delivery_id').doNothing())
        .returning('delivery_id')
        .executeTakeFirst();
      if (!inserted) return null;
      const result = await this.processor.process(tx, event, payload);
      await tx
        .updateTable('webhook_deliveries')
        .set({ status: result.handled ? 'processed' : 'ignored', processed_at: sql`now()` })
        .where('delivery_id', '=', deliveryId)
        .execute();
      return result;
    });
    if (!outcome) return { status: 'duplicate' };
    await this.processor.afterCommit(outcome);
    return { status: outcome.handled ? 'processed' : 'ignored' };
  }
}
