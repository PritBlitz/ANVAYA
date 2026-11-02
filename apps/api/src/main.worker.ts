import { startTracing } from './telemetry/tracing.js';

// Tracing must start before the application modules load so they can be instrumented.
startTracing('anvaya-worker');

await import('reflect-metadata');
const { NestFactory } = await import('@nestjs/core');
const { createRootLogger } = await import('./common/logger.js');
const { AppConfig } = await import('./config/config.js');
const { WorkerModule } = await import('./worker/worker.module.js');
const { WorkerRunner } = await import('./worker/worker.runner.js');

const config = new AppConfig();
const log = createRootLogger(config.env.LOG_LEVEL, 'anvaya-worker');

try {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  app.enableShutdownHooks();
  app.get(WorkerRunner).start({ indexConcurrency: Number(process.env.WORKER_INDEX_CONCURRENCY ?? '1') });
  log.info({ config: config.describe() }, 'anvaya worker running');
} catch (err) {
  log.fatal({ err }, 'failed to start worker');
  process.exit(1);
}
