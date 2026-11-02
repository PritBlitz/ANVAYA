import { Module } from '@nestjs/common';
import { AppConfig } from '../config/config.js';
import { GithubAppService } from '../github/github-app.service.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import { IndexerService } from './indexer.service.js';
import { IndexingRecoveryService } from './indexing-recovery.service.js';
import { IndexingRequestsService } from './indexing-requests.service.js';
import { ParserService } from './parser.service.js';
import { GithubRepositorySource, LocalFixtureSource, RepositorySource } from './sources.js';

@Module({
  providers: [
    GithubAppService,
    ParserService,
    IndexerService,
    IndexingRequestsService,
    IndexingRecoveryService,
    RetrievalService,
    {
      provide: RepositorySource,
      inject: [AppConfig, GithubAppService],
      useFactory: (config: AppConfig, github: GithubAppService) =>
        config.env.REPOSITORY_SOURCE === 'local_fixture' ? new LocalFixtureSource(config) : new GithubRepositorySource(github),
    },
  ],
  exports: [GithubAppService, ParserService, IndexerService, IndexingRequestsService, IndexingRecoveryService, RetrievalService, RepositorySource],
})
export class IndexingModule {}
