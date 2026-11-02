import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { Idempotent } from '../common/idempotency.js';
import { UuidParamPipe, ZodPipe } from '../common/http.js';
import { type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import { createRepositoryBody, listRepositoriesQuery, updateRepositoryBody } from './repositories.schemas.js';
import { RepositoriesService } from './repositories.service.js';

@Controller('repositories')
export class RepositoriesController {
  constructor(private readonly repositories: RepositoriesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(listRepositoriesQuery)) q: z.infer<typeof listRepositoriesQuery>) {
    return this.repositories.list(user.id, q.workspace_id, q.limit, q.cursor, q.status);
  }

  @Post()
  @Idempotent()
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(createRepositoryBody)) body: z.infer<typeof createRepositoryBody>) {
    return this.repositories.create(user.id, body);
  }

  @Get(':repositoryId')
  get(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) id: string) {
    return this.repositories.get(user.id, id);
  }

  @Patch(':repositoryId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('repositoryId', new UuidParamPipe('Repository')) id: string,
    @Body(new ZodPipe(updateRepositoryBody)) body: z.infer<typeof updateRepositoryBody>,
  ) {
    return this.repositories.update(user.id, id, body);
  }

  @Delete(':repositoryId')
  @HttpCode(204)
  async disconnect(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) id: string): Promise<void> {
    await this.repositories.disconnect(user.id, id);
  }
}
