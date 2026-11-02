import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { sql } from 'kysely';
import { randomToken, sha256Hex } from '../common/crypto.js';
import { AppConfig } from '../config/config.js';
import { DatabaseService } from '../database/database.service.js';
import type { AuthUser } from './auth.decorators.js';

export interface IssuedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface ResolvedSession {
  sessionId: string;
  csrfTokenHash: string;
  user: AuthUser;
}

const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

/**
 * Server-side sessions. The browser holds an opaque random token in an HttpOnly
 * cookie; only its SHA-256 hash is stored. Each login creates a new session
 * (rotation). CSRF tokens are bound to the session (hash stored server-side).
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfig,
  ) {}

  async create(userId: string, meta: { ip?: string; userAgent?: string }): Promise<IssuedSession> {
    const token = randomToken(32);
    const csrfToken = randomToken(32);
    const expiresAt = new Date(Date.now() + this.config.env.SESSION_TTL_HOURS * 3600 * 1000);
    const row = await this.database.db
      .insertInto('sessions')
      .values({
        user_id: userId,
        token_hash: sha256Hex(token),
        csrf_token_hash: sha256Hex(csrfToken),
        ip_address: meta.ip ?? null,
        user_agent: meta.userAgent?.slice(0, 512) ?? null,
        expires_at: expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { sessionId: row.id, token, csrfToken, expiresAt };
  }

  async resolve(token: string): Promise<ResolvedSession | null> {
    if (token.length < 20 || token.length > 128) return null;
    const row = await this.database.db
      .selectFrom('sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select(['s.id as session_id', 's.csrf_token_hash', 's.last_seen_at', 'u.id as user_id', 'u.email', 'u.display_name'])
      .where('s.token_hash', '=', sha256Hex(token))
      .where('s.revoked_at', 'is', null)
      .where('s.expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    if (!row) return null;
    if (Date.now() - row.last_seen_at.getTime() > LAST_SEEN_REFRESH_MS) {
      await this.database.db.updateTable('sessions').set({ last_seen_at: sql`now()` }).where('id', '=', row.session_id).execute();
    }
    return {
      sessionId: row.session_id,
      csrfTokenHash: row.csrf_token_hash,
      user: { id: row.user_id, email: row.email, displayName: row.display_name },
    };
  }

  /** Issues a fresh CSRF token for an existing session (e.g. after the cookie was cleared). */
  async rotateCsrf(sessionId: string): Promise<string> {
    const csrfToken = randomToken(32);
    await this.database.db.updateTable('sessions').set({ csrf_token_hash: sha256Hex(csrfToken) }).where('id', '=', sessionId).execute();
    return csrfToken;
  }

  async list(userId: string) {
    return this.database.db
      .selectFrom('sessions')
      .select(['id', 'ip_address', 'user_agent', 'created_at', 'last_seen_at', 'expires_at'])
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
  }

  /** Revokes a session owned by `userId`. Returns false if not found (concealed). */
  async revoke(userId: string, sessionId: string): Promise<boolean> {
    const res = await this.database.db
      .updateTable('sessions')
      .set({ revoked_at: sql`now()` })
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  setCookies(res: Response, issued: Pick<IssuedSession, 'token' | 'csrfToken' | 'expiresAt'>): void {
    const { SESSION_COOKIE_NAME, COOKIE_SECURE } = this.config.env;
    res.cookie(SESSION_COOKIE_NAME, issued.token, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      expires: issued.expiresAt,
    });
    this.setCsrfCookie(res, issued.csrfToken, issued.expiresAt);
  }

  setCsrfCookie(res: Response, csrfToken: string, expiresAt?: Date): void {
    const { CSRF_COOKIE_NAME, COOKIE_SECURE } = this.config.env;
    // Readable by the web app so it can echo it in the X-CSRF-Token header.
    res.cookie(CSRF_COOKIE_NAME, csrfToken, {
      httpOnly: false,
      secure: COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      ...(expiresAt ? { expires: expiresAt } : {}),
    });
  }

  clearCookies(res: Response): void {
    const { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, COOKIE_SECURE } = this.config.env;
    res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/' });
    res.clearCookie(CSRF_COOKIE_NAME, { httpOnly: false, secure: COOKIE_SECURE, sameSite: 'lax', path: '/' });
  }
}
