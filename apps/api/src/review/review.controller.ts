import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { z } from 'zod';
import { Idempotent } from '../common/idempotency.js';
import { UuidParamPipe, ZodPipe } from '../common/http.js';
import { RateLimit } from '../common/rate-limit.js';
import { type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import { dispositionBody, prApprovalBody, pullRequestBody, ReviewService } from './review.service.js';

@Controller('runs/:runId')
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @Get('diff')
  diff(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string) {
    return this.review.diff(user.id, runId);
  }

  @Get('verification')
  verification(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string) {
    return this.review.verification(user.id, runId);
  }

  @Get('review')
  findings(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string) {
    return this.review.review(user.id, runId);
  }

  @Post('findings/:findingId/disposition')
  @HttpCode(200)
  disposition(
    @CurrentUser() user: AuthUser,
    @Param('runId', new UuidParamPipe('Run')) runId: string,
    @Param('findingId', new UuidParamPipe('Finding')) findingId: string,
    @Body(new ZodPipe(dispositionBody)) body: z.infer<typeof dispositionBody>,
  ) {
    return this.review.disposition(user.id, runId, findingId, body);
  }

  @Post('pr-approval')
  @HttpCode(200)
  @Idempotent()
  prApproval(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string, @Body(new ZodPipe(prApprovalBody)) body: z.infer<typeof prApprovalBody>) {
    return this.review.prApproval(user.id, runId, body);
  }

  /** External side effect: Idempotency-Key is mandatory (API_SPEC §6). */
  @Post('pull-request')
  @Idempotent({ required: true })
  @RateLimit({ bucket: 'pull-request', max: 10, windowSeconds: 3600 })
  createPullRequest(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string, @Body(new ZodPipe(pullRequestBody)) body: z.infer<typeof pullRequestBody>) {
    return this.review.createPullRequest(user.id, runId, body);
  }
}
