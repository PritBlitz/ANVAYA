import { Module } from '@nestjs/common';
import { AiClientModule } from '../ai/ai-client.js';
import { AuditModule } from '../audit/audit.service.js';
import { RedisModule } from '../common/redis.service.js';
import { ConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IndexingModule } from '../indexing/indexing.module.js';
import { AccessModule } from '../workspaces/access.service.js';
import { RunsModule } from '../runs/runs.module.js';
import { QueueModule } from '../queue/queues.js';
import { StorageModule } from '../storage/object-storage.js';
import { RetentionService } from './retention.service.js';
import { WorkerRunner } from './worker.runner.js';

/** Background worker process: same codebase as the API, no HTTP surface. */
@Module({
  imports: [ConfigModule, DatabaseModule, RedisModule, QueueModule, AuditModule, AiClientModule, StorageModule, IndexingModule, AccessModule, RunsModule],
  providers: [WorkerRunner, RetentionService],
})
export class WorkerModule {}
