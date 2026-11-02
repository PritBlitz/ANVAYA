import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditController } from './audit/audit.controller.js';
import { AuditModule } from './audit/audit.service.js';
import { EnvelopeInterceptor, ErrorEnvelopeFilter } from './common/http.js';
import { IdempotencyInterceptor } from './common/idempotency.js';
import { RateLimitGuard } from './common/rate-limit.js';
import { RedisModule } from './common/redis.service.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { IntegrationsController } from './github/integrations.controller.js';
import { IntegrationsService } from './github/integrations.service.js';
import { WebhookProcessor } from './github/webhook.processor.js';
import { WebhooksController } from './github/webhooks.controller.js';
import { HealthController } from './health/health.controller.js';
import { MetricsController } from './health/metrics.controller.js';
import { IndexingController } from './indexing/indexing.controller.js';
import { IndexingModule } from './indexing/indexing.module.js';
import { AiClientModule } from './ai/ai-client.js';
import { AiController } from './ai/ai.controller.js';
import { AiModule } from './ai/ai.module.js';
import { RunsModule } from './runs/runs.module.js';
import { ReviewController } from './review/review.controller.js';
import { ReviewService } from './review/review.service.js';
import { RunsController, TasksController } from './runs/runs.controller.js';
import { KnowledgeController } from './knowledge/knowledge.controller.js';
import { StorageModule } from './storage/object-storage.js';
import { QueueModule } from './queue/queues.js';
import { RepositoriesController } from './repositories/repositories.controller.js';
import { RepositoriesService } from './repositories/repositories.service.js';
import { AuthController } from './identity/auth.controller.js';
import { AuthGuard } from './identity/auth.guard.js';
import { GithubOAuthService } from './identity/github-oauth.service.js';
import { MeController } from './identity/me.controller.js';
import { SessionService } from './identity/session.service.js';
import { UsersService } from './identity/users.service.js';
import { AccessModule } from './workspaces/access.service.js';
import { InvitationsController, WorkspacesController } from './workspaces/workspaces.controller.js';
import { WorkspacesService } from './workspaces/workspaces.service.js';

@Module({
  imports: [ConfigModule, DatabaseModule, RedisModule, QueueModule, AuditModule, AccessModule, StorageModule, AiClientModule, IndexingModule, AiModule, RunsModule],
  controllers: [
    HealthController,
    MetricsController,
    AuthController,
    MeController,
    WorkspacesController,
    InvitationsController,
    AuditController,
    IntegrationsController,
    WebhooksController,
    RepositoriesController,
    IndexingController,
    AiController,
    KnowledgeController,
    TasksController,
    RunsController,
    ReviewController,
  ],
  providers: [
    ReviewService,
    SessionService,
    UsersService,
    GithubOAuthService,
    WorkspacesService,
    IntegrationsService,
    WebhookProcessor,
    RepositoriesService,
    IdempotencyInterceptor,
    // Order matters: authenticate first so rate limits can key by user.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
  ],
})
export class AppModule {}
