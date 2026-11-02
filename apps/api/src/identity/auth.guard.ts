import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { constantTimeEqual, sha256Hex } from '../common/crypto.js';
import { Errors } from '../common/errors.js';
import { requestContext } from '../common/request-context.js';
import { AppConfig } from '../config/config.js';
import { type AuthedRequest, IS_PUBLIC, SKIP_CSRF } from './auth.decorators.js';
import { SessionService } from './session.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global authentication + CSRF guard. Resolves the session cookie on every
 * request (so public routes still see the user when present). Unsafe methods
 * from cookie-authenticated callers must present a session-bound CSRF token.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) ?? false;
    const skipCsrf = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, targets) ?? false;

    const cookies = (req.cookies ?? {}) as Record<string, unknown>;
    const token = cookies[this.config.env.SESSION_COOKIE_NAME];
    if (typeof token === 'string' && token.length > 0) {
      const resolved = await this.sessions.resolve(token);
      if (resolved) {
        req.user = resolved.user;
        req.session = { id: resolved.sessionId };
        const ctx = requestContext.get();
        if (ctx) ctx.userId = resolved.user.id;
        if (!SAFE_METHODS.has(req.method) && !skipCsrf) {
          const header = req.header('x-csrf-token');
          if (!header || !constantTimeEqual(sha256Hex(header), resolved.csrfTokenHash)) throw Errors.csrf();
        }
      }
    }

    if (!isPublic && !req.user) throw Errors.unauthenticated();
    return true;
  }
}
