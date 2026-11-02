import { Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module.js';
import { AiPolicyService } from './ai-policy.service.js';
import { QuestionsService } from './questions.service.js';
import { UsageService } from './usage.service.js';

@Module({
  imports: [IndexingModule],
  providers: [AiPolicyService, UsageService, QuestionsService],
  exports: [AiPolicyService, UsageService, QuestionsService],
})
export class AiModule {}
