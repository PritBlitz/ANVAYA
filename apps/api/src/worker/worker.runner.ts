import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { type Job, Worker } from 'bullmq';
import { createServer, type Server } from 'node:http';
import { logger } from '../common/logger.js';
import { renderMetrics } from '../common/metrics.js';
import { AppConfig } from '../config/config.js';
import { RedisService } from '../common/redis.service.js';
import { requestContext } from '../common/request-context.js';
import { IndexerService } from '../indexing/indexer.service.js';
import { IndexingRecoveryService } from '../indexing/indexing-recovery.service.js';
import { type IndexJobData, QUEUES, type RunJobData } from '../queue/queues.js';
import { OrchestratorService } from '../runs/orchestrator.service.js';
import { RunsService } from '../runs/runs.service.js';
import { RetentionService } from './retention.service.js';

const log = logger('worker');

@Injectable()
export class WorkerRunner implements OnApplicationShutdown {
  private readonly workers: Worker[] = [];
  private sweepTimer?: NodeJS.Timeout;
  private retentionTimer?: NodeJS.Timeout;
  private metricsServer?: Server;

  constructor(
    private readonly redis: RedisService,
    private readonly indexer: IndexerService,
    private readonly recovery: IndexingRecoveryService,
    private readonly orchestrator: OrchestratorService,
    private readonly runs: RunsService,
    private readonly retention: RetentionService,
    private readonly config: AppConfig,
  ) {}

  start(opts: { indexConcurrency?: number; runConcurrency?: number; sweepIntervalMs?: number; retentionIntervalMs?: number } = {}): void {
    const indexWorker = new Worker<IndexJobData>(
      QUEUES.repositoryIndex,
      async (job: Job<IndexJobData>) =>
        requestContext.run({ requestId: `job_${job.id ?? 'unknown'}` }, () =>
          this.indexer.run(job.data.indexingJobId, { finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) }),
        ),
      {
        connection: this.redis.create('worker-index', { maxRetriesPerRequest: null }),
        // Indexing is CPU-heavy; default to one job per process and scale processes.
        concurrency: opts.indexConcurrency ?? 1,
        lockDuration: 120_000,
      },
    );
    indexWorker.on('failed', (job, err) => log.warn({ job_id: job?.id, err: err.message }, 'index job attempt failed'));
    this.workers.push(indexWorker);

    const runWorker = new Worker<RunJobData>(
      QUEUES.engineeringRun,
      async (job: Job<RunJobData>) => requestContext.run({ requestId: `job_${job.id ?? 'unknown'}` }, () => this.orchestrator.advance(job.data.runId)),
      {
        connection: this.redis.create('worker-run', { maxRetriesPerRequest: null }),
        // One model request at a time on constrained hardware (AI_WORKFLOW §8).
        concurrency: opts.runConcurrency ?? 1,
        lockDuration: 10 * 60_000,
      },
    );
    runWorker.on('failed', (job, err) => log.warn({ job_id: job?.id, err: err.message }, 'run job attempt failed'));
    this.workers.push(runWorker);

    const interval = opts.sweepIntervalMs ?? 60_000;
    this.sweepTimer = setInterval(() => {
      this.recovery.sweep().catch((err: unknown) => log.error({ err: (err as Error).message }, 'recovery sweep failed'));
      this.runs.recover().catch((err: unknown) => log.error({ err: (err as Error).message }, 'run recovery failed'));
    }, interval);
    this.sweepTimer.unref();
    this.retentionTimer = setInterval(() => {
      this.retention.sweep().catch((err: unknown) => log.error({ err: (err as Error).message }, 'retention sweep failed'));
    }, opts.retentionIntervalMs ?? 3600_000);
    this.retentionTimer.unref();
    if (this.config.env.WORKER_METRICS_PORT) {
      // Loopback only: scraped by a local collector/sidecar.
      this.metricsServer = createServer((req, res) => {
        if (req.url !== '/metrics') return void res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(renderMetrics());
      }).listen(this.config.env.WORKER_METRICS_PORT, '127.0.0.1');
    }
    log.info({ queues: [QUEUES.repositoryIndex, QUEUES.engineeringRun] }, 'worker started');
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.metricsServer?.close();
    // Graceful: wait for in-flight jobs; unfinished work is recovered from PostgreSQL.
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
