import { Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module.js';
import { KnowledgeIndexService } from '../knowledge/knowledge-index.service.js';
import { AiPolicyService } from './ai-policy.service.js';
import { QuestionsService } from './questions.service.js';
import { QuotaService } from './quota.service.js';
import { UsageService } from './usage.service.js';

@Module({
  imports: [IndexingModule],
  providers: [AiPolicyService, UsageService, QuotaService, QuestionsService, KnowledgeIndexService],
  exports: [AiPolicyService, UsageService, QuotaService, QuestionsService, KnowledgeIndexService],
})
export class AiModule {}
