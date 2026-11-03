import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AppConfig } from '../config/config.js';
import { ExecutionPipeline } from '../execution/execution-pipeline.js';
import { GvisorSandboxDriver } from '../execution/gvisor-sandbox.js';
import { DockerSandboxDriver, SandboxDriver } from '../execution/sandbox.js';
import { WorkspaceManager } from '../execution/workspace.js';
import { IndexingModule } from '../indexing/indexing.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { ExecutionStages, OrchestratorService, UnavailableExecutionStages } from './orchestrator.service.js';
import { RunEventsService } from './run-events.service.js';
import { RunTransitionsService } from './run-transitions.service.js';
import { RunsService } from './runs.service.js';
import { StageToolkit } from './stage-toolkit.js';
import { TasksService } from './tasks.service.js';
import { TemplatesService } from '../templates/templates.service.js';

@Module({
  imports: [AiModule, IndexingModule, IntelligenceModule],
  providers: [
    RunEventsService,
    RunTransitionsService,
    RunsService,
    TasksService,
    TemplatesService,
    StageToolkit,
    OrchestratorService,
    WorkspaceManager,
    {
      provide: SandboxDriver,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => (config.env.EXECUTION_DRIVER === 'gvisor' ? new GvisorSandboxDriver(config) : new DockerSandboxDriver(config)),
    },
    ExecutionPipeline,
    UnavailableExecutionStages,
    {
      provide: ExecutionStages,
      inject: [AppConfig, ExecutionPipeline, UnavailableExecutionStages],
      useFactory: (config: AppConfig, pipeline: ExecutionPipeline, unavailable: UnavailableExecutionStages) => (config.env.EXECUTION_DRIVER === 'disabled' ? unavailable : pipeline),
    },
  ],
  exports: [RunEventsService, RunTransitionsService, RunsService, TasksService, TemplatesService, StageToolkit, OrchestratorService, SandboxDriver, WorkspaceManager],
})
export class RunsModule {}
