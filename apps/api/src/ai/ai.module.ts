import { Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module.js';
import { KnowledgeIndexService } from '../knowledge/knowledge-index.service.js';
import { AiPolicyService } from './ai-policy.service.js';
import { QuestionsService } from './questions.service.js';
import { UsageService } from './usage.service.js';

@Module({
  imports: [IndexingModule],
  providers: [AiPolicyService, UsageService, QuestionsService, KnowledgeIndexService],
  exports: [AiPolicyService, UsageService, QuestionsService, KnowledgeIndexService],
})
export class AiModule {}
