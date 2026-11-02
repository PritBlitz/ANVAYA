import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createRootLogger } from './common/logger.js';
import { AppConfig } from './config/config.js';
import { WorkerModule } from './worker/worker.module.js';
import { WorkerRunner } from './worker/worker.runner.js';

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
