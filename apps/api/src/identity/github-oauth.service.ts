import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { randomToken } from '../common/crypto.js';
import { Errors } from '../common/errors.js';
import { logger } from '../common/logger.js';
import { AppConfig } from '../config/config.js';
import type { ExternalIdentity } from './users.service.js';

const tokenResponse = z.object({ access_token: z.string().min(1) }).or(z.object({ error: z.string(), error_description: z.string().optional() }));
const githubUser = z.object({ id: z.number().int(), login: z.string(), name: z.string().nullable().optional(), avatar_url: z.string().nullable().optional() });
const githubEmails = z.array(z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }));

const log = logger('github-oauth');

export interface OAuthStart {
  url: string;
  state: string;
  verifier: string;
}

/**
 * GitHub user sign-in (OAuth web flow with state + PKCE). The user access token
 * is used only to read the profile and verified primary email, then discarded.
 */
@Injectable()
export class GithubOAuthService {
  constructor(private readonly config: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.config.env.GITHUB_CLIENT_ID && this.config.env.GITHUB_CLIENT_SECRET);
  }

  get redirectUri(): string {
    return `${this.config.env.PUBLIC_API_URL}/api/v1/auth/github/callback`;
  }

  start(): OAuthStart {
    if (!this.configured) throw Errors.notConfigured('GitHub sign-in');
    const state = randomToken(24);
    const verifier = randomToken(48);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL('/login/oauth/authorize', this.config.env.GITHUB_WEB_URL);
    url.searchParams.set('client_id', this.config.env.GITHUB_CLIENT_ID!);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('allow_signup', 'true');
    return { url: url.toString(), state, verifier };
  }

  async exchange(code: string, verifier: string): Promise<ExternalIdentity> {
    if (!this.configured) throw Errors.notConfigured('GitHub sign-in');
    const tokenRes = await this.request(new URL('/login/oauth/access_token', this.config.env.GITHUB_WEB_URL), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.env.GITHUB_CLIENT_ID,
        client_secret: this.config.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: this.redirectUri,
        code_verifier: verifier,
      }),
    });
    const token = tokenResponse.safeParse(await tokenRes.json());
    if (!token.success || !('access_token' in token.data)) {
      log.warn({ error: token.success ? (token.data as { error: string }).error : 'malformed' }, 'oauth code exchange rejected');
      throw Errors.unauthenticated('GitHub sign-in failed.');
    }
    const auth = { Authorization: `Bearer ${token.data.access_token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const [userRes, emailsRes] = await Promise.all([
      this.request(new URL('/user', this.config.env.GITHUB_API_URL), { headers: auth }),
      this.request(new URL('/user/emails', this.config.env.GITHUB_API_URL), { headers: auth }),
    ]);
    const user = githubUser.safeParse(await userRes.json());
    const emails = githubEmails.safeParse(await emailsRes.json());
    if (!user.success || !emails.success) throw Errors.upstream('GITHUB_BAD_RESPONSE', 'Unexpected response from GitHub.');
    const primary = emails.data.find((e) => e.primary && e.verified);
    if (!primary) throw Errors.forbidden('Your GitHub account needs a verified primary email address.');
    return {
      subject: `github:${user.data.id}`,
      email: primary.email,
      displayName: user.data.name ?? user.data.login,
      avatarUrl: user.data.avatar_url ?? null,
    };
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: 'error' });
    } catch (err) {
      log.warn({ err: (err as Error).message, host: url.host }, 'github request failed');
      throw Errors.upstream('GITHUB_UNAVAILABLE', 'GitHub could not be reached.');
    }
    if (!res.ok) throw Errors.upstream('GITHUB_ERROR', `GitHub responded with status ${res.status}.`);
    return res;
  }
}
