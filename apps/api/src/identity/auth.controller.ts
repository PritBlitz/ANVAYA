import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { constantTimeEqual } from '../common/crypto.js';
import { Errors } from '../common/errors.js';
import { RAW_RESPONSE, UuidParamPipe, ZodPipe } from '../common/http.js';
import { RateLimit } from '../common/rate-limit.js';
import { AppConfig } from '../config/config.js';
import { type AuthedRequest, type AuthSession, type AuthUser, CurrentSession, CurrentUser, Public } from './auth.decorators.js';
import { GithubOAuthService } from './github-oauth.service.js';
import { SessionService } from './session.service.js';
import { UsersService } from './users.service.js';

export const devLoginBody = z
  .object({
    email: z.email().max(320),
    display_name: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const callbackQuery = z.object({
  code: z.string().min(1).max(512).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(200).optional(),
});

export const loginQuery = z.object({ return_to: z.string().max(512).optional() });

const OAUTH_COOKIE = 'anvaya_oauth';
const DEFAULT_RETURN_TO = '/app';

/**
 * Post-login destination. Only same-origin relative paths are honoured (no
 * scheme, no `//host`, no backslashes or control characters), so `return_to`
 * can never become an open redirect. Anything else falls back to `/app`.
 */
export function safeReturnTo(raw: string | undefined, webOrigin: string): string {
  const hasControlOrBackslash = (s: string) => [...s].some((ch) => ch === '\\' || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || hasControlOrBackslash(raw)) return DEFAULT_RETURN_TO;
  try {
    const base = new URL(webOrigin);
    const resolved = new URL(raw, base);
    if (resolved.origin !== base.origin) return DEFAULT_RETURN_TO;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
    private readonly oauth: GithubOAuthService,
    private readonly audit: AuditService,
  ) {}

  /** Which sign-in methods this server offers (lets the UI render the right buttons). */
  @Public()
  @Get('providers')
  providers() {
    return {
      github: this.oauth.configured,
      dev: this.config.env.AUTH_DEV_LOGIN_ENABLED && !this.config.isProduction,
    };
  }

  /**
   * Development-only sign-in. Disabled unless AUTH_DEV_LOGIN_ENABLED=true, and
   * config validation refuses to boot with it enabled in production.
   */
  @Public()
  @Post('dev-login')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth', max: 20, windowSeconds: 60 })
  async devLogin(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response, @Body(new ZodPipe(devLoginBody)) body: z.infer<typeof devLoginBody>) {
    if (!this.config.env.AUTH_DEV_LOGIN_ENABLED || this.config.isProduction) throw Errors.notFound('Route');
    // JSON-only: a cross-site HTML form cannot produce this content type without a CORS preflight.
    if (!req.is('application/json')) throw Errors.badRequest('Content-Type must be application/json.');
    const user = await this.users.upsertFromIdentity({ subject: `dev:${body.email.toLowerCase()}`, email: body.email, displayName: body.display_name ?? null });
    const issued = await this.sessions.create(user.id, { ip: req.ip, userAgent: req.header('user-agent') });
    this.sessions.setCookies(res, issued);
    await this.audit.record({ organizationId: null, actorUserId: user.id, action: 'auth.login', resourceType: 'session', resourceId: issued.sessionId, metadata: { method: 'dev' } });
    return { user: { id: user.id, email: user.email, display_name: user.display_name }, csrf_token: issued.csrfToken, expires_at: issued.expiresAt.toISOString() };
  }

  @Public()
  @Get('github/login')
  @RateLimit({ bucket: 'auth', max: 20, windowSeconds: 60 })
  githubLogin(@Res() res: Response, @Query(new ZodPipe(loginQuery)) q: z.infer<typeof loginQuery>): symbol {
    const start = this.oauth.start();
    // The destination rides in the same short-lived HttpOnly cookie as the PKCE verifier and is re-validated on return.
    const returnTo = Buffer.from(safeReturnTo(q.return_to, this.config.env.WEB_APP_URL)).toString('base64url');
    res.cookie(OAUTH_COOKIE, `${start.state}.${start.verifier}.${returnTo}`, {
      httpOnly: true,
      secure: this.config.env.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/api/v1/auth/github',
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(302, start.url);
    return RAW_RESPONSE;
  }

  @Public()
  @Get('github/callback')
  @RateLimit({ bucket: 'auth', max: 20, windowSeconds: 60 })
  async githubCallback(@Req() req: AuthedRequest, @Res() res: Response, @Query(new ZodPipe(callbackQuery)) q: z.infer<typeof callbackQuery>): Promise<symbol> {
    const web = this.config.env.WEB_APP_URL;
    const cookies = (req.cookies ?? {}) as Record<string, unknown>;
    const stored = cookies[OAUTH_COOKIE];
    const raw = typeof stored === 'string' ? stored : '';
    res.clearCookie(OAUTH_COOKIE, { path: '/api/v1/auth/github' });
    const [state, verifier, encodedReturnTo] = raw.split('.');
    const returnTo = safeReturnTo(encodedReturnTo ? Buffer.from(encodedReturnTo, 'base64url').toString('utf8') : undefined, web);
    if (q.error || !q.code || !q.state || !state || !verifier || !constantTimeEqual(state, q.state)) {
      res.redirect(302, `${web}/login?error=oauth_failed`);
      return RAW_RESPONSE;
    }
    try {
      const identity = await this.oauth.exchange(q.code, verifier);
      const user = await this.users.upsertFromIdentity(identity);
      const issued = await this.sessions.create(user.id, { ip: req.ip, userAgent: req.header('user-agent') });
      this.sessions.setCookies(res, issued);
      await this.audit.record({ organizationId: null, actorUserId: user.id, action: 'auth.login', resourceType: 'session', resourceId: issued.sessionId, metadata: { method: 'github' } });
      res.redirect(302, `${new URL(web).origin}${returnTo}`);
    } catch (err) {
      const code = (err as { code?: string }).code === 'EMAIL_IN_USE' ? 'email_in_use' : 'oauth_failed';
      res.redirect(302, `${web}/login?error=${code}`);
    }
    return RAW_RESPONSE;
  }

  /** Returns (and re-issues as a cookie) a fresh CSRF token for the current session. */
  @Get('csrf')
  async csrf(@CurrentSession() session: AuthSession, @Res({ passthrough: true }) res: Response) {
    const token = await this.sessions.rotateCsrf(session.id);
    this.sessions.setCsrfCookie(res, token);
    return { csrf_token: token };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser, @CurrentSession() session: AuthSession, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.sessions.revoke(user.id, session.id);
    this.sessions.clearCookies(res);
    await this.audit.record({ organizationId: null, actorUserId: user.id, action: 'auth.logout', resourceType: 'session', resourceId: session.id });
  }

  @Get('sessions')
  async listSessions(@CurrentUser() user: AuthUser, @CurrentSession() current: AuthSession) {
    const rows = await this.sessions.list(user.id);
    return rows.map((s) => ({
      id: s.id,
      current: s.id === current.id,
      ip_address: s.ip_address,
      user_agent: s.user_agent,
      created_at: s.created_at.toISOString(),
      last_seen_at: s.last_seen_at.toISOString(),
      expires_at: s.expires_at.toISOString(),
    }));
  }

  /** Revoke one of the caller's sessions (FR-ID-007). */
  @Delete('sessions/:sessionId')
  @HttpCode(204)
  async revokeSession(@CurrentUser() user: AuthUser, @Param('sessionId', new UuidParamPipe('Session')) sessionId: string): Promise<void> {
    if (!(await this.sessions.revoke(user.id, sessionId))) throw Errors.notFound('Session');
    await this.audit.record({ organizationId: null, actorUserId: user.id, action: 'auth.session_revoked', resourceType: 'session', resourceId: sessionId });
  }
}
