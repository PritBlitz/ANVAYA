import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { IndexingModule } from '../indexing/indexing.module.js';
import { ImpactService } from './impact.service.js';
import { WorkspaceKnowledgeService } from './workspace-knowledge.service.js';

@Module({
  imports: [AiModule, IndexingModule],
  providers: [ImpactService, WorkspaceKnowledgeService],
  exports: [ImpactService, WorkspaceKnowledgeService],
})
export class IntelligenceModule {}
