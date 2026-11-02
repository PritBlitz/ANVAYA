import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { type JobsOptions, Queue } from 'bullmq';
import { RedisService } from '../common/redis.service.js';

/** Queue names (ARCHITECTURE §10). */
export const QUEUES = {
  repositoryIndex: 'repository-index',
  engineeringRun: 'engineering-run',
  sandboxExecution: 'sandbox-execution',
  artifactCleanup: 'artifact-cleanup',
  webhookProcessing: 'webhook-processing',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Job payloads carry identifiers and tenant scope only — never content or
 * credentials. Workers re-load and re-validate the parent records (DATABASE §7).
 */
export interface IndexJobData {
  indexingJobId: string;
  organizationId: string;
  repositoryId: string;
}
export interface WebhookJobData {
  deliveryId: string;
}
export interface RunJobData {
  runId: string;
  organizationId: string;
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly redis: RedisService) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.redis.create(`queue-${name}`, { maxRetriesPerRequest: null }), defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueueIndex(data: IndexJobData): Promise<void> {
    // jobId = indexing job id → enqueuing the same durable job twice is a no-op.
    await this.queue(QUEUES.repositoryIndex).add('index', data, { jobId: data.indexingJobId, attempts: 2 });
  }

  async enqueueWebhook(data: WebhookJobData): Promise<void> {
    await this.queue(QUEUES.webhookProcessing).add('webhook', data, { jobId: `wh-${data.deliveryId}` });
  }

  async enqueueRun(data: RunJobData, opts: { delayMs?: number; dedupeKey?: string } = {}): Promise<void> {
    await this.queue(QUEUES.engineeringRun).add('advance', data, {
      ...(opts.dedupeKey ? { jobId: opts.dedupeKey } : {}),
      ...(opts.delayMs ? { delay: opts.delayMs } : {}),
      attempts: 3,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

@Global()
@Module({ providers: [QueueService], exports: [QueueService] })
export class QueueModule {}
