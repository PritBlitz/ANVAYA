import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { Errors } from '../common/errors.js';

export const IS_PUBLIC = 'anvaya:public';
export const SKIP_CSRF = 'anvaya:skip-csrf';

/** Route does not require an authenticated session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route is exempt from CSRF (only for non-cookie-authenticated endpoints, e.g. signed webhooks). */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface AuthSession {
  id: string;
}

export type AuthedRequest = Request & { user?: AuthUser; session?: AuthSession; requestId?: string };

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw Errors.unauthenticated();
  return req.user;
});

export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthSession => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.session) throw Errors.unauthenticated();
  return req.session;
});
