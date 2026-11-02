import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../config/config.js';
import { logger } from './logger.js';

const log = logger('redis');

/**
 * Redis is ephemeral infrastructure (queues, rate limits, pub/sub). It is never
 * the only copy of important state (DATABASE.md §1).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  private readonly subscribers = new Set<Redis>();

  constructor(private readonly config: AppConfig) {
    this.client = this.create('main');
  }

  /** Creates a dedicated connection (BullMQ and subscribers need their own). */
  create(name: string, opts: { maxRetriesPerRequest?: number | null } = {}): Redis {
    const client = new Redis(this.config.env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: opts.maxRetriesPerRequest === undefined ? 2 : opts.maxRetriesPerRequest,
      enableOfflineQueue: true,
      connectionName: `anvaya-${name}`,
    });
    client.on('error', (err: Error) => log.warn({ err: err.message, name }, 'redis connection error'));
    return client;
  }

  subscriber(): Redis {
    const sub = this.create('subscriber', { maxRetriesPerRequest: null });
    this.subscribers.add(sub);
    return sub;
  }

  releaseSubscriber(sub: Redis): void {
    this.subscribers.delete(sub);
    sub.disconnect();
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const s of this.subscribers) s.disconnect();
    this.subscribers.clear();
    await this.client.quit().catch(() => this.client.disconnect());
  }
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
